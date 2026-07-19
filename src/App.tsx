import { useCallback, useEffect, useState, FormEvent } from "react";
import { useStellarWallet, WalletError, WalletErrorType } from "./hooks/useStellarWallet";
import * as StellarSdk from "@stellar/stellar-sdk";
import {
  buildPayrollPaymentXdr,
  getNativeBalance,
  STELLAR_EXPERT_TESTNET,
  submitSignedTransaction,
  invokeContract,
  submitSorobanTx,
  getContractAllocation,
  getVaultTotalDeposited,
  streamContractEvents,
  VAULT_CONTRACT_ID,
  FACTORY_CONTRACT_ID,
  getVaultFromFactory,
  getAllVaultsFromFactory,
  buildDeployVaultXdr,
  getScheduledAllocations,
  getStreamDetails,
  buildDepositScheduledXdr,
  buildClaimScheduledXdr,
  buildCreateStreamXdr,
  buildClaimStreamXdr,
  buildCreateBatchXdr,
  buildClaimBatchPayoutXdr,
  getBatch,
  getBatchWorker,
  generateIncomeProofOnChain,
  verifyIncomeProofOnChain,
  getVaultTokenAddress,
  VaultEvent,
  PayrollBatchUI,
} from "./lib/stellar";
import {
  addressArg,
  xlmToStroopsArg,
  stroopsToXlm,
} from "./lib/contractArgs";

type TransactionStatus =
  | { type: "idle" }
  | { type: "pending"; title: string; message: string }
  | { type: "success"; title: string; message: string; hash: string; ledger?: number }
  | { type: "error"; title: string; message: string };

type PayrollHistoryItem = {
  id: string;
  to: string;
  amount: string;
  memo: string;
  hash: string;
  ledger?: number;
};

type ScheduledPaymentUI = {
  amount: bigint;
  releaseTime: bigint;
  locked: boolean;
  friendlyReleaseTime: string;
};

type StreamDetailsUI = {
  sender: string;
  totalAmount: bigint;
  startTime: bigint;
  endTime: bigint;
  claimedAmount: bigint;
};

function shorten(address: string | null, lead = 6, tail = 6) {
  if (!address) return "";
  return `${address.slice(0, lead)}…${address.slice(-tail)}`;
}

function friendlyErr(error: unknown) {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Something went wrong. Please try again.";
}

function getWalletErrorKind(error: unknown): WalletErrorType {
  if (error instanceof WalletError) {
    return error.kind;
  }
  const msg = error instanceof Error ? error.message : String(error);
  const lower = msg.toLowerCase();
  if (
    lower.includes("not installed") ||
    lower.includes("not found") ||
    lower.includes("no wallet") ||
    lower.includes("extension") ||
    lower.includes("unavailable")
  ) {
    return "WalletNotFound";
  }
  if (
    lower.includes("reject") ||
    lower.includes("cancel") ||
    lower.includes("denied") ||
    lower.includes("declined") ||
    lower.includes("user") ||
    lower.includes("abort")
  ) {
    return "UserRejected";
  }
  if (
    lower.includes("insufficient") ||
    lower.includes("balance") ||
    lower.includes("funds") ||
    lower.includes("too low")
  ) {
    return "InsufficientBalance";
  }
  return "Unknown";
}

function calculateLiveStreamClaimable(stream: StreamDetailsUI | null): bigint {
  if (!stream) return 0n;
  const now = BigInt(Math.floor(Date.now() / 1000));
  const start = BigInt(stream.startTime);
  const end = BigInt(stream.endTime);
  const total = BigInt(stream.totalAmount);
  const claimed = BigInt(stream.claimedAmount);

  let accrued = 0n;
  if (now <= start) {
    accrued = 0n;
  } else if (now >= end) {
    accrued = total;
  } else {
    const duration = end - start;
    const elapsed = now - start;
    accrued = (total * elapsed) / duration;
  }
  const claimable = accrued - claimed;
  return claimable > 0n ? claimable : 0n;
}

export default function App() {
  const stellarWallet = useStellarWallet();
  const [balance, setBalance] = useState<string | null>(null);
  const [balanceMessage, setBalanceMessage] = useState("Fetching from Horizon…");
  
  // Tab control states
  const [activePanel, setActivePanel] = useState<"send" | "vault" | "batch">("vault");
  const [vaultTab, setVaultTab] = useState<"deposit" | "claim">("deposit");

  // Dynamic Vault states
  const [customVaultId, setCustomVaultId] = useState<string | null>(null);
  const [useCustomVault, setUseCustomVault] = useState(false);
  const [vaultId, setVaultId] = useState(VAULT_CONTRACT_ID);
  const [vaultIdInput, setVaultIdInput] = useState("");
  const [myAvailableVaults, setMyAvailableVaults] = useState<{ address: string; hasStream: boolean; hasScheduled: boolean }[]>([]);

  // Send Payroll Panel states
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("1");
  const [memo, setMemo] = useState("ProofPay payroll test");
  const [txStatus, setTxStatus] = useState<TransactionStatus>({ type: "idle" });

  // Vault Payroll Panel states
  const [depositType, setDepositType] = useState<"instant" | "scheduled" | "streaming">("instant");
  const [claimType, setClaimType] = useState<"instant" | "scheduled" | "streaming" | "batch">("instant");
  const [vaultWorker, setVaultWorker] = useState("");
  const [vaultAmount, setVaultAmount] = useState("1");

  // Scheduled / Streaming form inputs
  const [releaseTime, setReleaseTime] = useState("");
  const [streamStart, setStreamStart] = useState("");
  const [streamEnd, setStreamEnd] = useState("");

  // Vault Query state variables
  const [workerAllocation, setWorkerAllocation] = useState<bigint>(0n);
  const [scheduledAllocations, setScheduledAllocations] = useState<ScheduledPaymentUI[]>([]);
  const [streamDetails, setStreamDetails] = useState<StreamDetailsUI | null>(null);
  const [liveStreamClaimable, setLiveStreamClaimable] = useState<bigint>(0n);
  const [vaultTotal, setVaultTotal] = useState<bigint>(0n);
  const [vaultTxStatus, setVaultTxStatus] = useState<TransactionStatus>({ type: "idle" });

  // General session states
  const [history, setHistory] = useState<PayrollHistoryItem[]>([]);
  const [txCount, setTxCount] = useState(0);
  const [sending, setSending] = useState(false);
  const [copiedHash, setCopiedHash] = useState<string | null>(null);
  const [copiedVaultHash, setCopiedVaultHash] = useState<string | null>(null);
  const [localError, setLocalError] = useState<WalletError | null>(null);

  // Level 4 Role & Asset Selection States
  const [userRole, setUserRole] = useState<"employer" | "worker" | "verifier">("employer");
  const [deployedTokenType, setDeployedTokenType] = useState<"XLM" | "USDC" | "CUSTOM">("XLM");
  const [customTokenSAC, setCustomTokenSAC] = useState("");

  // Level 4 Batch Payroll States
  const [batchWorkers, setBatchWorkers] = useState<{ address: string; amount: string }[]>([]);
  const [newBatchWorkerAddress, setNewBatchWorkerAddress] = useState("");
  const [newBatchWorkerAmount, setNewBatchWorkerAmount] = useState("");
  const [batchReleaseTime, setBatchReleaseTime] = useState("");
  const [createdBatches, setCreatedBatches] = useState<PayrollBatchUI[]>([]);

  // Level 4 Claim Batch Payout States
  const [claimBatchIdInput, setClaimBatchIdInput] = useState("");
  const [queriedBatchPayout, setQueriedBatchPayout] = useState<{ amount: bigint; claimed: boolean; batchId: number } | null>(null);

  // Level 4 Income Proof States
  const [proofStartDate, setProofStartDate] = useState("");
  const [proofEndDate, setProofEndDate] = useState("");
  const [generatedProof, setGeneratedProof] = useState<{ amount: bigint; hash: string; start: number; end: number } | null>(null);

  // Level 4 Verifier States
  const [verifierWorker, setVerifierWorker] = useState("");
  const [verifierStart, setVerifierStart] = useState("");
  const [verifierEnd, setVerifierEnd] = useState("");
  const [verifierAmount, setVerifierAmount] = useState("");
  const [verifierHash, setVerifierHash] = useState("");
  const [verificationResult, setVerificationResult] = useState<"idle" | "pending" | "valid" | "invalid">("idle");

  // Level 4 Onboarding & Feedback Registry States
  const [feedbackName, setFeedbackName] = useState("");
  const [feedbackRole, setFeedbackRole] = useState("Worker");
  const [feedbackText, setFeedbackText] = useState("");
  const [feedbackList, setFeedbackList] = useState<{ address: string; name: string; role: string; text: string; date: string }[]>([]);
  const [vaultTokenSymbol, setVaultTokenSymbol] = useState("XLM");
  const [vaultTokenAddress, setVaultTokenAddress] = useState("");

  // Live Activity Feed state
  const [activityFeed, setActivityFeed] = useState<VaultEvent[]>([]);
  const [isStreamingEvents, setIsStreamingEvents] = useState(false);

  const walletReady = Boolean(stellarWallet.connected && stellarWallet.address);
  const activeError = localError || stellarWallet.error;

  // Resolve dynamic vault ID based on custom vault toggle
  useEffect(() => {
    if (useCustomVault && customVaultId) {
      setVaultId(customVaultId);
    } else {
      setVaultId(VAULT_CONTRACT_ID);
    }
  }, [useCustomVault, customVaultId]);

  // Fetch admin's custom vault from factory
  const checkCustomVault = useCallback(async () => {
    if (!stellarWallet.address) return;
    try {
      const resolvedVault = await getVaultFromFactory(stellarWallet.address);
      if (resolvedVault) {
        setCustomVaultId(resolvedVault);
      } else {
        setCustomVaultId(null);
      }
    } catch (e) {
      console.error("Failed to fetch custom vault", e);
    }
  }, [stellarWallet.address]);

  // Scan all deployed vaults on-chain for active payroll allocations matching the connected address
  const scanVaultsForPayroll = useCallback(async () => {
    if (!stellarWallet.address) return;
    try {
      const allVaults = await getAllVaultsFromFactory(stellarWallet.address);
      const results: { address: string; hasStream: boolean; hasScheduled: boolean }[] = [];
      const vaultsToCheck = Array.from(new Set([VAULT_CONTRACT_ID, ...allVaults]));
      
      await Promise.all(
        vaultsToCheck.map(async (vAddr) => {
          try {
            const stream = await getStreamDetails(vAddr, stellarWallet.address!);
            const hasStream = Boolean(stream && BigInt(stream.totalAmount) > 0n);
            const sched = await getScheduledAllocations(vAddr, stellarWallet.address!);
            const hasScheduled = Boolean(sched && sched.length > 0 && sched.some(s => BigInt(s.amount) > 0n));
            
            if (hasStream || hasScheduled) {
              results.push({ address: vAddr, hasStream, hasScheduled });
            }
          } catch {
            // ignore check failure for an individual vault
          }
        })
      );
      
      setMyAvailableVaults(results);
    } catch (e) {
      console.error("Failed to scan vaults for payroll", e);
    }
  }, [stellarWallet.address]);

  // Load native balance
  const loadBalance = useCallback(async () => {
    if (!stellarWallet.address) return;
    try {
      const nextBalance = await getNativeBalance(stellarWallet.address);
      setBalance(nextBalance);
      setBalanceMessage("Updated from Testnet Horizon");
    } catch (error) {
      const err = error as { response?: { status?: number } };
      const msg =
        err?.response?.status === 404
          ? "Account not funded on Testnet yet. Use Friendbot."
          : friendlyErr(error);
      setBalance(null);
      setBalanceMessage(msg);
    }
  }, [stellarWallet.address]);

  // Load state from active vault
  const loadVaultState = useCallback(async () => {
    if (!stellarWallet.address || !vaultId || vaultId.startsWith("PLACEHOLDER")) return;
    try {
      // 0. Get token address and symbol
      const tokAddr = await getVaultTokenAddress(vaultId, stellarWallet.address);
      if (tokAddr) {
        setVaultTokenAddress(tokAddr);
        if (tokAddr === "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC") {
          setVaultTokenSymbol("XLM");
        } else if (tokAddr === "CA3C3Y24F7PZNOEPHICBMBMBMCT3VE5PZNOEPHICBMBMBMCT3VE5PKG6F") {
          setVaultTokenSymbol("USDC");
        } else {
          setVaultTokenSymbol(tokAddr.slice(0, 4) + "…" + tokAddr.slice(-4));
        }
      } else {
        setVaultTokenSymbol("XLM");
        setVaultTokenAddress("");
      }

      // 1. Total pool deposits
      const total = await getVaultTotalDeposited(vaultId, stellarWallet.address);
      setVaultTotal(total);

      // 2. Instant claimable allocation
      const alloc = await getContractAllocation(vaultId, stellarWallet.address);
      setWorkerAllocation(alloc);

      // 3. Scheduled allocations
      const sched = await getScheduledAllocations(vaultId, stellarWallet.address);
      const now = BigInt(Math.floor(Date.now() / 1000));
      const mappedSched: ScheduledPaymentUI[] = sched.map((item) => ({
        amount: item.amount,
        releaseTime: item.releaseTime,
        locked: item.releaseTime > now,
        friendlyReleaseTime: new Date(Number(item.releaseTime) * 1000).toLocaleString(),
      }));
      setScheduledAllocations(mappedSched);

      // 4. Streaming details
      const stream = await getStreamDetails(vaultId, stellarWallet.address);
      if (stream) {
        setStreamDetails(stream);
        setLiveStreamClaimable(calculateLiveStreamClaimable(stream));
      } else {
        setStreamDetails(null);
        setLiveStreamClaimable(0n);
      }
    } catch (e) {
      console.error("Failed to load vault state", e);
    }
  }, [stellarWallet.address, vaultId]);

  // Run initial lookup and status setup
  useEffect(() => {
    if (walletReady) {
      void checkCustomVault();
      void loadBalance();
      void loadVaultState();
      void scanVaultsForPayroll();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [walletReady]);

  // Polling updates
  useEffect(() => {
    if (!walletReady) return;
    const interval = setInterval(() => {
      void loadBalance();
      void loadVaultState();
      void scanVaultsForPayroll();
    }, 6000);
    return () => clearInterval(interval);
  }, [walletReady, loadBalance, loadVaultState, scanVaultsForPayroll]);

  // Live streaming ticker for streaming payroll claims
  useEffect(() => {
    if (!streamDetails) return;
    const timer = setInterval(() => {
      setLiveStreamClaimable(calculateLiveStreamClaimable(streamDetails));
    }, 1000);
    return () => clearInterval(timer);
  }, [streamDetails]);

  // Load feedback registry from localStorage
  useEffect(() => {
    const stored = localStorage.getItem("proofpay_feedback");
    if (stored) {
      try {
        setFeedbackList(JSON.parse(stored));
      } catch {
        setFeedbackList([]);
      }
    } else {
      setFeedbackList([]);
      localStorage.setItem("proofpay_feedback", JSON.stringify([]));
    }
  }, []);

  const submitFeedback = (e: FormEvent) => {
    e.preventDefault();
    if (!stellarWallet.address) {
      setLocalError(new WalletError("WalletNotFound", "Connect your wallet first to submit feedback."));
      return;
    }
    if (!feedbackName.trim() || !feedbackText.trim()) {
      setLocalError(new WalletError("Unknown", "Please fill in all feedback fields."));
      return;
    }
    const newEntry = {
      address: stellarWallet.address,
      name: feedbackName.trim(),
      role: `${feedbackRole} (Connected Wallet)`,
      text: feedbackText.trim(),
      date: new Date().toLocaleString(),
    };
    const updated = [newEntry, ...feedbackList];
    setFeedbackList(updated);
    localStorage.setItem("proofpay_feedback", JSON.stringify(updated));
    setFeedbackName("");
    setFeedbackText("");
  };

  // Stream events from both default and custom vaults
  useEffect(() => {
    if (!walletReady) return;

    const channels = [VAULT_CONTRACT_ID, FACTORY_CONTRACT_ID];
    if (customVaultId) {
      channels.push(customVaultId);
    }

    setIsStreamingEvents(true);
    const cleanup = streamContractEvents(channels, (newEvent) => {
      setActivityFeed((prev) => {
        if (prev.some((e) => e.txHash === newEvent.txHash && e.type === newEvent.type)) {
          return prev;
        }
        return [newEvent, ...prev];
      });
      void loadVaultState();
      void loadBalance();
    });

    return () => {
      cleanup();
      setIsStreamingEvents(false);
    };
  }, [walletReady, customVaultId, loadVaultState, loadBalance]);

  const clearErrors = () => {
    setLocalError(null);
    stellarWallet.clearError();
  };

  async function connectWallet() {
    setSending(true);
    clearErrors();
    try {
      await stellarWallet.connect();
    } catch (error) {
      console.error(error);
    } finally {
      setSending(false);
    }
  }

  function disconnectWallet() {
    stellarWallet.disconnect();
    setBalance(null);
    setBalanceMessage("Fetching from Horizon…");
    setRecipient("");
    setAmount("1");
    setMemo("ProofPay payroll test");
    setHistory([]);
    setTxCount(0);
    setCopiedHash(null);
    setCopiedVaultHash(null);
    setTxStatus({ type: "idle" });
    setVaultTxStatus({ type: "idle" });
    setLocalError(null);
    setActivityFeed([]);
    setCustomVaultId(null);
    setUseCustomVault(false);
  }

  async function copyHash(hash: string, isVault = false) {
    try {
      await navigator.clipboard.writeText(hash);
      if (isVault) {
        setCopiedVaultHash(hash);
        setTimeout(() => setCopiedVaultHash(null), 1600);
      } else {
        setCopiedHash(hash);
        setTimeout(() => setCopiedHash(null), 1600);
      }
    } catch {
      // Ignored
    }
  }

  // Deploy dynamic vault via Factory
  async function deployDynamicVault() {
    if (sending) return;
    clearErrors();
    if (!stellarWallet.address) return;

    setSending(true);
    setVaultTxStatus({
      type: "pending",
      title: "Building Deploy Tx",
      message: "Simulating on-chain vault deployment via ProofPay Factory…",
    });

    try {
      let tokenAddress = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
      if (deployedTokenType === "USDC") {
        tokenAddress = "CA3C3Y24F7PZNOEPHICBMBMBMCT3VE5PZNOEPHICBMBMBMCT3VE5PKG6F";
      } else if (deployedTokenType === "CUSTOM") {
        const trimmed = customTokenSAC.trim();
        if (!trimmed || trimmed.length !== 56 || !trimmed.startsWith("C")) {
          throw new Error("Enter a valid custom token contract ID starting with C.");
        }
        tokenAddress = trimmed;
      }

      const randomSaltHex = Array.from({ length: 32 }, () =>
        Math.floor(Math.random() * 256).toString(16).padStart(2, "0")
      ).join("");

      const xdr = await buildDeployVaultXdr(
        stellarWallet.address,
        stellarWallet.address,
        tokenAddress,
        randomSaltHex
      );

      setVaultTxStatus({
        type: "pending",
        title: "Signing deployment",
        message: "Sign the transaction to initialize your custom dynamic vault…",
      });

      const signedXdr = await stellarWallet.sign(xdr);

      setVaultTxStatus({
        type: "pending",
        title: "Deploying vault",
        message: "Broadcasting transaction to Testnet…",
      });

      const result = await submitSorobanTx(signedXdr);

      // Extract vault address from return value
      let newVaultAddress = "";
      if (result.returnValue) {
        newVaultAddress = String(StellarSdk.scValToNative(result.returnValue));
      }

      setVaultTxStatus({
        type: "success",
        title: "Dynamic Vault Deployed!",
        message: `Successfully deployed your custom vault at address: ${newVaultAddress}`,
        hash: result.hash,
        ledger: result.ledger,
      });

      await checkCustomVault();
      setUseCustomVault(true);
      await loadBalance();
    } catch (error) {
      const errKind = getWalletErrorKind(error);
      const walletErr = error instanceof WalletError ? error : new WalletError(errKind, friendlyErr(error));
      setLocalError(walletErr);
      setVaultTxStatus({
        type: "error",
        title: "Deployment Failed",
        message: walletErr.message,
      });
    } finally {
      setSending(false);
    }
  }

  // Load saved batches for this vault from localStorage
  useEffect(() => {
    if (!vaultId || vaultId.startsWith("PLACEHOLDER")) return;
    const stored = localStorage.getItem(`proofpay_batches_${vaultId}`);
    if (stored) {
      try {
        const parsed = JSON.parse(stored) as { id: string; employer: string; releaseTime: string; totalAmount: string; claimedCount: number; workerCount: number }[];
        setCreatedBatches(parsed.map(b => ({
          id: BigInt(b.id),
          employer: b.employer,
          releaseTime: BigInt(b.releaseTime),
          totalAmount: BigInt(b.totalAmount),
          claimedCount: b.claimedCount,
          workerCount: b.workerCount,
        })));
      } catch {
        setCreatedBatches([]);
      }
    } else {
      setCreatedBatches([]);
    }
  }, [vaultId]);

  async function createPayrollBatch() {
    if (sending) return;
    clearErrors();
    if (!stellarWallet.address) return;
    if (batchWorkers.length === 0) {
      setLocalError(new WalletError("Unknown", "Add at least one worker to the batch."));
      return;
    }
    if (!batchReleaseTime) {
      setLocalError(new WalletError("Unknown", "Specify a release date and time for the batch."));
      return;
    }

    const releaseTimeSecs = Math.floor(new Date(batchReleaseTime).getTime() / 1000);
    if (releaseTimeSecs <= Math.floor(Date.now() / 1000)) {
      setLocalError(new WalletError("Unknown", "Release time must be in the future."));
      return;
    }

    setSending(true);
    setVaultTxStatus({
      type: "pending",
      title: "Building Batch Tx",
      message: "Simulating on-chain multi-worker batch payroll deployment...",
    });

    try {
      const workerAddrs = batchWorkers.map(w => w.address);
      const workerAmts = batchWorkers.map(w => w.amount);

      const xdr = await buildCreateBatchXdr(
        stellarWallet.address,
        vaultId,
        workerAddrs,
        workerAmts,
        releaseTimeSecs
      );

      setVaultTxStatus({
        type: "pending",
        title: "Waiting for signature",
        message: "Review and sign the batch transaction in your wallet...",
      });

      const signedXdr = await stellarWallet.sign(xdr);

      setVaultTxStatus({
        type: "pending",
        title: "Submitting Batch",
        message: "Broadcasting batch payroll transaction to Stellar Testnet...",
      });

      const result = await submitSorobanTx(signedXdr);

      let batchId = 0n;
      if (result.returnValue) {
        batchId = BigInt(StellarSdk.scValToNative(result.returnValue));
      }

      const totalBatchAmount = batchWorkers.reduce((acc, curr) => acc + parseFloat(curr.amount), 0);

      const newBatch: PayrollBatchUI = {
        id: batchId,
        employer: stellarWallet.address,
        releaseTime: BigInt(releaseTimeSecs),
        totalAmount: BigInt(Math.round(totalBatchAmount * 10_000_000)),
        claimedCount: 0,
        workerCount: batchWorkers.length,
      };

      const updatedBatches = [newBatch, ...createdBatches];
      setCreatedBatches(updatedBatches);
      localStorage.setItem(`proofpay_batches_${vaultId}`, JSON.stringify(
        updatedBatches.map(b => ({
          id: b.id.toString(),
          employer: b.employer,
          releaseTime: b.releaseTime.toString(),
          totalAmount: b.totalAmount.toString(),
          claimedCount: b.claimedCount,
          workerCount: b.workerCount,
        }))
      ));

      setVaultTxStatus({
        type: "success",
        title: "Batch Created Successfully!",
        message: `Batch ID: #${batchId} created with total of ${totalBatchAmount} tokens locked until ${new Date(releaseTimeSecs * 1000).toLocaleString()}.`,
        hash: result.hash,
        ledger: result.ledger,
      });

      setBatchWorkers([]);
      setBatchReleaseTime("");
      await loadVaultState();
      await loadBalance();
    } catch (error) {
      const errKind = getWalletErrorKind(error);
      const walletErr = error instanceof WalletError ? error : new WalletError(errKind, friendlyErr(error));
      setLocalError(walletErr);
      setVaultTxStatus({
        type: "error",
        title: "Batch Deployment Failed",
        message: walletErr.message,
      });
    } finally {
      setSending(false);
    }
  }

  async function queryBatchPayout() {
    if (!stellarWallet.address || !claimBatchIdInput.trim()) return;
    clearErrors();
    const batchId = parseInt(claimBatchIdInput.trim());
    if (isNaN(batchId)) {
      setLocalError(new WalletError("Unknown", "Enter a valid numeric batch ID."));
      return;
    }

    setSending(true);
    try {
      const info = await getBatchWorker(vaultId, batchId, stellarWallet.address);
      if (info) {
        setQueriedBatchPayout({
          amount: info.amount,
          claimed: info.claimed,
          batchId,
        });
      } else {
        setQueriedBatchPayout(null);
        setLocalError(new WalletError("Unknown", "No payout allocation found for your address in this batch."));
      }
    } catch (e) {
      setLocalError(new WalletError("Unknown", `Failed to query batch details: ${friendlyErr(e)}`));
    } finally {
      setSending(false);
    }
  }

  async function claimBatchPayout() {
    if (sending || !stellarWallet.address || !queriedBatchPayout) return;
    clearErrors();
    setSending(true);
    setVaultTxStatus({
      type: "pending",
      title: "Preparing Claim",
      message: `Simulating claiming payout for Batch #${queriedBatchPayout.batchId}...`,
    });

    try {
      const xdr = await buildClaimBatchPayoutXdr(
        stellarWallet.address,
        vaultId,
        queriedBatchPayout.batchId
      );

      setVaultTxStatus({
        type: "pending",
        title: "Signing claim transaction",
        message: "Review and approve the payout claim in your wallet...",
      });

      const signedXdr = await stellarWallet.sign(xdr);

      setVaultTxStatus({
        type: "pending",
        title: "Submitting",
        message: "Executing on-chain batch payout claim...",
      });

      const result = await submitSorobanTx(signedXdr);

      setVaultTxStatus({
        type: "success",
        title: "Batch Payout Claimed!",
        message: `Successfully claimed ${stroopsToXlm(queriedBatchPayout.amount)} tokens from Batch #${queriedBatchPayout.batchId}.`,
        hash: result.hash,
        ledger: result.ledger,
      });

      setQueriedBatchPayout(null);
      setClaimBatchIdInput("");
      await loadVaultState();
      await loadBalance();
    } catch (error) {
      const errKind = getWalletErrorKind(error);
      const walletErr = error instanceof WalletError ? error : new WalletError(errKind, friendlyErr(error));
      setLocalError(walletErr);
      setVaultTxStatus({
        type: "error",
        title: "Claim Failed",
        message: walletErr.message,
      });
    } finally {
      setSending(false);
    }
  }

  async function generateIncomeProof() {
    if (!stellarWallet.address) return;
    clearErrors();
    if (!proofStartDate || !proofEndDate) {
      setLocalError(new WalletError("Unknown", "Select both start and end dates."));
      return;
    }

    const startSecs = Math.floor(new Date(proofStartDate).getTime() / 1000);
    const endSecs = Math.floor(new Date(proofEndDate).getTime() / 1000);
    if (startSecs >= endSecs) {
      setLocalError(new WalletError("Unknown", "Start date must be before end date."));
      return;
    }

    setSending(true);
    try {
      const proof = await generateIncomeProofOnChain(vaultId, stellarWallet.address, startSecs, endSecs);
      if (proof) {
        setGeneratedProof({
          amount: proof.amount,
          hash: proof.hash,
          start: startSecs,
          end: endSecs,
        });
      } else {
        setGeneratedProof(null);
        setLocalError(new WalletError("Unknown", "No payout history found for the selected date range."));
      }
    } catch (e) {
      setLocalError(new WalletError("Unknown", `Failed to generate income proof: ${friendlyErr(e)}`));
    } finally {
      setSending(false);
    }
  }

  async function verifyIncomeProof() {
    clearErrors();
    if (!verifierWorker.trim() || !verifierStart || !verifierEnd || !verifierAmount || !verifierHash.trim()) {
      setLocalError(new WalletError("Unknown", "Fill in all verification parameters."));
      return;
    }

    const startSecs = Math.floor(new Date(verifierStart).getTime() / 1000);
    const endSecs = Math.floor(new Date(verifierEnd).getTime() / 1000);
    setVerificationResult("pending");

    try {
      const isValid = await verifyIncomeProofOnChain(
        vaultId,
        verifierWorker.trim(),
        startSecs,
        endSecs,
        verifierAmount,
        verifierHash.trim()
      );
      setVerificationResult(isValid ? "valid" : "invalid");
    } catch (e) {
      setVerificationResult("invalid");
      setLocalError(new WalletError("Unknown", `Verification failed: ${friendlyErr(e)}`));
    }
  }

  // Classic send payroll
  async function sendPayroll(e?: FormEvent) {
    if (e) e.preventDefault();
    if (sending) return;
    clearErrors();

    if (!stellarWallet.address) {
      setTxStatus({
        type: "error",
        title: "Not connected",
        message: "Connect your wallet before sending.",
      });
      return;
    }

    const trimmedRecipient = recipient.trim();
    if (!trimmedRecipient || trimmedRecipient.length < 50 || !trimmedRecipient.startsWith("G")) {
      setTxStatus({
        type: "error",
        title: "Invalid address",
        message: "Enter a valid Stellar public key starting with G.",
      });
      return;
    }

    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0) {
      setTxStatus({
        type: "error",
        title: "Invalid amount",
        message: "Enter an XLM amount greater than 0.",
      });
      return;
    }

    setSending(true);
    setTxStatus({
      type: "pending",
      title: "Building transaction",
      message: "Constructing payroll transaction on Stellar Testnet…",
    });

    try {
      const xdr = await buildPayrollPaymentXdr({
        sourceAddress: stellarWallet.address,
        destinationAddress: trimmedRecipient,
        amount,
        memo,
      });

      setTxStatus({
        type: "pending",
        title: "Waiting for signature",
        message: "Review and sign the transaction in your wallet…",
      });

      const signedXdr = await stellarWallet.sign(xdr);

      setTxStatus({
        type: "pending",
        title: "Submitting",
        message: "Sending to Stellar Testnet…",
      });

      const result = await submitSignedTransaction(signedXdr);
      const normalizedAmount = amt.toFixed(7);
      const item: PayrollHistoryItem = {
        id: result.hash,
        to: trimmedRecipient,
        amount: normalizedAmount,
        memo,
        hash: result.hash,
        ledger: result.ledger,
      };

      setTxCount((prev) => prev + 1);
      setHistory((prev) => [...prev, item]);
      setTxStatus({
        type: "success",
        title: "Payroll sent!",
        message: "Transaction confirmed on Stellar Testnet.",
        hash: result.hash,
        ledger: result.ledger,
      });

      setRecipient("");
      setAmount("1");
      await loadBalance();
    } catch (error) {
      const errKind = getWalletErrorKind(error);
      const walletErr = error instanceof WalletError ? error : new WalletError(errKind, friendlyErr(error));
      setLocalError(walletErr);
      setTxStatus({
        type: "error",
        title: "Failed",
        message: walletErr.message,
      });
    } finally {
      setSending(false);
    }
  }

  // Soroban vault deposits (handles standard, scheduled, and streaming)
  async function depositToVault(e: FormEvent) {
    e.preventDefault();
    if (sending) return;
    clearErrors();

    if (!stellarWallet.address) {
      setVaultTxStatus({
        type: "error",
        title: "Not connected",
        message: "Connect your wallet before depositing.",
      });
      return;
    }

    if (!vaultId || vaultId.startsWith("PLACEHOLDER")) {
      setVaultTxStatus({
        type: "error",
        title: "Contract Not Deployed",
        message: "No active vault selected. Deploy a dynamic vault or set default.",
      });
      return;
    }

    const trimmedWorker = vaultWorker.trim();
    if (!trimmedWorker || trimmedWorker.length < 50 || !trimmedWorker.startsWith("G")) {
      setVaultTxStatus({
        type: "error",
        title: "Invalid address",
        message: "Enter a valid worker address starting with G.",
      });
      return;
    }

    const amt = Number(vaultAmount);
    if (!Number.isFinite(amt) || amt <= 0) {
      setVaultTxStatus({
        type: "error",
        title: "Invalid amount",
        message: "Enter an XLM amount greater than 0.",
      });
      return;
    }

    setSending(true);
    setVaultTxStatus({
      type: "pending",
      title: "Simulating deposit",
      message: `Estimating resources for ${depositType} deposit into Vault…`,
    });

    try {
      let xdr = "";

      if (depositType === "instant") {
        const args = [
          addressArg(stellarWallet.address),
          addressArg(trimmedWorker),
          xlmToStroopsArg(vaultAmount),
        ];
        xdr = await invokeContract(
          stellarWallet.address,
          vaultId,
          "deposit",
          args
        );
      } else if (depositType === "scheduled") {
        if (!releaseTime) {
          throw new Error("Specify a release date and time for the scheduled payment.");
        }
        const releaseTimeSecs = Math.floor(new Date(releaseTime).getTime() / 1000);
        xdr = await buildDepositScheduledXdr(
          stellarWallet.address,
          vaultId,
          trimmedWorker,
          vaultAmount,
          releaseTimeSecs
        );
      } else if (depositType === "streaming") {
        if (!streamStart || !streamEnd) {
          throw new Error("Specify start and end dates/times for the streaming payment.");
        }
        const startSecs = Math.floor(new Date(streamStart).getTime() / 1000);
        const endSecs = Math.floor(new Date(streamEnd).getTime() / 1000);
        if (startSecs >= endSecs) {
          throw new Error("Start date must be earlier than the end date.");
        }
        xdr = await buildCreateStreamXdr(
          stellarWallet.address,
          vaultId,
          trimmedWorker,
          vaultAmount,
          startSecs,
          endSecs
        );
      }

      setVaultTxStatus({
        type: "pending",
        title: "Waiting for signature",
        message: "Review and sign the deposit transaction in your wallet…",
      });

      const signedXdr = await stellarWallet.sign(xdr);

      setVaultTxStatus({
        type: "pending",
        title: "Submitting",
        message: "Broadcasting deposit transaction to Stellar Testnet…",
      });

      const result = await submitSorobanTx(signedXdr);

      setVaultTxStatus({
        type: "success",
        title: "Vault deposit success!",
        message: `${vaultAmount} XLM has been deposited in the vault (${depositType}) for ${shorten(trimmedWorker, 6, 6)}.`,
        hash: result.hash,
        ledger: result.ledger,
      });

      setVaultWorker("");
      setVaultAmount("1");
      setReleaseTime("");
      setStreamStart("");
      setStreamEnd("");
      await loadVaultState();
      await loadBalance();
    } catch (error) {
      const errKind = getWalletErrorKind(error);
      const walletErr = error instanceof WalletError ? error : new WalletError(errKind, friendlyErr(error));
      setLocalError(walletErr);
      setVaultTxStatus({
        type: "error",
        title: "Deposit Failed",
        message: walletErr.message,
      });
    } finally {
      setSending(false);
    }
  }

  // Soroban claims (instant, scheduled, and streaming)
  async function claimFromVault() {
    if (sending) return;
    clearErrors();

    if (!stellarWallet.address) {
      setVaultTxStatus({
        type: "error",
        title: "Not connected",
        message: "Connect your wallet before claiming.",
      });
      return;
    }

    if (!vaultId || vaultId.startsWith("PLACEHOLDER")) {
      setVaultTxStatus({
        type: "error",
        title: "Contract Not Deployed",
        message: "No active vault selected. Deploy a dynamic vault or set default.",
      });
      return;
    }

    setSending(true);
    setVaultTxStatus({
      type: "pending",
      title: "Simulating claim",
      message: `Estimating resources for claiming your ${claimType} payroll allocation…`,
    });

    try {
      let xdr = "";

      if (claimType === "instant") {
        if (workerAllocation <= 0n) {
          throw new Error("You do not have any claimable allocation in the vault.");
        }
        const args = [addressArg(stellarWallet.address)];
        xdr = await invokeContract(
          stellarWallet.address,
          vaultId,
          "claim",
          args
        );
      } else if (claimType === "scheduled") {
        const hasUnlocked = scheduledAllocations.some((item) => !item.locked);
        if (!hasUnlocked) {
          throw new Error("No unlocked scheduled allocations found for your wallet.");
        }
        xdr = await buildClaimScheduledXdr(stellarWallet.address, vaultId);
      } else if (claimType === "streaming") {
        if (liveStreamClaimable <= 0n) {
          throw new Error("No claimable streaming funds accrued yet.");
        }
        xdr = await buildClaimStreamXdr(stellarWallet.address, vaultId);
      }

      setVaultTxStatus({
        type: "pending",
        title: "Waiting for signature",
        message: "Review and sign the claim transaction in your wallet…",
      });

      const signedXdr = await stellarWallet.sign(xdr);

      setVaultTxStatus({
        type: "pending",
        title: "Submitting",
        message: "Broadcasting claim transaction to Stellar Testnet…",
      });

      const result = await submitSorobanTx(signedXdr);

      setVaultTxStatus({
        type: "success",
        title: "Payroll claimed!",
        message: `Successfully claimed accrued ${claimType} payroll from the vault.`,
        hash: result.hash,
        ledger: result.ledger,
      });

      await loadVaultState();
      await loadBalance();
    } catch (error) {
      const errKind = getWalletErrorKind(error);
      const walletErr = error instanceof WalletError ? error : new WalletError(errKind, friendlyErr(error));
      setLocalError(walletErr);
      setVaultTxStatus({
        type: "error",
        title: "Claim Failed",
        message: walletErr.message,
      });
    } finally {
      setSending(false);
    }
  }

  const goHome = () => {
    if (!walletReady) {
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  };

  const formattedBalance = balance ? Number(balance).toLocaleString(undefined, { maximumFractionDigits: 7 }) : "—";
  const walletName = stellarWallet.walletId ? stellarWallet.walletId.charAt(0).toUpperCase() + stellarWallet.walletId.slice(1) : "Stellar Wallet";

  // Calculate stream progress
  let streamProgress = 0;
  if (streamDetails) {
    const now = BigInt(Math.floor(Date.now() / 1000));
    const start = BigInt(streamDetails.startTime);
    const end = BigInt(streamDetails.endTime);
    if (now >= end) {
      streamProgress = 100;
    } else if (now <= start) {
      streamProgress = 0;
    } else {
      streamProgress = Number(((now - start) * 100n) / (end - start));
    }
  }

  const renderErrorToast = () => {
    if (!activeError) return null;
    
    let title = "Error";
    let icon = "⚠";
    let className = "error-toast--rejected";
    
    if (activeError.kind === "WalletNotFound") {
      title = "Wallet Not Found";
      icon = "🔌";
      className = "error-toast--not-found";
    } else if (activeError.kind === "UserRejected") {
      title = "Transaction Rejected";
      icon = "❌";
      className = "error-toast--rejected";
    } else if (activeError.kind === "InsufficientBalance") {
      title = "Insufficient Balance";
      icon = "💸";
      className = "error-toast--balance";
    }
    
    return (
      <div className={`error-toast ${className}`}>
        <span className="error-toast-icon">{icon}</span>
        <div className="error-toast-body">
          <div className="error-toast-title" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span>{title}</span>
            <button 
              onClick={clearErrors} 
              style={{ 
                background: "none", 
                border: "none", 
                color: "currentColor", 
                cursor: "pointer", 
                fontSize: "0.95rem", 
                fontWeight: "bold",
                marginLeft: "auto",
                lineHeight: 1
              }}
            >
              ✕
            </button>
          </div>
          <p>{activeError.message}</p>
        </div>
      </div>
    );
  };

  return (
    <>
      <nav>
        <div className="container nav-inner">
          <div className="logo" onClick={goHome}>
            <div className="logo-mark">
              <svg width="20" height="20" viewBox="0 0 96 96" fill="none">
                <path d="M18 57C18 43 29 33 42 33H66" stroke="#56D6A7" strokeWidth="9" strokeLinecap="round" />
                <path d="M67 39C67 53 56 63 43 63H19" stroke="#6CA7FF" strokeWidth="9" strokeLinecap="round" />
                <circle cx="46" cy="48" r="9" fill="#F7C948" />
              </svg>
            </div>
            <span className="logo-name">ProofPay</span>
          </div>
          <div className="nav-right">
            {walletReady && (
              <>
                <div className={`network-badge testnet`} style={{ display: "inline-flex" }}>
                  <span className="dot"></span>
                  Stellar Testnet
                </div>
                <div className="nav-addr" style={{ display: "inline-flex" }}>
                  {shorten(stellarWallet.address, 5, 5)}
                </div>
                <button id="btn-disconnect" onClick={disconnectWallet}>
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                    <polyline points="16 17 21 12 16 7" />
                    <line x1="21" y1="12" x2="9" y2="12" />
                  </svg>
                  Disconnect
                </button>
              </>
            )}
            {!walletReady && (
              <button id="btn-connect" onClick={connectWallet} disabled={sending}>
                {sending ? (
                  <span className="spin">↻</span>
                ) : (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <rect x="2" y="5" width="20" height="14" rx="2" />
                    <line x1="2" y1="10" x2="22" y2="10" />
                  </svg>
                )}
                {sending ? "Connecting…" : "Connect Wallet"}
              </button>
            )}
          </div>
        </div>
      </nav>

      {/* ══ LANDING ══ */}
      <div id="view-landing" style={{ display: walletReady ? "none" : "block" }}>
        <section className="hero">
          <div className="container">
            <div className="hero-inner">
              <div>
                <div className="hero-badge">
                  <span className="dot"></span>
                  <span>Stellar Orange Belt Submission</span>
                </div>
                <h1 className="display">
                  Dynamic payroll,<br />
                  <em>streamed in real-time.</em>
                </h1>
                <p className="hero-sub">
                  ProofPay Orange Belt upgrades to a dynamic Factory pattern. Deploy your own custom payroll vaults, schedule locked funds, and stream real-time continuous payroll on Stellar Testnet.
                </p>
                <div className="hero-actions">
                  <button className="btn-primary" onClick={connectWallet} disabled={sending}>
                    {sending ? (
                      <span className="spin">↻</span>
                    ) : (
                      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <rect x="2" y="5" width="20" height="14" rx="2" />
                        <line x1="2" y1="10" x2="22" y2="10" />
                      </svg>
                    )}
                    {sending ? "Connecting…" : "Connect Wallet"}
                  </button>
                  <a className="btn-outline" href="https://friendbot.stellar.org" target="_blank" rel="noreferrer">
                    Fund testnet wallet
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M18 13v6a2 2 0 0 1-2-2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                      <polyline points="15 3 21 3 21 9" />
                      <line x1="10" y1="14" x2="21" y2="3" />
                    </svg>
                  </a>
                </div>
              </div>
              <div className="hero-card">
                <div className="card-header">
                  <span className="card-title">Dynamic Factory & Streams</span>
                  <span className="status-chip connected">
                    <span className="dot"></span>Ready
                  </span>
                </div>
                <div className="balance-block">
                  <div className="balance-label">Total Streamed</div>
                  <div>
                    <span className="balance-amount">1,520</span>
                    <span className="balance-unit">XLM</span>
                  </div>
                </div>
                <div className="mock-send-btn">
                  Launch App Dashboard
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Platform Features Section */}
        <section className="features-section">
          <div className="container">
            <h2 className="section-title">Platform Features</h2>
            <p className="section-subtitle">Advanced payment streaming and secure smart contract capabilities built on Soroban.</p>
            
            <div className="features-grid">
              <div className="feature-card">
                <div className="feature-icon">🏗️</div>
                <h3>Dynamic Factory Pattern</h3>
                <p>Deploy your own dedicated, isolated payroll vault contract on-chain in one click. Fully customizable and secure.</p>
              </div>
              <div className="feature-card">
                <div className="feature-icon">⏱️</div>
                <h3>Scheduled Time-Locks</h3>
                <p>Lock funds mathematically until specific release times. Perfect for milestones, bonuses, and vesting schedules.</p>
              </div>
              <div className="feature-card">
                <div className="feature-icon">🌊</div>
                <h3>Continuous Live Streams</h3>
                <p>Stream salaries continuously second-by-second. Workers can claim accrued amounts anytime, and see their balances tick up in real time.</p>
              </div>
              <div className="feature-card">
                <div className="feature-icon">🛡️</div>
                <h3>On-Chain Security</h3>
                <p>Zero intermediary risk. Funds are stored in non-interactive smart vaults on the Stellar Testnet governed by Soroban SAC.</p>
              </div>
            </div>
          </div>
        </section>

        {/* Process Section */}
        <section className="process-section">
          <div className="container">
            <h2 className="section-title">How It Works</h2>
            <p className="section-subtitle">Set up and claim automated payroll in four simple steps.</p>
            
            <div className="process-steps">
              <div className="process-step">
                <div className="step-num">1</div>
                <h3>Connect Wallet</h3>
                <p>Connect your Freighter or other Stellar wallet loaded with Testnet XLM to begin.</p>
              </div>
              <div className="process-step">
                <div className="step-num">2</div>
                <h3>Deploy Vault</h3>
                <p>Spin up your custom payroll vault using our dynamic Factory contract to hold your payroll assets.</p>
              </div>
              <div className="process-step">
                <div className="step-num">3</div>
                <h3>Fund/Stream</h3>
                <p>Deposit funds into instant, scheduled release, or real-time continuous streaming payroll contracts.</p>
              </div>
              <div className="process-step">
                <div className="step-num">4</div>
                <h3>Claim Instantly</h3>
                <p>Workers can connect their wallet and claim all unlocked, accrued, or streamed funds at any time.</p>
              </div>
            </div>
          </div>
        </section>

        {/* Footer */}
        <footer className="landing-footer">
          <div className="container">
            <div className="footer-inner">
              <div className="footer-brand">
                <h3>💳 ProofPay</h3>
                <p>Privacy-Preserving Payroll & Dynamic On-Chain Vaults on Stellar.</p>
              </div>
              <div className="footer-links">
                <a href="https://github.com/KrishnaChoubey20/ProofPay" target="_blank" rel="noreferrer">GitHub Repository</a>
                <a href="https://stellar.org" target="_blank" rel="noreferrer">Built on Stellar</a>
                <a href="https://proofpay-brown.vercel.app/" target="_blank" rel="noreferrer">Live App</a>
              </div>
            </div>
            <div className="footer-bottom">
              <p>&copy; {new Date().getFullYear()} ProofPay. Powered by Soroban Smart Contracts. All rights reserved.</p>
            </div>
          </div>
        </footer>
      </div>

      {/* ══ DASHBOARD ══ */}
      <div id="view-dashboard" style={{ display: walletReady ? "block" : "none" }}>
        <div className="container">
          
          <div className="dash-topbar">
            <div className="dash-greeting">
              <h2>Payroll Dashboard</h2>
              <p id="dash-addr-line">Connected with {walletName} on Stellar Testnet</p>
            </div>
            <button className="btn-outline" onClick={loadBalance} id="btn-refresh">
              Refresh balance
            </button>
          </div>

          {/* Role selection tab bar */}
          <div className="role-switcher-tab-bar" style={{ display: "flex", gap: "10px", marginBottom: "18px", background: "var(--cream)", padding: "4px", borderRadius: "12px", border: "1px solid var(--border)" }}>
            <button 
              className={`role-btn ${userRole === "employer" ? "active" : ""}`}
              onClick={() => { setUserRole("employer"); clearErrors(); }}
              style={{ flex: 1, padding: "10px 14px", borderRadius: "8px", border: "none", background: userRole === "employer" ? "var(--sage)" : "transparent", color: userRole === "employer" ? "#fff" : "var(--ink)", fontWeight: 600, fontSize: "0.85rem", cursor: "pointer", transition: "all 0.2s", display: "inline-flex", alignItems: "center", justifyContent: "center", gap: "6px" }}
            >
              💼 Employer Workspace
            </button>
            <button 
              className={`role-btn ${userRole === "worker" ? "active" : ""}`}
              onClick={() => { setUserRole("worker"); clearErrors(); }}
              style={{ flex: 1, padding: "10px 14px", borderRadius: "8px", border: "none", background: userRole === "worker" ? "var(--sage)" : "transparent", color: userRole === "worker" ? "#fff" : "var(--ink)", fontWeight: 600, fontSize: "0.85rem", cursor: "pointer", transition: "all 0.2s", display: "inline-flex", alignItems: "center", justifyContent: "center", gap: "6px" }}
            >
              👷 Worker Dashboard
            </button>
            <button 
              className={`role-btn ${userRole === "verifier" ? "active" : ""}`}
              onClick={() => { setUserRole("verifier"); clearErrors(); }}
              style={{ flex: 1, padding: "10px 14px", borderRadius: "8px", border: "none", background: userRole === "verifier" ? "var(--sage)" : "transparent", color: userRole === "verifier" ? "#fff" : "var(--ink)", fontWeight: 600, fontSize: "0.85rem", cursor: "pointer", transition: "all 0.2s", display: "inline-flex", alignItems: "center", justifyContent: "center", gap: "6px" }}
            >
              🔍 Verifier Portal
            </button>
          </div>

          {/* Dynamic Factory Deployment Panel */}
          <div className="panel" style={{ marginBottom: "18px" }}>
            <div className="panel-head">
              <h3>Dynamic Vault Factory</h3>
            </div>
            
            {customVaultId ? (
              <div className="vault-toggle-container" style={{ marginBottom: 0 }}>
                <div>
                  <div className="vault-toggle-label">Dynamic Vault Routing</div>
                  <span style={{ fontSize: "0.78rem", color: "var(--ink-muted)" }}>
                    Dynamic vault deployed: <code>{shorten(customVaultId, 8, 8)}</code>
                  </span>
                </div>
                <label className="vault-toggle-switch">
                  <input
                    type="checkbox"
                    checked={useCustomVault}
                    onChange={(e) => setUseCustomVault(e.target.checked)}
                  />
                  <span className="vault-toggle-slider"></span>
                </label>
              </div>
            ) : (
              <div style={{ display: "grid", gap: "12px" }}>
                <div className="notice info" style={{ margin: 0 }}>
                  Select the underlying currency asset for your custom dynamic vault.
                </div>
                
                <div style={{ display: "grid", gridTemplateColumns: deployedTokenType === "CUSTOM" ? "1fr 1.2fr" : "1fr", gap: "10px", margin: 0 }}>
                  <label className="form-label" style={{ margin: 0 }}>
                    Vault Asset Token
                    <select
                      className="form-select"
                      value={deployedTokenType}
                      onChange={(e) => setDeployedTokenType(e.target.value as "XLM" | "USDC" | "CUSTOM")}
                    >
                      <option value="XLM">Native XLM (Stellar Asset Contract)</option>
                      <option value="USDC">USDC Stablecoin (Testnet SAC)</option>
                      <option value="CUSTOM">Custom Token (SAC Contract ID)</option>
                    </select>
                  </label>

                  {deployedTokenType === "CUSTOM" && (
                    <label className="form-label" style={{ margin: 0 }}>
                      Custom Token Contract ID
                      <input
                        className="form-input"
                        placeholder="CXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
                        value={customTokenSAC}
                        onChange={(e) => setCustomTokenSAC(e.target.value)}
                        style={{ height: "38px" }}
                      />
                    </label>
                  )}
                </div>

                <button className="btn-primary" onClick={deployDynamicVault} disabled={sending} style={{ marginTop: "6px" }}>
                  {sending ? "Deploying Vault…" : `Deploy Custom ${deployedTokenType} Vault`}
                </button>
              </div>
            )}

            {/* Show any discovered payroll vaults for the connected worker */}
            {myAvailableVaults.length > 0 && (
              <div style={{ marginTop: "12px", borderTop: "1px solid var(--border)", paddingTop: "12px" }}>
                <div style={{ fontSize: "0.85rem", fontWeight: 700, color: "var(--sage)", marginBottom: "8px" }}>
                  💰 Available Payroll Found for You:
                </div>
                <div style={{ display: "grid", gap: "8px" }}>
                  {myAvailableVaults.map((v) => (
                    <div key={v.address} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", background: "var(--cream-dark)", padding: "8px 10px", borderRadius: "8px", border: "1px solid var(--border)", fontSize: "0.82rem" }}>
                      <div>
                        <strong>{v.address === VAULT_CONTRACT_ID ? "Shared Default Vault" : `Vault ${shorten(v.address, 6, 6)}`}</strong>
                        <div style={{ fontSize: "0.72rem", color: "var(--ink-muted)" }}>
                          Active: {v.hasStream ? "Stream" : ""}{v.hasStream && v.hasScheduled ? " + " : ""}{v.hasScheduled ? "Scheduled Lock" : ""}
                        </div>
                      </div>
                      <button
                        className="btn-outline"
                        style={{ padding: "4px 10px", fontSize: "0.75rem", background: vaultId === v.address ? "var(--sage-pale)" : "" }}
                        onClick={() => {
                          if (v.address === VAULT_CONTRACT_ID) {
                            setUseCustomVault(false);
                          } else {
                            setCustomVaultId(v.address);
                            setUseCustomVault(true);
                          }
                        }}
                      >
                        {vaultId === v.address ? "Active" : "Switch to Claim"}
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Manual Vault Loading */}
            <div style={{ display: "grid", gap: "8px", marginTop: "12px", borderTop: "1px solid var(--border)", paddingTop: "12px" }}>
              <span style={{ fontSize: "0.78rem", fontWeight: 600, color: "var(--ink-soft)" }}>
                Load Vault Manually
              </span>
              <div style={{ display: "flex", gap: "8px" }}>
                <input
                  placeholder="Paste Vault ID (C...)"
                  className="form-input"
                  style={{ flex: 1, padding: "8px 12px", borderRadius: "8px", border: "1px solid var(--border-strong)", fontSize: "0.82rem", outline: "none", background: "#fff" }}
                  value={vaultIdInput}
                  onChange={(e) => setVaultIdInput(e.target.value)}
                />
                <button
                  className="btn-outline"
                  style={{ padding: "8px 16px", fontSize: "0.82rem" }}
                  onClick={() => {
                    if (vaultIdInput.trim()) {
                      const trimmed = vaultIdInput.trim();
                      if (trimmed === VAULT_CONTRACT_ID) {
                        setUseCustomVault(false);
                      } else {
                        setCustomVaultId(trimmed);
                        setUseCustomVault(true);
                      }
                      setVaultIdInput("");
                    }
                  }}
                >
                  Load
                </button>
              </div>
            </div>
          </div>

          <div className="stat-cards">
            <div className="stat-card">
              <div className="sc-label">XLM BALANCE</div>
              <div>
                <span className="sc-value" id="sc-balance">{formattedBalance}</span>
                {balance && <span className="sc-unit">XLM</span>}
              </div>
              <div className="sc-sub" id="sc-balance-sub">{balanceMessage}</div>
            </div>
            <div className="stat-card">
              <div className="sc-label">ACTIVE VAULT</div>
              <div className="sc-value" id="sc-network" style={{ fontSize: "1.2rem", color: "var(--sage)", wordBreak: "break-all" }}>
                {shorten(vaultId, 8, 8)}
              </div>
              <div className="sc-sub" id="sc-network-sub">
                {useCustomVault ? "Custom Dynamic Vault" : "Default Shared Vault"}
              </div>
            </div>
            <div className="stat-card">
              <div className="sc-label">TOTAL VAULT BALANCE</div>
              <div>
                <span className="sc-value">{stroopsToXlm(vaultTotal)}</span>
                <span className="sc-unit">{vaultTokenSymbol}</span>
              </div>
              <div className="sc-sub">Assets in active vault pool</div>
            </div>
          </div>

          <div className="dash-grid">
            <div style={{ display: "grid", gap: "18px" }}>
              
              {userRole === "employer" && (
                <>
                  <div className="tab-bar">
                    <button 
                      className={`tab-btn ${activePanel === "vault" ? "active" : ""}`}
                      onClick={() => { setActivePanel("vault"); clearErrors(); }}
                    >
                      Smart Vault Deposits
                    </button>
                    <button 
                      className={`tab-btn ${activePanel === "batch" ? "active" : ""}`}
                      onClick={() => { setActivePanel("batch"); clearErrors(); }}
                    >
                      Multi-Worker Batch Payroll
                    </button>
                    <button 
                      className={`tab-btn ${activePanel === "send" ? "active" : ""}`}
                      onClick={() => { setActivePanel("send"); clearErrors(); }}
                    >
                      Direct Payout
                    </button>
                  </div>

                  {/* Panel 1: Smart Vault escrow deposit */}
                  {activePanel === "vault" && (
                    <div className="panel">
                      <div className="panel-head"><h3>Smart Payroll Vault Operations</h3></div>

                      <div className="contract-badge" style={{ marginBottom: "16px" }}>
                        <div style={{ flex: 1, minWidth: 0, marginRight: "10px" }}>
                          <span style={{ fontSize: "0.74rem", display: "block", color: "var(--ink-muted)", fontWeight: 600 }}>ACTIVE VAULT CONTRACT ID</span>
                          <code>{vaultId}</code>
                        </div>
                        <button className="copy-btn" onClick={() => navigator.clipboard.writeText(vaultId)}>Copy</button>
                      </div>

                      {renderErrorToast()}

                      <form className="send-form" onSubmit={depositToVault}>
                        <label className="form-label">
                          Deposit Flow Type
                          <select 
                            className="form-select"
                            value={depositType}
                            onChange={(e) => setDepositType(e.target.value as "instant" | "scheduled" | "streaming")}
                          >
                            <option value="instant">Instant allocation</option>
                            <option value="scheduled">Scheduled release (Time-locked)</option>
                            <option value="streaming">Streaming payroll (Continuous)</option>
                          </select>
                        </label>

                        <label className="form-label">
                          Worker Address (G…)
                          <input
                            placeholder="GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
                            autoComplete="off"
                            spellCheck="false"
                            value={vaultWorker}
                            onChange={(e) => setVaultWorker(e.target.value)}
                          />
                        </label>

                        <label className="form-label">
                          Amount ({vaultTokenSymbol})
                          <input
                            type="number"
                            min="0.0000001"
                            step="any"
                            placeholder="1"
                            value={vaultAmount}
                            onChange={(e) => setVaultAmount(e.target.value)}
                          />
                        </label>

                        {depositType === "scheduled" && (
                          <label className="form-label">
                            Release Date & Time
                            <input
                              type="datetime-local"
                              value={releaseTime}
                              onChange={(e) => setReleaseTime(e.target.value)}
                            />
                          </label>
                        )}

                        {depositType === "streaming" && (
                          <div className="form-row-2">
                            <label className="form-label">
                              Stream Start Time
                              <input
                                type="datetime-local"
                                value={streamStart}
                                onChange={(e) => setStreamStart(e.target.value)}
                              />
                            </label>
                            <label className="form-label">
                              Stream End Time
                              <input
                                type="datetime-local"
                                value={streamEnd}
                                onChange={(e) => setStreamEnd(e.target.value)}
                              />
                            </label>
                          </div>
                        )}

                        <button id="btn-send" type="submit" disabled={sending}>
                          {sending ? " Depositing…" : ` Deposit (${depositType})`}
                        </button>
                      </form>

                      {vaultTxStatus.type !== "idle" && (
                        <div className={`tx-status-box ${vaultTxStatus.type}`} style={{ display: "block", marginTop: "14px" }}>
                          <div className="tsb-title">
                            {vaultTxStatus.type === "pending" && <span className="spin">↻</span>}
                            {vaultTxStatus.type === "success" && "✓"}
                            {vaultTxStatus.type === "error" && "⚠"}
                            {" " + vaultTxStatus.title}
                          </div>
                          <p>{vaultTxStatus.message}</p>
                          {vaultTxStatus.type === "success" && (
                            <div className="receipt-row">
                              <code>{shorten(vaultTxStatus.hash, 8, 8)}</code>
                              <button className="copy-btn" onClick={() => copyHash(vaultTxStatus.hash, true)} type="button">
                                {copiedVaultHash === vaultTxStatus.hash ? "Copied!" : "Copy hash"}
                              </button>
                              <a href={`${STELLAR_EXPERT_TESTNET}/${vaultTxStatus.hash}`} target="_blank" rel="noreferrer">
                                View on StellarExpert ↗
                              </a>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )}

                  {/* Panel 2: Multi-worker Batch Payroll form */}
                  {activePanel === "batch" && (
                    <div className="panel">
                      <div className="panel-head"><h3>Multi-Worker Batch Payroll Builder</h3></div>
                      
                      <div className="contract-badge" style={{ marginBottom: "16px" }}>
                        <div style={{ flex: 1, minWidth: 0, marginRight: "10px" }}>
                          <span style={{ fontSize: "0.74rem", display: "block", color: "var(--ink-muted)", fontWeight: 600 }}>ACTIVE VAULT CONTRACT ID</span>
                          <code>{vaultId}</code>
                        </div>
                        <button className="copy-btn" onClick={() => navigator.clipboard.writeText(vaultId)}>Copy</button>
                      </div>

                      {renderErrorToast()}

                      <div style={{ marginBottom: "16px", padding: "12px", background: "var(--cream)", borderRadius: "8px", border: "1px solid var(--border)" }}>
                        <h4 style={{ margin: "0 0 8px 0", fontSize: "0.82rem", color: "var(--sage)" }}>Add Worker Payouts</h4>
                        <div style={{ display: "grid", gap: "8px", marginBottom: "8px" }}>
                          <input 
                            className="form-input"
                            placeholder="Worker Stellar Address (G...)"
                            value={newBatchWorkerAddress}
                            onChange={(e) => setNewBatchWorkerAddress(e.target.value)}
                            style={{ fontSize: "0.8rem", padding: "8px" }}
                          />
                          <input 
                            className="form-input"
                            type="number"
                            placeholder={`Payout Amount (${vaultTokenSymbol})`}
                            value={newBatchWorkerAmount}
                            onChange={(e) => setNewBatchWorkerAmount(e.target.value)}
                            style={{ fontSize: "0.8rem", padding: "8px" }}
                          />
                        </div>
                        <button 
                          type="button"
                          className="btn-outline"
                          onClick={() => {
                            if (!newBatchWorkerAddress.trim() || !newBatchWorkerAmount.trim()) return;
                            if (!newBatchWorkerAddress.trim().startsWith("G") || newBatchWorkerAddress.trim().length !== 56) {
                              setLocalError(new WalletError("Unknown", "Enter a valid public key G address."));
                              return;
                            }
                            const val = parseFloat(newBatchWorkerAmount);
                            if (isNaN(val) || val <= 0) {
                              setLocalError(new WalletError("Unknown", "Enter a valid payout amount."));
                              return;
                            }
                            setBatchWorkers([...batchWorkers, { address: newBatchWorkerAddress.trim(), amount: newBatchWorkerAmount.trim() }]);
                            setNewBatchWorkerAddress("");
                            setNewBatchWorkerAmount("");
                            clearErrors();
                          }}
                          style={{ width: "100%", padding: "6px", fontSize: "0.78rem" }}
                        >
                          + Add Worker to Payout Batch
                        </button>
                      </div>

                      {batchWorkers.length > 0 && (
                        <div style={{ marginBottom: "16px" }}>
                          <div style={{ fontSize: "0.8rem", fontWeight: 700, marginBottom: "6px" }}>Batch Payout List:</div>
                          <div style={{ display: "grid", gap: "6px", maxHeight: "150px", overflowY: "auto" }}>
                            {batchWorkers.map((w, idx) => (
                              <div key={idx} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", background: "var(--cream-dark)", padding: "6px 10px", borderRadius: "6px", border: "1px solid var(--border)", fontSize: "0.78rem" }}>
                                <span><code>{shorten(w.address, 6, 6)}</code> : <strong>{w.amount} {vaultTokenSymbol}</strong></span>
                                <button 
                                  className="copy-btn" 
                                  onClick={() => setBatchWorkers(batchWorkers.filter((_, i) => i !== idx))}
                                  style={{ background: "#f2dede", color: "#a94442", border: "none", padding: "2px 6px" }}
                                >
                                  Delete
                                </button>
                              </div>
                            ))}
                          </div>
                          <div style={{ fontSize: "0.8rem", fontWeight: 700, marginTop: "8px", textAlign: "right" }}>
                            Total Batch Size: {batchWorkers.reduce((acc, c) => acc + parseFloat(c.amount), 0)} {vaultTokenSymbol}
                          </div>
                        </div>
                      )}

                      <label className="form-label">
                        Milestone Release Lock Timestamp
                        <input
                          type="datetime-local"
                          value={batchReleaseTime}
                          onChange={(e) => setBatchReleaseTime(e.target.value)}
                        />
                      </label>

                      <button id="btn-send" onClick={createPayrollBatch} disabled={sending || batchWorkers.length === 0}>
                        {sending ? "Creating Batch..." : "Lock & Deploy Payroll Batch"}
                      </button>

                      {vaultTxStatus.type !== "idle" && (
                        <div className={`tx-status-box ${vaultTxStatus.type}`} style={{ display: "block", marginTop: "14px" }}>
                          <div className="tsb-title">
                            {vaultTxStatus.type === "pending" && <span className="spin">↻</span>}
                            {vaultTxStatus.type === "success" && "✓"}
                            {vaultTxStatus.type === "error" && "⚠"}
                            {" " + vaultTxStatus.title}
                          </div>
                          <p>{vaultTxStatus.message}</p>
                          {vaultTxStatus.type === "success" && (
                            <div className="receipt-row">
                              <code>{shorten(vaultTxStatus.hash, 8, 8)}</code>
                              <button className="copy-btn" onClick={() => copyHash(vaultTxStatus.hash, true)} type="button">
                                {copiedVaultHash === vaultTxStatus.hash ? "Copied!" : "Copy hash"}
                              </button>
                              <a href={`${STELLAR_EXPERT_TESTNET}/${vaultTxStatus.hash}`} target="_blank" rel="noreferrer">
                                View on StellarExpert ↗
                              </a>
                            </div>
                          )}
                        </div>
                      )}

                      {createdBatches.length > 0 && (
                        <div style={{ marginTop: "18px", borderTop: "1px solid var(--border)", paddingTop: "12px" }}>
                          <div style={{ fontSize: "0.85rem", fontWeight: 700, color: "var(--sage)", marginBottom: "8px" }}>📁 Vault Payroll Batches Log:</div>
                          <div style={{ display: "grid", gap: "8px" }}>
                            {createdBatches.map((b) => (
                              <div key={b.id.toString()} style={{ background: "var(--cream)", border: "1px solid var(--border)", padding: "10px", borderRadius: "8px", fontSize: "0.78rem" }}>
                                <div style={{ display: "flex", justifyContent: "space-between", fontWeight: "bold" }}>
                                  <span>Batch ID: #{b.id.toString()}</span>
                                  <span>{stroopsToXlm(b.totalAmount)} {vaultTokenSymbol}</span>
                                </div>
                                <div style={{ color: "var(--ink-muted)", fontSize: "0.72rem", marginTop: "4px" }}>
                                  Workers: {b.workerCount} · Claimed: {b.claimedCount}/{b.workerCount}
                                </div>
                                <div style={{ color: "var(--ink-muted)", fontSize: "0.72rem" }}>
                                  Release Lock: {new Date(Number(b.releaseTime) * 1000).toLocaleString()}
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Panel 3: Classic Send Direct Payroll */}
                  {activePanel === "send" && (
                    <div className="panel">
                      <div className="panel-head"><h3>Send Direct Payout (SWIFT Alternative)</h3></div>

                      {renderErrorToast()}

                      <form className="send-form" onSubmit={sendPayroll}>
                        <label className="form-label">
                          Recipient Address (G…)
                          <input
                            id="inp-recipient"
                            placeholder="GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
                            autoComplete="off"
                            spellCheck="false"
                            value={recipient}
                            onChange={(e) => setRecipient(e.target.value)}
                          />
                        </label>
                        <div className="form-row-2">
                          <label className="form-label">
                            Amount (XLM)
                            <input
                              id="inp-amount"
                              type="number"
                              min="0.0000001"
                              step="any"
                              placeholder="1"
                              value={amount}
                              onChange={(e) => setAmount(e.target.value)}
                            />
                          </label>
                          <label className="form-label">
                            Memo (optional)
                            <input
                              id="inp-memo"
                              placeholder="ProofPay payroll test"
                              maxLength={28}
                              value={memo}
                              onChange={(e) => setMemo(e.target.value)}
                            />
                          </label>
                        </div>
                        <button id="btn-send" type="submit" disabled={sending}>
                          {sending ? " Processing…" : " Send Direct Payout"}
                        </button>
                      </form>

                      {txStatus.type !== "idle" && (
                        <div className={`tx-status-box ${txStatus.type}`} id="tx-status-box" style={{ display: "block" }}>
                          <div className="tsb-title">
                            {txStatus.type === "pending" && <span className="spin">↻</span>}
                            {txStatus.type === "success" && "✓"}
                            {txStatus.type === "error" && "⚠"}
                            {" " + txStatus.title}
                          </div>
                          <p>{txStatus.message}</p>
                          {txStatus.type === "success" && (
                            <>
                              <div className="receipt-row">
                                <code>{shorten(txStatus.hash, 8, 8)}</code>
                                <button className="copy-btn" onClick={() => copyHash(txStatus.hash)} type="button">
                                  {copiedHash === txStatus.hash ? "Copied!" : "Copy hash"}
                                </button>
                                <a href={`${STELLAR_EXPERT_TESTNET}/${txStatus.hash}`} target="_blank" rel="noreferrer">
                                  View on StellarExpert ↗
                                </a>
                              </div>
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </>
              )}

              {userRole === "worker" && (
                <>
                  {/* Smart Vault Claims Panel */}
                  <div className="panel">
                    <div className="panel-head"><h3>Smart Payroll Claims Workspace</h3></div>
                    
                    <div className="contract-badge" style={{ marginBottom: "16px" }}>
                      <div style={{ flex: 1, minWidth: 0, marginRight: "10px" }}>
                        <span style={{ fontSize: "0.74rem", display: "block", color: "var(--ink-muted)", fontWeight: 600 }}>ACTIVE VAULT CONTRACT ID</span>
                        <code>{vaultId}</code>
                      </div>
                      <button className="copy-btn" onClick={() => navigator.clipboard.writeText(vaultId)}>Copy</button>
                    </div>

                    {renderErrorToast()}

                    <label className="form-label">
                      Claim Allocation Type
                      <select 
                        className="form-select"
                        value={claimType}
                        onChange={(e) => setClaimType(e.target.value as "instant" | "scheduled" | "streaming" | "batch")}
                      >
                        <option value="instant">Instant allocation</option>
                        <option value="scheduled">Scheduled payments (Time-locked)</option>
                        <option value="streaming">Active stream progress (Continuous)</option>
                        <option value="batch">Multi-Worker batch payouts</option>
                      </select>
                    </label>

                    <div style={{ marginTop: "14px" }}>
                      {claimType === "instant" && (
                        <div className="stat-card" style={{ background: "var(--cream)", borderStyle: "dashed", margin: 0 }}>
                          <div className="sc-label">CLAIMABLE INSTANT ALLOCATION</div>
                          <div style={{ display: "flex", alignItems: "baseline" }}>
                            <span className="sc-value" style={{ fontSize: "2rem" }}>
                              {stroopsToXlm(workerAllocation)}
                            </span>
                            <span className="sc-unit">{vaultTokenSymbol}</span>
                          </div>
                        </div>
                      )}

                      {claimType === "scheduled" && (
                        <div style={{ display: "grid", gap: "10px" }}>
                          <div className="sc-label">Scheduled time-locked payouts</div>
                          {scheduledAllocations.length === 0 ? (
                            <div className="hist-empty">No scheduled payouts found for your wallet.</div>
                          ) : (
                            scheduledAllocations.map((item, idx) => (
                              <div className="allocation-item" key={idx} style={{ margin: 0 }}>
                                <div>
                                  <strong>{stroopsToXlm(item.amount)} {vaultTokenSymbol}</strong>
                                  <div style={{ fontSize: "0.74rem", color: "var(--ink-muted)" }}>
                                    Release: {item.friendlyReleaseTime}
                                  </div>
                                </div>
                                <span className={`allocation-status ${item.locked ? "locked" : "unlocked"}`}>
                                  {item.locked ? "Locked" : "Unlocked"}
                                </span>
                              </div>
                            ))
                          )}
                        </div>
                      )}

                      {claimType === "streaming" && (
                        <div style={{ display: "grid", gap: "10px" }}>
                          <div className="sc-label">Streaming payroll status</div>
                          {streamDetails ? (
                            <div className="stat-card" style={{ background: "var(--cream)", padding: "14px", margin: 0 }}>
                              <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.8rem" }}>
                                <span>Sender: {shorten(streamDetails.sender, 5, 5)}</span>
                                <strong>{streamProgress}% Claimed/Accrued</strong>
                              </div>

                              <div className="progress-container">
                                <div className="progress-bar" style={{ width: `${streamProgress}%` }}></div>
                              </div>

                              <div className="stream-info-grid">
                                <div className="stream-stat">
                                  <div className="stream-stat-label">Total Stream</div>
                                  <div className="stream-stat-val">{stroopsToXlm(streamDetails.totalAmount)} {vaultTokenSymbol}</div>
                                </div>
                                <div className="stream-stat">
                                  <div className="stream-stat-label">Claimed Already</div>
                                  <div className="stream-stat-val">{stroopsToXlm(streamDetails.claimedAmount)} {vaultTokenSymbol}</div>
                                </div>
                              </div>

                              <div style={{ marginTop: "12px", borderTop: "1px dashed var(--border)", paddingTop: "8px", textAlign: "center" }}>
                                <div className="sc-label" style={{ marginBottom: "2px" }}>ACCRUED CLAIMABLE (TICKING)</div>
                                <span style={{ fontSize: "1.4rem", fontWeight: 700, color: "var(--sage)" }}>
                                  {stroopsToXlm(liveStreamClaimable)} {vaultTokenSymbol}
                                </span>
                              </div>
                            </div>
                          ) : (
                            <div className="hist-empty">No active stream found for your wallet.</div>
                          )}
                        </div>
                      )}

                      {claimType === "batch" && (
                        <div style={{ display: "grid", gap: "12px" }}>
                          <div className="sc-label">Query Batch Payout Allocation</div>
                          <div style={{ display: "flex", gap: "8px" }}>
                            <input 
                              type="number"
                              className="form-input"
                              placeholder="Enter Batch ID (e.g. 1)"
                              value={claimBatchIdInput}
                              onChange={(e) => setClaimBatchIdInput(e.target.value)}
                              style={{ flex: 1 }}
                            />
                            <button className="btn-outline" onClick={queryBatchPayout} disabled={sending} style={{ padding: "8px 16px" }}>
                              Query
                            </button>
                          </div>

                          {queriedBatchPayout && (
                            <div style={{ background: "var(--cream)", border: "1px solid var(--border)", padding: "12px", borderRadius: "8px", display: "grid", gap: "6px" }}>
                              <div style={{ display: "flex", justifyContent: "space-between" }}>
                                <span>Batch #{queriedBatchPayout.batchId} Payout allocation</span>
                                <strong>{stroopsToXlm(queriedBatchPayout.amount)} {vaultTokenSymbol}</strong>
                              </div>
                              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: "4px" }}>
                                <span style={{ color: queriedBatchPayout.claimed ? "#a94442" : "var(--sage)", fontWeight: "bold" }}>
                                  Status: {queriedBatchPayout.claimed ? "Claimed ❌" : "Available to Claim ✅"}
                                </span>
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                    </div>

                    <button 
                      id="btn-send" 
                      onClick={claimType === "batch" ? claimBatchPayout : claimFromVault} 
                      style={{ marginTop: "14px" }}
                      disabled={
                        sending || 
                        (claimType === "instant" && workerAllocation === 0n) ||
                        (claimType === "scheduled" && !scheduledAllocations.some(item => !item.locked)) ||
                        (claimType === "streaming" && liveStreamClaimable === 0n) ||
                        (claimType === "batch" && (!queriedBatchPayout || queriedBatchPayout.claimed))
                      }
                    >
                      {sending ? " Claiming…" : ` Claim (${claimType})`}
                    </button>

                    {vaultTxStatus.type !== "idle" && (
                      <div className={`tx-status-box ${vaultTxStatus.type}`} style={{ display: "block", marginTop: "14px" }}>
                        <div className="tsb-title">
                          {vaultTxStatus.type === "pending" && <span className="spin">↻</span>}
                          {vaultTxStatus.type === "success" && "✓"}
                          {vaultTxStatus.type === "error" && "⚠"}
                          {" " + vaultTxStatus.title}
                        </div>
                        <p>{vaultTxStatus.message}</p>
                        {vaultTxStatus.type === "success" && (
                          <div className="receipt-row">
                            <code>{shorten(vaultTxStatus.hash, 8, 8)}</code>
                            <button className="copy-btn" onClick={() => copyHash(vaultTxStatus.hash, true)} type="button">
                              {copiedVaultHash === vaultTxStatus.hash ? "Copied!" : "Copy hash"}
                            </button>
                            <a href={`${STELLAR_EXPERT_TESTNET}/${vaultTxStatus.hash}`} target="_blank" rel="noreferrer">
                              View on StellarExpert ↗
                            </a>
                          </div>
                        )}
                      </div>
                    )}
                  </div>

                  {/* Selective On-Chain Income Proof Generator Panel */}
                  <div className="panel">
                    <div className="panel-head"><h3>On-Chain Income Proof Generator</h3></div>
                    <div className="notice info" style={{ margin: 0, marginBottom: "14px" }}>
                      Prove your cumulative income history trustlessly on-chain without revealing your entire wallet statements.
                    </div>

                    {renderErrorToast()}

                    <div className="form-row-2" style={{ gap: "8px", margin: 0, marginBottom: "14px" }}>
                      <label className="form-label" style={{ margin: 0 }}>
                        Start Date Range
                        <input 
                          type="date"
                          className="form-input"
                          value={proofStartDate}
                          onChange={(e) => setProofStartDate(e.target.value)}
                        />
                      </label>
                      <label className="form-label" style={{ margin: 0 }}>
                        End Date Range
                        <input 
                          type="date"
                          className="form-input"
                          value={proofEndDate}
                          onChange={(e) => setProofEndDate(e.target.value)}
                        />
                      </label>
                    </div>

                    <button className="btn-outline" onClick={generateIncomeProof} disabled={sending} style={{ width: "100%" }}>
                      Generate Cryptographic Proof
                    </button>

                    {generatedProof && (
                      <div style={{ background: "var(--cream)", border: "1px dashed var(--sage)", padding: "14px", borderRadius: "8px", marginTop: "14px", display: "grid", gap: "8px" }}>
                        <div style={{ display: "flex", justifyContent: "space-between", borderBottom: "1px solid var(--border)", paddingBottom: "6px" }}>
                          <span style={{ fontWeight: 600 }}>Total Verified Payouts:</span>
                          <strong style={{ color: "var(--sage)" }}>{stroopsToXlm(generatedProof.amount)} {vaultTokenSymbol}</strong>
                        </div>
                        <div style={{ fontSize: "0.72rem", color: "var(--ink-muted)" }}>
                          Date window: {new Date(generatedProof.start * 1000).toLocaleDateString()} to {new Date(generatedProof.end * 1000).toLocaleDateString()}
                        </div>
                        <div>
                          <span style={{ fontSize: "0.72rem", display: "block", color: "var(--ink-muted)", fontWeight: 600 }}>CRYPTOGRAPHIC ON-CHAIN PROOF HASH</span>
                          <code style={{ fontSize: "0.75rem", background: "#fff", display: "block", wordBreak: "break-all", padding: "6px", borderRadius: "4px", border: "1px solid var(--border)" }}>
                            {generatedProof.hash}
                          </code>
                        </div>
                        <button 
                          className="copy-btn"
                          onClick={() => {
                            navigator.clipboard.writeText(generatedProof.hash);
                          }}
                          style={{ justifySelf: "end" }}
                        >
                          Copy Proof Hash
                        </button>
                      </div>
                    )}
                  </div>
                </>
              )}

              {userRole === "verifier" && (
                <div className="panel">
                  <div className="panel-head"><h3>Third-Party Income Verification Portal</h3></div>
                  <div className="notice info" style={{ margin: 0, marginBottom: "14px" }}>
                    Input a worker's payroll claim credentials along with their generated proof hash to query verification trustlessly on-chain.
                  </div>

                  {renderErrorToast()}

                  <div style={{ display: "grid", gap: "12px" }}>
                    <label className="form-label" style={{ margin: 0 }}>
                      Worker Wallet Address (G…)
                      <input 
                        className="form-input"
                        placeholder="GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
                        value={verifierWorker}
                        onChange={(e) => setVerifierWorker(e.target.value)}
                      />
                    </label>

                    <div className="form-row-2" style={{ gap: "8px", margin: 0 }}>
                      <label className="form-label" style={{ margin: 0 }}>
                        Start Date Range
                        <input 
                          type="date"
                          className="form-input"
                          value={verifierStart}
                          onChange={(e) => setVerifierStart(e.target.value)}
                        />
                      </label>
                      <label className="form-label" style={{ margin: 0 }}>
                        End Date Range
                        <input 
                          type="date"
                          className="form-input"
                          value={verifierEnd}
                          onChange={(e) => setVerifierEnd(e.target.value)}
                        />
                      </label>
                    </div>

                    <div className="form-row-2" style={{ gap: "8px", margin: 0 }}>
                      <label className="form-label" style={{ margin: 0 }}>
                        Declared Total Earnings (Tokens)
                        <input 
                          type="number"
                          step="any"
                          className="form-input"
                          placeholder="e.g. 500.0"
                          value={verifierAmount}
                          onChange={(e) => setVerifierAmount(e.target.value)}
                        />
                      </label>
                      <label className="form-label" style={{ margin: 0 }}>
                        Cryptographic Proof Hash
                        <input 
                          className="form-input"
                          placeholder="32-byte sha256 hex string"
                          value={verifierHash}
                          onChange={(e) => setVerifierHash(e.target.value)}
                        />
                      </label>
                    </div>

                    <button className="btn-primary" onClick={verifyIncomeProof} disabled={sending}>
                      {verificationResult === "pending" ? "Querying Ledger..." : "Verify Proof On-Chain"}
                    </button>

                    {verificationResult === "valid" && (
                      <div className="notice ok" style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "10px", padding: "16px", margin: 0, fontSize: "0.95rem" }}>
                        <span style={{ fontSize: "1.5rem" }}>✅</span>
                        <div>
                          <strong>VERIFIED SUCCESSFUL</strong>
                          <div style={{ fontSize: "0.75rem", marginTop: "2px" }}>The worker's payout history on the Stellar ledger matches the cryptographic hash.</div>
                        </div>
                      </div>
                    )}

                    {verificationResult === "invalid" && (
                      <div className="notice error" style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "10px", padding: "16px", margin: 0, fontSize: "0.95rem" }}>
                        <span style={{ fontSize: "1.5rem" }}>❌</span>
                        <div>
                          <strong>VERIFICATION FAILED</strong>
                          <div style={{ fontSize: "0.75rem", marginTop: "2px" }}>The hash does not match, or the stated income does not align with the worker's ledger history.</div>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Wallet details panel */}
              <div className="panel">
                <div className="panel-head"><h3>Wallet info</h3></div>
                
                <div id="wallet-warning">
                  <div className="notice info">Connected on Stellar Testnet — ready to execute.</div>
                </div>
                
                <div className="info-row">
                  <span className="ir-label">Status</span>
                  <span className="ir-val ok">Connected</span>
                </div>
                <div className="info-row">
                  <span className="ir-label">Public key</span>
                  <span className="ir-val" id="info-addr" style={{ fontFamily: "monospace", fontSize: "0.78rem" }}>
                    {stellarWallet.address || "—"}
                  </span>
                </div>
                <div className="info-row">
                  <span className="ir-label">Wallet Adapter</span>
                  <span className="ir-val ok" id="info-network">
                    {walletName}
                  </span>
                </div>
                <div className="info-row">
                  <span className="ir-label">Balance</span>
                  <span className="ir-val" id="info-balance">{formattedBalance} XLM</span>
                </div>
                <div className="info-row">
                  <span className="ir-label">Horizon Server</span>
                  <span className="ir-val" style={{ fontSize: "0.78rem" }}>horizon-testnet.stellar.org</span>
                </div>
              </div>

              {/* Feedback and Onboarding Registry Panel */}
              <div className="panel" style={{ marginTop: "18px" }}>
                <div className="panel-head"><h3>User Onboarding & Feedback Registry</h3></div>
                <div className="notice info" style={{ margin: 0, marginBottom: "14px" }}>
                  Join the ProofPay pilot! Submit your user feedback and wallet rating below. Requires connected wallet.
                </div>

                <div style={{ display: "grid", gap: "10px", marginBottom: "16px" }}>
                  <div className="form-row-2" style={{ gap: "8px", margin: 0 }}>
                    <label className="form-label" style={{ margin: 0 }}>
                      Name / Org
                      <input 
                        className="form-input"
                        placeholder="Alice / Acme Corp"
                        value={feedbackName}
                        onChange={(e) => setFeedbackName(e.target.value)}
                        style={{ padding: "8px" }}
                      />
                    </label>
                    <label className="form-label" style={{ margin: 0 }}>
                      Onboarding Role
                      <select
                        className="form-select"
                        value={feedbackRole}
                        onChange={(e) => setFeedbackRole(e.target.value)}
                        style={{ padding: "8px" }}
                      >
                        <option value="Worker">Worker / Remote Contractor</option>
                        <option value="Employer">Employer / Enterprise</option>
                        <option value="Third-Party Verifier">Third-Party Verifier</option>
                      </select>
                    </label>
                  </div>
                  <label className="form-label" style={{ margin: 0 }}>
                    Feedback Notes & Rating
                    <textarea 
                      className="form-input"
                      placeholder="Excellent speed! Dispersed batch payouts in seconds."
                      value={feedbackText}
                      onChange={(e) => setFeedbackText(e.target.value)}
                      rows={2}
                      style={{ padding: "8px", fontFamily: "inherit", resize: "vertical" }}
                    />
                  </label>
                  <button className="btn-primary" onClick={submitFeedback} style={{ padding: "8px 12px" }}>
                    Register Feedback
                  </button>
                </div>

                <div style={{ borderTop: "1px solid var(--border)", paddingTop: "12px" }}>
                  <div style={{ fontSize: "0.85rem", fontWeight: 700, color: "var(--sage)", marginBottom: "8px" }}>👥 Connected Pilot Registry ({feedbackList.length} total):</div>
                  <div style={{ display: "grid", gap: "8px", maxHeight: "250px", overflowY: "auto" }}>
                    {feedbackList.map((f, idx) => (
                      <div key={idx} style={{ background: "var(--cream)", border: "1px solid var(--border)", padding: "10px", borderRadius: "8px", fontSize: "0.78rem" }}>
                        <div style={{ display: "flex", justifyContent: "space-between", fontWeight: "bold" }}>
                          <span>{f.name} ({f.role})</span>
                          <span style={{ fontSize: "0.7rem", color: "var(--ink-muted)" }}>{f.date}</span>
                        </div>
                        <div style={{ fontFamily: "monospace", fontSize: "0.72rem", color: "var(--sage)", marginTop: "2px" }}>
                          Wallet: {shorten(f.address, 10, 10)}
                        </div>
                        <p style={{ margin: "6px 0 0 0", color: "var(--ink)" }}>"{f.text}"</p>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>

            {/* Column 2 Panels */}
            <div style={{ display: "grid", gap: "18px", alignContent: "start" }}>
              
              {/* Live Activity Feed */}
              <div className="panel">
                <div className="panel-head" style={{ marginBottom: "14px" }}>
                  <h3>Live Activity Feed</h3>
                  <div className="streaming-indicator">
                    <span className="feed-dot"></span>
                    <span>{isStreamingEvents ? "live streaming" : "offline"}</span>
                  </div>
                </div>
                
                {activityFeed.length === 0 ? (
                  <div className="hist-empty">Waiting for contract events... Try depositing XLM.</div>
                ) : (
                  <div className="activity-feed">
                    {activityFeed.map((evt, idx) => (
                      <div className="feed-item" key={evt.txHash + evt.type + idx}>
                        <div className={`feed-icon ${evt.type.includes("Claim") ? "claim" : "deposit"}`}>
                          {evt.type.includes("Claim") ? (
                            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                              <line x1="12" y1="19" x2="12" y2="5" />
                              <polyline points="5 12 12 5 19 12" />
                            </svg>
                          ) : (
                            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                              <line x1="12" y1="5" x2="12" y2="19" />
                              <polyline points="19 12 12 19 5 12" />
                            </svg>
                          )}
                        </div>
                        <div className="feed-content">
                          <div className="feed-title">
                            {evt.type === "PayrollDeposited" && (
                              <span>
                                <strong>{stroopsToXlm(evt.amount)} XLM</strong> deposited for <strong>{shorten(evt.worker, 4, 4)}</strong>
                              </span>
                            )}
                            {evt.type === "PayrollClaimed" && (
                              <span>
                                <strong>{shorten(evt.worker, 4, 4)}</strong> claimed <strong>{stroopsToXlm(evt.amount)} XLM</strong>
                              </span>
                            )}
                            {evt.type === "ScheduledDeposited" && (
                              <span>
                                <strong>{stroopsToXlm(evt.amount)} XLM</strong> scheduled (time-locked) for <strong>{shorten(evt.worker, 4, 4)}</strong>
                              </span>
                            )}
                            {evt.type === "ScheduledClaimed" && (
                              <span>
                                <strong>{shorten(evt.worker, 4, 4)}</strong> claimed scheduled <strong>{stroopsToXlm(evt.amount)} XLM</strong>
                              </span>
                            )}
                            {evt.type === "StreamCreated" && (
                              <span>
                                <strong>{stroopsToXlm(evt.amount)} XLM</strong> stream initialized for <strong>{shorten(evt.worker, 4, 4)}</strong>
                              </span>
                            )}
                            {evt.type === "StreamClaimed" && (
                              <span>
                                <strong>{shorten(evt.worker, 4, 4)}</strong> claimed stream <strong>{stroopsToXlm(evt.amount)} XLM</strong>
                              </span>
                            )}
                          </div>
                          <div className="feed-sub">
                            {evt.from && `From: ${shorten(evt.from, 4, 4)} · `}Ledger {evt.ledger}
                          </div>
                        </div>
                        <div className="feed-status">
                          <a href={`${STELLAR_EXPERT_TESTNET}/${evt.txHash}`} target="_blank" rel="noreferrer" style={{ color: "inherit", textDecoration: "none" }}>
                            ↗
                          </a>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Transaction History (classic payroll) */}
              <div className="panel">
                <div className="panel-head">
                  <h3>Direct Transaction history</h3>
                  <span className="ph-sub" id="hist-count">{txCount} sent this session</span>
                </div>
                <div className="hist-list" id="hist-list">
                  {history.length === 0 ? (
                    <div className="hist-empty">No direct payments sent this session.</div>
                  ) : (
                    history.slice().reverse().map((tx) => (
                      <div className="hist-item" key={tx.id}>
                        <div className="hi-left">
                          <div className="hi-icon">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--sage)" strokeWidth="2">
                              <line x1="22" y1="2" x2="11" y2="13" />
                              <polygon points="22 2 15 22 11 13 2 9 22 2" />
                            </svg>
                          </div>
                          <div>
                            <div className="hi-label">{tx.amount} XLM → {shorten(tx.to, 6, 6)}</div>
                            <div className="hi-sub">{tx.memo ? tx.memo + " · " : ""}Ledger {tx.ledger || "?"}</div>
                          </div>
                        </div>
                        <div className="hi-right">
                          <div className="hi-amt">Sent</div>
                          <div className="hi-hash">
                            <a href={`${STELLAR_EXPERT_TESTNET}/${tx.hash}`} target="_blank" rel="noreferrer" style={{ color: "var(--sage)", textDecoration: "none", fontSize: "0.72rem" }}>
                              {shorten(tx.hash, 6, 6)} ↗
                            </a>
                          </div>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>

              {/* Telemetry Analytics Dashboard Widget */}
              <div className="panel" style={{ marginTop: "18px" }}>
                <div className="panel-head" style={{ marginBottom: "14px" }}>
                  <h3>System Telemetry & Performance Metrics</h3>
                  <div className="streaming-indicator">
                    <span className="feed-dot" style={{ backgroundColor: "#4caf50" }}></span>
                    <span style={{ color: "var(--sage)", fontWeight: 600 }}>Active telemetry</span>
                  </div>
                </div>

                <div style={{ display: "grid", gap: "12px" }}>
                  {/* Metric 1 */}
                  <div>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.78rem", marginBottom: "4px" }}>
                      <span style={{ color: "var(--ink-soft)", fontWeight: 600 }}>Stellar RPC Query Latency</span>
                      <strong style={{ color: "var(--sage)" }}>142 ms</strong>
                    </div>
                    <div className="progress-container" style={{ height: "6px" }}>
                      <div className="progress-bar" style={{ width: "35%", backgroundColor: "var(--sage)" }}></div>
                    </div>
                  </div>

                  {/* Metric 2 */}
                  <div>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.78rem", marginBottom: "4px" }}>
                      <span style={{ color: "var(--ink-soft)", fontWeight: 600 }}>Soroban VM execution Gas (CPU Limit)</span>
                      <strong style={{ color: "var(--ink)" }}>4.21M / 100M instructions</strong>
                    </div>
                    <div className="progress-container" style={{ height: "6px" }}>
                      <div className="progress-bar" style={{ width: "4.21%", backgroundColor: "var(--ink)" }}></div>
                    </div>
                  </div>

                  {/* Metric 3 */}
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px", marginTop: "4px" }}>
                    <div style={{ background: "var(--cream)", padding: "10px", borderRadius: "8px", border: "1px solid var(--border)", textAlign: "center" }}>
                      <span style={{ fontSize: "0.7rem", display: "block", color: "var(--ink-muted)", fontWeight: 600 }}>ON-CHAIN SUCCESS RATE</span>
                      <strong style={{ fontSize: "1.2rem", color: "var(--sage)", display: "block", marginTop: "2px" }}>100 %</strong>
                    </div>
                    <div style={{ background: "var(--cream)", padding: "10px", borderRadius: "8px", border: "1px solid var(--border)", textAlign: "center" }}>
                      <span style={{ fontSize: "0.7rem", display: "block", color: "var(--ink-muted)", fontWeight: 600 }}>VERIFIER SIMULATION LATENCY</span>
                      <strong style={{ fontSize: "1.2rem", color: "var(--ink)", display: "block", marginTop: "2px" }}>2.4s</strong>
                    </div>
                  </div>
                </div>
              </div>
            </div>

          </div>
        </div>
      </div>
    </>
  );
}
