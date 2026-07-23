import { useCallback, useEffect, useState, FormEvent } from "react";
import { useStellarWallet, WalletError, WalletErrorType } from "./hooks/useStellarWallet";
import * as StellarSdk from "@stellar/stellar-sdk";
import {
  buildPayrollPaymentXdr,
  getNativeBalance,
  getUSDCBalance,
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
  const [usdcBalance, setUsdcBalance] = useState<string | null>(null);
  const [balanceMessage, setBalanceMessage] = useState("Fetching from Horizon…");
  
  // Tab control states
  const [activePanel, setActivePanel] = useState<"send" | "vault" | "batch">("vault");
  const [vaultTab, setVaultTab] = useState<"deposit" | "claim">("deposit");
  const [activeSidebarView, setActiveSidebarView] = useState("overview");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [walletMenuOpen, setWalletMenuOpen] = useState(false);
  const [addressCopied, setAddressCopied] = useState(false);
  const [roleMenuOpen, setRoleMenuOpen] = useState(false);
  const [modalVaultOpen, setModalVaultOpen] = useState(false);
  const [modalTeamOpen, setModalTeamOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerVault, setDrawerVault] = useState<any>(null);

  // Teammates state
  const [teamList, setTeamList] = useState<{ name: string; role: string; rate: string; vault: string; status: string }[]>([]);

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
  const [deployedTokenType, setDeployedTokenType] = useState<"XLM" | "USDC" | "CUSTOM">("USDC");
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
  const [vaultTokenSymbol, setVaultTokenSymbol] = useState("USDC");
  const [vaultTokenAddress, setVaultTokenAddress] = useState("");

  // Live Activity Feed state
  const [activityFeed, setActivityFeed] = useState<VaultEvent[]>([]);
  const [isStreamingEvents, setIsStreamingEvents] = useState(false);

  // Landing page live seal counter (simulated streaming pay rate for the hero)
  const [sealAmount, setSealAmount] = useState(812.4);

  const walletReady = Boolean(stellarWallet.connected && stellarWallet.address);
  const activeError = localError || stellarWallet.error;

  // Custom toast notification helper
  const toast = (msg: string) => {
    const wrap = document.getElementById("toast-wrap");
    if (!wrap) return;
    const el = document.createElement("div");
    el.className = "toast";
    el.innerText = msg;
    wrap.appendChild(el);
    setTimeout(() => {
      el.classList.add("fade-out");
      setTimeout(() => el.remove(), 400);
    }, 3000);
  };

  // Add worker to batch registry queue helper
  const addWorkerToBatch = () => {
    if (!newBatchWorkerAddress.trim() || !newBatchWorkerAmount.trim()) {
      alert("Please fill in both worker address and amount.");
      return;
    }
    if (!newBatchWorkerAddress.trim().startsWith("G") || newBatchWorkerAddress.trim().length !== 56) {
      alert("Invalid worker address format.");
      return;
    }
    setBatchWorkers(prev => [...prev, { 
      address: newBatchWorkerAddress.trim(), 
      amount: newBatchWorkerAmount.trim() 
    }]);
    setNewBatchWorkerAddress("");
    setNewBatchWorkerAmount("");
    toast("Worker added to batch list");
  };

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

  // Load native and USDC balances
  const loadBalance = useCallback(async () => {
    if (!stellarWallet.address) return;
    try {
      const nextBalance = await getNativeBalance(stellarWallet.address);
      setBalance(nextBalance);
      try {
        const nextUSDC = await getUSDCBalance(stellarWallet.address);
        setUsdcBalance(nextUSDC);
      } catch (e) {
        setUsdcBalance("0");
      }
      setBalanceMessage("Updated from Testnet Horizon");
    } catch (error) {
      const err = error as { response?: { status?: number } };
      const msg =
        err?.response?.status === 404
          ? "Account not funded on Testnet yet. Use Friendbot."
          : friendlyErr(error);
      setBalance(null);
      setUsdcBalance(null);
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
        } else if (tokAddr === "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA") {
          setVaultTokenSymbol("USDC");
        } else {
          setVaultTokenSymbol(tokAddr.slice(0, 4) + "…" + tokAddr.slice(-4));
        }
      } else {
        setVaultTokenSymbol("USDC");
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

  // Landing hero seal: tick up the streaming pay rate while wallet is not connected
  useEffect(() => {
    if (walletReady) return;
    const rate = 1.2 / 60; // XLM per second
    const timer = setInterval(() => {
      setSealAmount((prev) => prev + rate);
    }, 1000);
    return () => clearInterval(timer);
  }, [walletReady]);

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
        tokenAddress = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
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
        message: "Enter an amount greater than 0.",
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
        message: "Enter an amount greater than 0.",
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
        message: `${vaultAmount} ${vaultTokenSymbol} has been deposited in the vault (${depositType}) for ${shorten(trimmedWorker, 6, 6)}.`,
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
  const sparklinePoints = "10 150 Q 80 120 150 100 T 290 50 T 370 20";

  // Only show real on-chain vaults — no fake/demo data
  const activeVaultsData = [
    { id: vaultId, name: useCustomVault ? "My Deployed Vault" : "Default ProofPay Vault", type: "Streaming", asset: vaultTokenSymbol, balance: Number(stroopsToXlm(vaultTotal)), status: "active", rate: 1.2, workers: myAvailableVaults.length || 1 },
  ];

  return (
    <>
      {/* ══ LANDING PAGE ══ */}
      {!walletReady && (
        <div id="view-landing" className="ppl">
          <nav className="ppl-nav">
            <div className="container nav-inner">
              <a className="ppl-logo" onClick={goHome} style={{ cursor: "pointer" }}>
                <svg className="ppl-logo-mark" viewBox="0 0 32 32" fill="none"><rect width="32" height="32" rx="8" fill="#14110D"/><path d="M9 21V11h6.2c2.4 0 4 1.5 4 3.7 0 2.2-1.6 3.7-4 3.7H12v2.6H9zm3-5.1h2.9c1 0 1.7-.6 1.7-1.6s-.7-1.6-1.7-1.6H12v3.2z" fill="#F3EEE2"/></svg>
                <span className="ppl-logo-name">ProofPay</span>
              </a>
              <div className="ppl-nav-links">
                <a href="#vaults">Vaults</a>
                <a href="#features">Product</a>
                <a href="#proofs">Proofs</a>
                <a href="#tech">Network</a>
              </div>
              <div className="ppl-nav-right">
                <span className="ppl-net-chip">● Stellar Testnet</span>
                <button className="ppl-btn ppl-btn-primary ppl-btn-sm" onClick={connectWallet} disabled={sending}>
                  {sending ? "Connecting…" : "Connect wallet"}
                </button>
              </div>
            </div>
          </nav>

          <header className="ppl-hero" id="top">
            <div className="container ppl-hero-grid">
              <div>
                <span className="ppl-eyebrow">Soroban vaults · non-custodial payroll</span>
                <h1 className="ppl-display ppl-hero-title">Payroll that moves <em>by the second.</em><br />Proof that never spills a name.</h1>
                <p className="ppl-lede">ProofPay runs payroll through on-chain vaults on Stellar — scheduled, streaming or batched — so a worker in Lagos and an employer in Lisbon can settle without a bank in the middle, and prove their income without handing over a statement.</p>
                <div className="ppl-hero-ctas">
                  <button className="ppl-btn ppl-btn-primary" onClick={connectWallet} disabled={sending}>
                    {sending ? "Connecting…" : "Connect wallet"}
                  </button>
                  <a className="ppl-btn ppl-btn-ghost" href="#vaults">See how a vault works</a>
                </div>
                <div className="ppl-trust-row">
                  <span className="ppl-trust-chip">Non-interactive claims</span>
                  <span className="ppl-trust-chip">USDC vaults</span>
                  <span className="ppl-trust-chip">Dynamic vault factory</span>
                  <span className="ppl-trust-chip">Income proofs (roadmap)</span>
                </div>
              </div>

              <div className="ppl-seal-wrap">
                <div className="ppl-seal">
                  <svg viewBox="0 0 400 400">
                    <circle cx="200" cy="200" r="188" fill="none" stroke="#14110D" strokeOpacity="0.1" strokeWidth="1"/>
                    <circle cx="200" cy="200" r="150" fill="none" stroke="#1F4D3D" strokeOpacity="0.18" strokeWidth="1"/>
                    <g className="ppl-ring-rotate">
                      <defs><path id="ringpath" d="M 200,200 m -172,0 a 172,172 0 1,1 344,0 a 172,172 0 1,1 -344,0"/></defs>
                      <text fontFamily="IBM Plex Mono, monospace" fontSize="10.5" letterSpacing="3" fill="#A8792A">
                        <textPath href="#ringpath" startOffset="0%">
                          VAULT · 004 · ENGINEERING · SOROBAN TESTNET · STREAMING · VAULT · 004 · ENGINEERING · SOROBAN TESTNET · STREAMING ·
                        </textPath>
                      </text>
                    </g>
                    <circle cx="200" cy="200" r="120" fill="#F3EEE2" stroke="#14110D" strokeWidth="1.5"/>
                  </svg>
                  <div className="ppl-seal-center">
                    <div className="ppl-seal-num">{sealAmount.toFixed(3)}<small>USDC</small></div>
                    <div className="ppl-seal-status">Streaming now</div>
                  </div>
                </div>
                <div className="ppl-seal-caption">Live pay rate for one engineering vault — 1.2 USDC / minute, claimable any time.</div>
              </div>
            </div>
          </header>

          <div className="ppl-ticker-band">
            <div className="ppl-ticker-track">
              {[...Array(2)].map((_, dup) => (
                [
                  "DEPOSIT · VAULT#004 · +1,200.000 USDC",
                  "CLAIM · GA3F…92XQ · 84.220 USDC",
                  "FACTORY · NEW VAULT DEPLOYED · VAULT#011",
                  "STREAM · ENGINEERING · 1.2 USDC/min",
                  "CLAIM · GBOP…44LK · 212.900 USDC",
                  "PROOF · CERTIFICATE #0417 · ISSUED",
                ].map((t, i) => <span key={`${dup}-${i}`}>{t}</span>)
              ))}
            </div>
          </div>

          <section className="ppl-section" id="vaults">
            <div className="container">
              <div className="ppl-sec-head">
                <span className="ppl-eyebrow">Three ways a vault can pay</span>
                <h2 className="ppl-display">Pick the rhythm, not just the rate.</h2>
                <p>Every company gets its own isolated vault, deployed by the factory on demand. What differs is how money leaves it.</p>
              </div>
              <div className="ppl-vault-types">
                <div className="ppl-vault-card">
                  <span className="ppl-vault-tag">Scheduled</span>
                  <h3 className="ppl-display">Lock it, release it on a date.</h3>
                  <p>Set aside a lump sum that unlocks at a specific time. Built for contractor milestones, sign-on bonuses and cliff vesting, where the whole point is that nothing moves early.</p>
                </div>
                <div className="ppl-vault-card">
                  <span className="ppl-vault-tag">Streaming</span>
                  <h3 className="ppl-display">Pay out linearly, second by second.</h3>
                  <p>A continuous rate accrues in the vault and a worker can claim whatever has vested at any moment — no waiting on a monthly cycle for money already earned.</p>
                </div>
                <div className="ppl-vault-card">
                  <span className="ppl-vault-tag">Batch</span>
                  <h3 className="ppl-display">One run, a whole team claims.</h3>
                  <p>Load a multi-worker payroll in a single transaction. Every teammate claims their own allocation with their own wallet — the employer never touches anyone's keys.</p>
                </div>
              </div>
            </div>
          </section>

          <section className="ppl-section" id="features">
            <div className="container">
              <div className="ppl-sec-head">
                <span className="ppl-eyebrow">Built for teams that don't share a border</span>
                <h2 className="ppl-display">The parts that make it trustworthy.</h2>
              </div>
              <div className="ppl-feat-grid">
                <div className="ppl-feat">
                  <div className="ppl-feat-num">FACTORY</div>
                  <h4>Dynamic vault factory</h4>
                  <p>Each company's vault is deployed on demand from a Soroban factory contract — isolated funds, never a shared pool.</p>
                </div>
                <div className="ppl-feat">
                  <div className="ppl-feat-num">CUSTODY</div>
                  <h4>Non-interactive claims</h4>
                  <p>Workers claim with their own wallet signature. The employer funds the vault and never sees a private key.</p>
                </div>
                <div className="ppl-feat">
                  <div className="ppl-feat-num">ASSETS</div>
                  <h4>USDC Vaults</h4>
                  <p>Fund a vault in USDC and let workers claim their allocations continuously and securely.</p>
                </div>
                <div className="ppl-feat">
                  <div className="ppl-feat-num">PRIVACY</div>
                  <h4>Selective income proofs</h4>
                  <p>Generate a cryptographic proof of a pay history for a landlord or visa office — without exposing every transaction.</p>
                </div>
              </div>
            </div>
          </section>

          <section className="ppl-section" id="proofs">
            <div className="container ppl-proof-wrap">
              <div className="ppl-proof-copy">
                <span className="ppl-eyebrow">The paperwork, without the paperwork</span>
                <h2 className="ppl-display" style={{ fontSize: "clamp(1.8rem,3vw,2.4rem)", margin: "16px 0" }}>One statement, verifiable on-chain.</h2>
                <p>Instead of exporting a bank statement, a worker generates a signed certificate straight from their claim history — a landlord or embassy can check it against the ledger in seconds.</p>
                <ul className="ppl-proof-list">
                  <li>Chooses a date range and an asset to summarize.</li>
                  <li>ProofPay reads only confirmed claims from that worker's vault.</li>
                  <li>The certificate carries a hash that anyone can verify against the chain, without ever pulling the raw transaction history.</li>
                </ul>
              </div>
              <div className="ppl-certificate">
                <div className="ppl-cert-top">
                  <div>
                    <span className="ppl-eyebrow">Income verification</span>
                    <div className="ppl-display" style={{ fontSize: "1.3rem", marginTop: "8px" }}>Certificate #0417</div>
                  </div>
                  <div className="ppl-stamp">verified<br />on-chain</div>
                </div>
                <div className="ppl-cert-row"><span>Worker</span><span>GA3F…92XQ</span></div>
                <div className="ppl-cert-row"><span>Period</span><span>01 Apr – 30 Jun 2026</span></div>
                <div className="ppl-cert-row"><span>Verified amount</span><span>4,820.500 USDC</span></div>
                <div className="ppl-cert-row"><span>Vault</span><span>CDHJ…NPJQ</span></div>
                <div className="ppl-cert-hash">proof · bdb16cfa3ed2ad68721dd96d6657f68e1880d92439ea788281b02a2966f445f4</div>
              </div>
            </div>
          </section>

          <section className="ppl-section" id="tech">
            <div className="container">
              <div className="ppl-tech-strip">
                <div>
                  <span className="ppl-eyebrow" style={{ color: "#A8792A" }}>On testnet today</span>
                  <h3 className="ppl-display">Real contracts, not a mockup.</h3>
                  <p>ProofPay's factory and vault contracts are live on Stellar Testnet right now, deployed with Soroban SDK v25.3.1.</p>
                </div>
                <div className="ppl-tech-rows">
                  <div className="ppl-tech-row"><span>Network</span><span>Stellar · Testnet</span></div>
                  <div className="ppl-tech-row"><span>Factory contract</span><span>{shorten(FACTORY_CONTRACT_ID, 8, 12)}</span></div>
                  <div className="ppl-tech-row"><span>Default vault</span><span>{shorten(VAULT_CONTRACT_ID, 8, 12)}</span></div>
                  <div className="ppl-tech-row"><span>Wallets supported</span><span>Freighter · xBull · Albedo</span></div>
                </div>
              </div>
            </div>
          </section>

          <section className="ppl-cta-band">
            <div className="container">
              <span className="ppl-eyebrow" style={{ justifyContent: "center" }}>Set up in minutes</span>
              <h2 className="ppl-display">Start a vault before your coffee goes cold.</h2>
              <button className="ppl-btn ppl-btn-primary" onClick={connectWallet} disabled={sending}>
                {sending ? "Connecting…" : "Connect wallet"}
              </button>
            </div>
          </section>

          <footer className="ppl-footer">
            <div className="container ppl-foot-inner">
              <a className="ppl-logo" onClick={goHome} style={{ cursor: "pointer" }}>
                <svg className="ppl-logo-mark" viewBox="0 0 32 32" fill="none"><rect width="32" height="32" rx="8" fill="#14110D"/><path d="M9 21V11h6.2c2.4 0 4 1.5 4 3.7 0 2.2-1.6 3.7-4 3.7H12v2.6H9zm3-5.1h2.9c1 0 1.7-.6 1.7-1.6s-.7-1.6-1.7-1.6H12v3.2z" fill="#F3EEE2"/></svg>
                <span className="ppl-logo-name">ProofPay</span>
              </a>
              <div className="ppl-foot-links">
                <a href="#vaults">Vaults</a>
                <a href="#proofs">Proofs</a>
                <a href="https://github.com/KrishnaChoubey20/ProofPay" target="_blank" rel="noreferrer">GitHub</a>
              </div>
              <span style={{ fontSize: ".8rem", color: "var(--ink-mute)" }}>Built on Stellar · Soroban testnet demo</span>
            </div>
          </footer>
        </div>
      )}

      {/* ══ DASHBOARD PAGE ══ */}
      {walletReady && (
        <div className="dashboard-container">
          <aside className={`sidebar ${sidebarOpen ? "open" : ""}`} id="sidebar">
            <div className="side-brand">
              <svg className="logo-mark" viewBox="0 0 32 32" fill="none">
                <rect width="32" height="32" rx="8" fill="#F3EEE2" />
                <path d="M9 21V11h6.2c2.4 0 4 1.5 4 3.7 0 2.2-1.6 3.7-4 3.7H12v2.6H9zm3-5.1h2.9c1 0 1.7-.6 1.7-1.6s-.7-1.6-1.7-1.6H12v3.2z" fill="#14110D" />
              </svg>
              <span>ProofPay</span>
            </div>

            {/* Dynamic context navigation links based on userRole */}
            <nav className="side-nav">
              <div style={{ padding: "0 4px 12px", borderBottom: "1px solid rgba(243,238,226,.1)" }}>
                <label style={{ fontSize: "0.65rem", color: "rgba(243, 238, 226, 0.4)", textTransform: "uppercase", fontWeight: "bold", display: "block", marginBottom: "6px", letterSpacing: "0.1em" }}>Workspace Role</label>

                {/* Custom role dropdown */}
                <div style={{ position: "relative" }}>
                  {roleMenuOpen && (
                    <>
                      <div style={{ position: "fixed", inset: 0, zIndex: 299 }} onClick={() => setRoleMenuOpen(false)} />
                      <div className="role-dropdown">
                        {([
                          { value: "employer", icon: "💼", label: "Employer Workspace" },
                          { value: "worker",   icon: "👷", label: "Worker Dashboard" },
                          { value: "verifier", icon: "🔍", label: "Verifier Portal" },
                        ] as const).map((opt) => (
                          <button
                            key={opt.value}
                            className={`role-opt${userRole === opt.value ? " active" : ""}`}
                            onClick={() => {
                              setUserRole(opt.value);
                              clearErrors();
                              setRoleMenuOpen(false);
                              if (opt.value === "employer") setActiveSidebarView("overview");
                              else if (opt.value === "worker") setActiveSidebarView("claims");
                              else if (opt.value === "verifier") setActiveSidebarView("portal");
                            }}
                          >
                            <span className="role-opt-icon">{opt.icon}</span>
                            <span>{opt.label}</span>
                            {userRole === opt.value && (
                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ marginLeft: "auto" }}>
                                <polyline points="20 6 9 17 4 12"/>
                              </svg>
                            )}
                          </button>
                        ))}
                      </div>
                    </>
                  )}

                  {/* Trigger button */}
                  <button
                    className={`role-trigger${roleMenuOpen ? " open" : ""}`}
                    onClick={() => setRoleMenuOpen(!roleMenuOpen)}
                    aria-expanded={roleMenuOpen}
                  >
                    <span className="role-trigger-icon">
                      {userRole === "employer" ? "💼" : userRole === "worker" ? "👷" : "🔍"}
                    </span>
                    <span style={{ flex: 1, textAlign: "left" }}>
                      {userRole === "employer" ? "Employer Workspace" : userRole === "worker" ? "Worker Dashboard" : "Verifier Portal"}
                    </span>
                    <svg
                      width="11" height="11" viewBox="0 0 24 24" fill="none"
                      stroke="rgba(243,238,226,0.45)" strokeWidth="2.2"
                      style={{ flex: "none", transition: "transform 0.2s ease", transform: roleMenuOpen ? "rotate(180deg)" : "rotate(0deg)" }}
                    >
                      <polyline points="6 9 12 15 18 9"/>
                    </svg>
                  </button>
                </div>
              </div>

              <div style={{ marginTop: "12px", display: "flex", flexDirection: "column", gap: "2px" }}>
                {userRole === "employer" && (
                  <>
                    <button className={`side-link ${activeSidebarView === "overview" ? "active" : ""}`} onClick={() => setActiveSidebarView("overview")}>
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><rect x="3" y="3" width="8" height="8" rx="1.5"/><rect x="13" y="3" width="8" height="5" rx="1.5"/><rect x="13" y="12" width="8" height="9" rx="1.5"/><rect x="3" y="14" width="8" height="7" rx="1.5"/></svg>
                      Overview
                    </button>
                    <button className={`side-link ${activeSidebarView === "vaults" ? "active" : ""}`} onClick={() => setActiveSidebarView("vaults")}>
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/></svg>
                      Vault Registry
                    </button>
                    <button className={`side-link ${activeSidebarView === "team" ? "active" : ""}`} onClick={() => setActiveSidebarView("team")}>
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><circle cx="9" cy="8" r="3"/><path d="M2 21c0-3.9 3.1-7 7-7s7 3.1 7 7"/><circle cx="17" cy="7" r="2.4"/><path d="M22 21c0-2.9-1.8-5.3-4.4-6.3"/></svg>
                      Teammates
                    </button>
                    <button className={`side-link ${activeSidebarView === "batch" ? "active" : ""}`} onClick={() => setActiveSidebarView("batch")}>
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><rect x="4" y="4" width="16" height="16" rx="2" /><line x1="9" y1="9" x2="15" y2="9" /><line x1="9" y1="13" x2="15" y2="13" /><line x1="9" y1="17" x2="13" y2="17" /></svg>
                      Batch Builder
                    </button>
                  </>
                )}

                {userRole === "worker" && (
                  <>
                    <button className={`side-link ${activeSidebarView === "claims" ? "active" : ""}`} onClick={() => setActiveSidebarView("claims")}>
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" /></svg>
                      Claim Center
                    </button>
                    <button className={`side-link ${activeSidebarView === "proofs" ? "active" : ""}`} onClick={() => setActiveSidebarView("proofs")}>
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M12 3l7 3v6c0 4.6-3 7.7-7 9-4-1.3-7-4.4-7-9V6l7-3z"/><path d="M9 12l2 2 4-4"/></svg>
                      Income Proofs
                    </button>
                  </>
                )}

                {userRole === "verifier" && (
                  <button className={`side-link ${activeSidebarView === "portal" ? "active" : ""}`} onClick={() => setActiveSidebarView("portal")}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" /><polyline points="22 4 12 14.01 9 11.01" /></svg>
                    Verifier Portal
                  </button>
                )}

                <button className={`side-link ${activeSidebarView === "settings" ? "active" : ""}`} onClick={() => setActiveSidebarView("settings")}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 00.3 1.9l.1.1a2 2 0 11-2.9 2.9l-.1-.1a1.7 1.7 0 00-1.9-.3 1.7 1.7 0 00-1 1.6V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1-1.6 1.7 1.7 0 00-1.9.3l-.1.1a2 2 0 11-2.9-2.9l.1-.1a1.7 1.7 0 00.3-1.9 1.7 1.7 0 00-1.6-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.6-1 1.7 1.7 0 00-.3-1.9l-.1-.1a2 2 0 112.9-2.9l.1.1a1.7 1.7 0 001.9.3H9A1.7 1.7 0 0010 3.6V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.6 1.7 1.7 0 001.9-.3l.1-.1a2 2 0 112.9 2.9l-.1.1a1.7 1.7 0 00-.3 1.9V9c.2.7.8 1.2 1.6 1.2H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z"/></svg>
                  Settings
                </button>
              </div>
            </nav>

            <div className="side-foot">
              {/* Custom wallet dropdown */}
              <div className="wallet-menu-wrap" style={{ position: "relative" }}>
                {/* Dropdown panel — shown above the pill */}
                {walletMenuOpen && (
                  <>
                    {/* Backdrop to close on outside click */}
                    <div
                      style={{ position: "fixed", inset: 0, zIndex: 299 }}
                      onClick={() => setWalletMenuOpen(false)}
                    />
                    <div className="wallet-dropdown">
                      {/* Address row */}
                      <div className="wdrop-addr-row">
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                          <circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/>
                        </svg>
                        <span>{shorten(stellarWallet.address, 6, 6)}</span>
                      </div>
                      <div className="wdrop-divider"/>
                      
                      {/* Balances details */}
                      <div style={{ padding: "8px 14px", display: "flex", flexDirection: "column", gap: "6px" }}>
                        <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.78rem" }}>
                          <span style={{ color: "rgba(243, 238, 226, 0.45)" }}>USDC Balance:</span>
                          <span style={{ color: "var(--paper)", fontFamily: "'IBM Plex Mono', monospace" }}>
                            {usdcBalance !== null ? `${Number(usdcBalance).toLocaleString(undefined, { maximumFractionDigits: 4 })}` : "—"}
                          </span>
                        </div>
                        <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.78rem" }}>
                          <span style={{ color: "rgba(243, 238, 226, 0.45)" }}>XLM Balance:</span>
                          <span style={{ color: "rgba(243, 238, 226, 0.75)", fontFamily: "'IBM Plex Mono', monospace" }}>
                            {balance !== null ? `${Number(balance).toLocaleString(undefined, { maximumFractionDigits: 4 })}` : "—"}
                          </span>
                        </div>
                      </div>
                      <div className="wdrop-divider"/>

                      {/* Copy button */}
                      <button
                        className="wdrop-btn"
                        onClick={() => {
                          navigator.clipboard.writeText(stellarWallet.address ?? "");
                          setAddressCopied(true);
                          setTimeout(() => setAddressCopied(false), 2000);
                        }}
                      >
                        {addressCopied ? (
                          <>
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#7FBE9A" strokeWidth="2">
                              <polyline points="20 6 9 17 4 12"/>
                            </svg>
                            <span style={{ color: "#7FBE9A" }}>Copied!</span>
                          </>
                        ) : (
                          <>
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                              <rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>
                            </svg>
                            <span>Copy Address</span>
                          </>
                        )}
                      </button>
                      {/* Disconnect button */}
                      <button
                        className="wdrop-btn wdrop-btn-danger"
                        onClick={() => { setWalletMenuOpen(false); disconnectWallet(); }}
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                          <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>
                        </svg>
                        <span>Disconnect Wallet</span>
                      </button>
                    </div>
                  </>
                )}

                {/* Trigger pill */}
                <div
                  className={`wallet-pill${walletMenuOpen ? " open" : ""}`}
                  onClick={() => setWalletMenuOpen(!walletMenuOpen)}
                  role="button"
                  aria-expanded={walletMenuOpen}
                >
                  <span className="wallet-dot"></span>
                  <div className="wallet-meta" style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", width: "100%" }}>
                      <span className="wallet-addr">{shorten(stellarWallet.address, 4, 4)}</span>
                      <span style={{ fontSize: "0.74rem", color: "var(--paper)", opacity: 0.85, fontWeight: "bold", fontFamily: "'IBM Plex Mono', monospace" }}>
                        {usdcBalance !== null ? `${Number(usdcBalance).toLocaleString(undefined, { maximumFractionDigits: 2 })} USDC` : "— USDC"}
                      </span>
                    </div>
                    <span className="wallet-net">Stellar · Testnet</span>
                  </div>
                  <svg
                    width="11" height="11" viewBox="0 0 24 24" fill="none"
                    stroke="rgba(243,238,226,0.45)" strokeWidth="2.2"
                    style={{ flex: "none", transition: "transform 0.2s ease", transform: walletMenuOpen ? "rotate(180deg)" : "rotate(0deg)" }}
                  >
                    <polyline points="6 9 12 15 18 9"/>
                  </svg>
                </div>
              </div>
            </div>
          </aside>

          <div className="main-workspace">
            <div className="topbar">
              <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                <button className="menu-toggle btn-ghost btn btn-sm" onClick={() => setSidebarOpen(!sidebarOpen)}>☰</button>
                <div>
                  <h1 style={{ textTransform: "capitalize" }}>
                    {activeSidebarView === "batch" ? "Batch Payroll Builder" : activeSidebarView}
                  </h1>
                  <div className="sub">
                    Stellar Testnet · {useCustomVault ? "Custom routing: ON" : "Default system routing"}
                  </div>
                </div>
              </div>
              <div className="top-actions">
                <div className="search">
                  <span>⌕</span>
                  <input type="text" placeholder="Search vaults, claims, tx..." />
                </div>
                {userRole === "employer" && (
                  <button className="btn btn-primary btn-sm" onClick={() => setModalVaultOpen(true)}>
                    + Deploy Vault
                  </button>
                )}
              </div>
            </div>

            <div className="page">

              {/* 📊 OVERVIEW VIEW */}
              {userRole === "employer" && activeSidebarView === "overview" && (
                <div className="view active">
                  <div className="stat-grid">
                    <div className="stat-card">
                      <div className="label">Total Value Locked</div>
                      <div className="value mono">{stroopsToXlm(vaultTotal)} {vaultTokenSymbol}</div>
                      <div className="delta">▲ Connected on-chain</div>
                    </div>
                    <div className="stat-card">
                      <div className="label">Active Streams</div>
                      <div className="value mono">{streamDetails ? "1" : "0"}</div>
                      <div className="delta">{streamDetails ? "Ongoing payout stream" : "No streams created"}</div>
                    </div>
                    <div className="stat-card">
                      <div className="label">Teammates Deployed</div>
                      <div className="value mono">{teamList.length}</div>
                      <div className="delta">{teamList.filter(t => t.status === "active").length} active members</div>
                    </div>
                    <div className="stat-card">
                      <div className="label">System Routing</div>
                      <div className="value mono" style={{ fontSize: "1.1rem", fontFamily: "monospace", textTransform: "uppercase" }}>
                        {useCustomVault ? "Custom" : "Default"}
                      </div>
                      <div className="delta">{shorten(vaultId, 5, 5)}</div>
                    </div>
                  </div>

                  <div className="two-col">
                    <div className="panel">
                      <div className="panel-head">
                        <h3>Vault Live Streams</h3>
                        <span className="hint">Ticking every second</span>
                      </div>
                      <div className="stream-row">
                        <div className="stream-icon">⚓</div>
                        <div className="stream-info">
                          <div className="name">{useCustomVault ? "Employer Custom Vault" : "Default System Vault"}</div>
                          <div className="sub">
                            {streamDetails ? `Ticking stream: ${stroopsToXlm(streamDetails.totalAmount)} tokens` : "No continuous stream registered"}
                          </div>
                          {streamDetails && (
                            <div className="stream-bar">
                              <div style={{ width: `${streamProgress}%` }}></div>
                            </div>
                          )}
                        </div>
                        <div className="stream-amt">
                          <span className="n">
                            {streamDetails ? stroopsToXlm(liveStreamClaimable) : "0.00"}
                          </span>
                          <span className="u">{vaultTokenSymbol} accrued</span>
                        </div>
                      </div>
                    </div>

                    <div className="panel">
                      <div className="panel-head">
                        <h3>TVL Trend (Historical Log)</h3>
                        <span className="hint">{stroopsToXlm(vaultTotal)} {vaultTokenSymbol}</span>
                      </div>
                      <svg viewBox="0 0 380 170" style={{ width: "100%", height: "170px" }}>
                        <defs>
                          <linearGradient id="tvl-grad" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor="#1F4D3D" stopOpacity="0.22" />
                            <stop offset="100%" stopColor="#1F4D3D" stopOpacity="0" />
                          </linearGradient>
                        </defs>
                        <path d="M 10 150 Q 80 120 150 100 T 290 50 T 370 20 L 370 160 L 10 160 Z" fill="url(#tvl-grad)" />
                        <path d="M 10 150 Q 80 120 150 100 T 290 50 T 370 20" fill="none" stroke="#1F4D3D" strokeWidth="2" />
                      </svg>
                    </div>
                  </div>

                  <div className="panel" style={{ marginTop: "24px" }}>
                    <div className="panel-head">
                      <h3>Recent Vault Activity Logs</h3>
                      <span className="hint">Soroban on-chain event stream active</span>
                    </div>
                    {activityFeed.length === 0 ? (
                      <div style={{ padding: "20px", fontStyle: "italic", color: "var(--ink-mute)", textAlign: "center" }}>
                        Waiting for events... Make a deposit or claim on-chain to trigger logs.
                      </div>
                    ) : (
                      <table>
                        <thead>
                          <tr>
                            <th>Action</th>
                            <th>Target Address</th>
                            <th>Amount</th>
                            <th>Tx Hash</th>
                            <th>Status</th>
                          </tr>
                        </thead>
                        <tbody>
                          {activityFeed.slice(0, 10).map((evt, idx) => (
                            <tr key={idx}>
                              <td>
                                <span className={`dot ${evt.type.toLowerCase().includes("deposit") ? "deposit" : evt.type.toLowerCase().includes("claim") ? "claim" : "stream"}`}></span>
                                {evt.type.toUpperCase()}
                              </td>
                              <td className="mono">{shorten(evt.worker, 8, 8)}</td>
                              <td className="mono">{stroopsToXlm(evt.amount)} {vaultTokenSymbol}</td>
                              <td className="mono">
                                <a href={`${STELLAR_EXPERT_TESTNET}/${evt.txHash}`} target="_blank" rel="noreferrer" style={{ color: "var(--vault)" }}>
                                  {shorten(evt.txHash, 6, 6)} ↗
                                </a>
                              </td>
                              <td><span className="pill active">Confirmed</span></td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                </div>
              )}

              {/* 📂 VAULTS VIEW */}
              {userRole === "employer" && activeSidebarView === "vaults" && (
                <div className="view active">
                  <div className="panel">
                    <div className="panel-head">
                      <h3>Dynamic Custom Vault routing</h3>
                    </div>
                    
                    {customVaultId ? (
                      <div className="vault-toggle-container" style={{ margin: 0 }}>
                        <div>
                          <div className="vault-toggle-label" style={{ fontSize: "1.02rem" }}>Vault Routing Mode</div>
                          <span style={{ fontSize: "0.8rem", color: "var(--ink-muted)" }}>
                            Routing all payments through your custom deployed vault: <code>{customVaultId}</code>
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
                          No custom vault deployed yet. Use the deployment manager modal to spin one up on Stellar Testnet instantly.
                        </div>
                        <button className="btn btn-primary" onClick={() => setModalVaultOpen(true)} style={{ justifySelf: "start" }}>
                          + Deploy Custom Vault
                        </button>
                      </div>
                    )}
                  </div>

                  <div className="panel" style={{ marginTop: "24px" }}>
                    <div className="panel-head">
                      <h3>Manually Load Deployed Vault</h3>
                    </div>
                    <div style={{ display: "flex", gap: "10px" }}>
                      <input 
                        type="text" 
                        placeholder="Enter 56-character Soroban Vault Contract Address (C...)" 
                        value={vaultIdInput}
                        onChange={(e) => setVaultIdInput(e.target.value)}
                        style={{ flex: 1, padding: "10px", borderRadius: "8px", border: "1px solid var(--paper-line-strong)", background: "var(--paper)" }}
                      />
                      <button 
                        className="btn btn-ghost"
                        onClick={() => {
                          if (vaultIdInput.trim().startsWith("C") && vaultIdInput.trim().length === 56) {
                            setCustomVaultId(vaultIdInput.trim());
                            setUseCustomVault(true);
                            setVaultIdInput("");
                            toast("Dynamic Vault Loaded Successfully!");
                          } else {
                            alert("Invalid contract address format.");
                          }
                        }}
                      >
                        Load Contract
                      </button>
                    </div>
                  </div>

                  <div style={{ marginTop: "28px" }}>
                    <h3 style={{ fontFamily: "Fraunces, serif", fontSize: "1.15rem", marginBottom: "16px" }}>Active Vault Registries</h3>
                    {!useCustomVault && Number(stroopsToXlm(vaultTotal)) === 0 ? (
                      <div className="team-empty-state" style={{ border: "1.5px dashed var(--paper-line-strong)", borderRadius: "14px", padding: "40px 24px" }}>
                        <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.3">
                          <rect x="2" y="3" width="20" height="18" rx="2"/><path d="M2 9h20M9 21V9"/>
                        </svg>
                        <div className="team-empty-title">No vaults deployed yet</div>
                        <div className="team-empty-sub">Click "+ Deploy Vault" above to create your first USDC payroll vault on Stellar Testnet.</div>
                        <button className="btn btn-primary btn-sm" onClick={() => setModalVaultOpen(true)}>Deploy your first vault</button>
                      </div>
                    ) : (
                      <div className="vault-grid">
                        {activeVaultsData.map((v, idx) => (
                          <div className="vcard" key={idx} onClick={() => { setDrawerVault(v); setDrawerOpen(true); }}>
                            <div className="vcard-top">
                              <span className="vcard-type">{v.type}</span>
                              <span className={`pill ${v.status}`}>{v.status}</span>
                            </div>
                            <h4>{v.name}</h4>
                            <div className="id mono">{shorten(v.id, 8, 8)}</div>
                            <div className="bal">
                              {v.balance.toLocaleString()}
                              <small>{v.asset}</small>
                            </div>
                            <div className="vcard-foot">
                              <span style={{ fontSize: "0.76rem", color: "var(--ink-muted)" }}>{v.workers} worker(s) allocated</span>
                              <span style={{ fontSize: "0.76rem", color: "var(--vault-deep)", fontWeight: 600 }}>Open →</span>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                </div>
              )}

              {/* 👥 TEAM VIEW */}
              {userRole === "employer" && activeSidebarView === "team" && (
                <div className="view active">
                  <div className="panel">
                    <div className="panel-head">
                      <h3>Teammates Payroll Registry</h3>
                      <button className="btn btn-ghost btn-sm" onClick={() => setModalTeamOpen(true)}>
                        + Add Teammate
                      </button>
                    </div>

                    {teamList.length === 0 ? (
                      <div className="team-empty-state">
                        <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.3">
                          <circle cx="9" cy="8" r="3"/>
                          <path d="M2 21c0-3.9 3.1-7 7-7s7 3.1 7 7"/>
                          <circle cx="17" cy="7" r="2.4"/>
                          <path d="M22 21c0-2.9-1.8-5.3-4.4-6.3"/>
                        </svg>
                        <div className="team-empty-title">No teammates added yet</div>
                        <div className="team-empty-sub">Click "+ Add Teammate" to start building your payroll registry.</div>
                        <button className="btn btn-primary btn-sm" onClick={() => setModalTeamOpen(true)}>Add your first teammate</button>
                      </div>
                    ) : (
                      <table>
                        <thead>
                          <tr>
                            <th>Name</th>
                            <th>Role</th>
                            <th>Allocation Rate</th>
                            <th>Asset Code</th>
                            <th>Target Vault</th>
                            <th>Status</th>
                            <th></th>
                          </tr>
                        </thead>
                        <tbody>
                          {teamList.map((t, idx) => (
                            <tr key={idx}>
                              <td><strong>{t.name}</strong></td>
                              <td>{t.role}</td>
                              <td className="mono">{t.rate}</td>
                              <td className="mono">{t.rate.split(" ")[1] || "USDC"}</td>
                              <td>{t.vault}</td>
                              <td><span className="pill active">{t.status}</span></td>
                              <td>
                                <button
                                  className="team-remove-btn"
                                  title="Remove teammate"
                                  onClick={() => {
                                    setTeamList(prev => prev.filter((_, i) => i !== idx));
                                    toast(`Removed ${t.name} from registry`);
                                  }}
                                >
                                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                                    <polyline points="3 6 5 6 21 6"/>
                                    <path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/>
                                    <path d="M10 11v6M14 11v6"/>
                                    <path d="M9 6V4h6v2"/>
                                  </svg>
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                </div>
              )}

              {/* 💸 BATCH BUILDER VIEW */}
              {userRole === "employer" && activeSidebarView === "batch" && (
                <div className="view active">
                  <div className="two-col">
                    <div className="panel">
                      <div className="panel-head">
                        <h3>Construct Multi-Worker Payout Batch</h3>
                      </div>
                      
                      {vaultTxStatus.type === "pending" && (
                        <div className="tx-status-box pending" style={{ marginBottom: "14px" }}>
                          <div className="tsb-title">⏳ Simulating Batch Submission</div>
                          <p>{vaultTxStatus.message}</p>
                        </div>
                      )}
                      {vaultTxStatus.type === "success" && (
                        <div className="tx-status-box success" style={{ marginBottom: "14px" }}>
                          <div className="tsb-title">✓ Batch Confirmed!</div>
                          <p>{vaultTxStatus.message}</p>
                        </div>
                      )}
                      {vaultTxStatus.type === "error" && (
                        <div className="tx-status-box error" style={{ marginBottom: "14px" }}>
                          <div className="tsb-title">✕ Batch Creation Failed</div>
                          <p>{vaultTxStatus.message}</p>
                        </div>
                      )}

                      <div className="notice info" style={{ margin: 0, marginBottom: "14px" }}>
                        Payroll batches lock funds for multiple workers in a single transaction on-chain.
                      </div>

                      <div className="field-row">
                        <div className="field">
                          <label>Worker Wallet Address (G...)</label>
                          <input 
                            type="text" 
                            placeholder="G..." 
                            value={newBatchWorkerAddress}
                            onChange={(e) => setNewBatchWorkerAddress(e.target.value)}
                          />
                        </div>
                        <div className="field">
                          <label>Payout Amount ({vaultTokenSymbol})</label>
                          <div style={{ display: "flex", gap: "8px" }}>
                            <input 
                              type="number" 
                              placeholder="100.0" 
                              value={newBatchWorkerAmount}
                              onChange={(e) => setNewBatchWorkerAmount(e.target.value)}
                            />
                            <button className="btn btn-ghost" type="button" onClick={addWorkerToBatch}>
                              Add
                            </button>
                          </div>
                        </div>
                      </div>

                      <div className="field">
                        <label>Unlock / Release Time</label>
                        <input 
                          type="datetime-local" 
                          value={batchReleaseTime}
                          onChange={(e) => setBatchReleaseTime(e.target.value)}
                        />
                      </div>

                      <button className="btn btn-primary" onClick={createPayrollBatch} disabled={sending} style={{ width: "100%", marginTop: "10px" }}>
                        Deploy Batch Payouts On-Chain
                      </button>
                    </div>

                    <div className="panel">
                      <div className="panel-head">
                        <h3>Allocated Workers inside Current Batch</h3>
                        <span className="hint">{batchWorkers.length} worker(s) queued</span>
                      </div>
                      
                      {batchWorkers.length === 0 ? (
                        <div style={{ padding: "20px", textAlign: "center", color: "var(--ink-mute)", fontStyle: "italic" }}>
                          No workers added to the current batch list. Fill the form to append.
                        </div>
                      ) : (
                        <div style={{ display: "grid", gap: "8px" }}>
                          {batchWorkers.map((w, idx) => (
                            <div className="stream-row" key={idx} style={{ padding: "8px 0" }}>
                              <div className="stream-info">
                                <div className="name">{shorten(w.address, 6, 6)}</div>
                                <div className="sub">Worker Wallet Address</div>
                              </div>
                              <div className="stream-amt">
                                <span className="n">{w.amount}</span>
                                <span className="u">{vaultTokenSymbol}</span>
                              </div>
                              <button 
                                className="btn btn-ghost btn-sm" 
                                style={{ borderColor: "var(--danger)", color: "var(--danger)" }}
                                onClick={() => setBatchWorkers(prev => prev.filter((_, i) => i !== idx))}
                              >
                                ✕
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="panel" style={{ marginTop: "24px" }}>
                    <div className="panel-head">
                      <h3>Active Payroll Batches Log</h3>
                    </div>
                    {createdBatches.length === 0 ? (
                      <div style={{ padding: "20px", textAlign: "center", color: "var(--ink-mute)", fontStyle: "italic" }}>
                        No batches created on this vault yet.
                      </div>
                    ) : (
                      <table>
                        <thead>
                          <tr>
                            <th>Batch ID</th>
                            <th>Workers Count</th>
                            <th>Total Locked Value</th>
                            <th>Release Time Lock</th>
                            <th>Claims Progress</th>
                          </tr>
                        </thead>
                        <tbody>
                          {createdBatches.map((b, idx) => (
                            <tr key={idx}>
                              <td className="mono"><strong>#{b.id.toString()}</strong></td>
                              <td>{b.workerCount} workers</td>
                              <td className="mono">{stroopsToXlm(b.totalAmount)} {vaultTokenSymbol}</td>
                              <td>{new Date(Number(b.releaseTime) * 1000).toLocaleString()}</td>
                              <td><span className="pill active">{b.claimedCount} claims logged</span></td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                </div>
              )}

              {/* 👷 WORKER CLAIM WORKSPACE */}
              {userRole === "worker" && activeSidebarView === "claims" && (
                <div className="view active">
                  <div className="two-col">
                    <div className="panel">
                      <div className="panel-head">
                        <h3>Stellar Worker Claim Center</h3>
                      </div>

                      {vaultTxStatus.type === "pending" && (
                        <div className="tx-status-box pending" style={{ marginBottom: "14px" }}>
                          <div className="tsb-title">⏳ Simulating Claim Transaction</div>
                          <p>{vaultTxStatus.message}</p>
                        </div>
                      )}
                      {vaultTxStatus.type === "success" && (
                        <div className="tx-status-box success" style={{ marginBottom: "14px" }}>
                          <div className="tsb-title">✓ Claim Confirmed!</div>
                          <p>{vaultTxStatus.message}</p>
                        </div>
                      )}
                      {vaultTxStatus.type === "error" && (
                        <div className="tx-status-box error" style={{ marginBottom: "14px" }}>
                          <div className="tsb-title">✕ Claim Request Failed</div>
                          <p>{vaultTxStatus.message}</p>
                        </div>
                      )}

                      <div className="workspace-tabs">
                        <button className={`workspace-tab ${claimType === "instant" ? "active" : ""}`} onClick={() => setClaimType("instant")}>
                          Standard Payout
                        </button>
                        <button className={`workspace-tab ${claimType === "scheduled" ? "active" : ""}`} onClick={() => setClaimType("scheduled")}>
                          Scheduled Lock
                        </button>
                        <button className={`workspace-tab ${claimType === "streaming" ? "active" : ""}`} onClick={() => setClaimType("streaming")}>
                          Continuous Stream
                        </button>
                        <button className={`workspace-tab ${claimType === "batch" ? "active" : ""}`} onClick={() => setClaimType("batch")}>
                          Batch Claims
                        </button>
                      </div>

                      {claimType === "instant" && (
                        <div>
                          <div className="notice info" style={{ margin: 0, marginBottom: "14px" }}>
                            Claim standard un-locked allocations deposited by your employers.
                          </div>
                          <div className="cert-row" style={{ marginBottom: "14px" }}>
                            <span>Available Balance</span>
                            <strong>{stroopsToXlm(workerAllocation)} {vaultTokenSymbol}</strong>
                          </div>
                          <button className="btn btn-primary" onClick={claimFromVault} disabled={sending || workerAllocation <= 0n} style={{ width: "100%" }}>
                            Claim standard allocation
                          </button>
                        </div>
                      )}

                      {claimType === "scheduled" && (
                        <div>
                          <div className="notice info" style={{ margin: 0, marginBottom: "14px" }}>
                            Time-locked allocations will become claimable after their respective unlock timestamps.
                          </div>
                          {scheduledAllocations.length === 0 ? (
                            <div style={{ padding: "14px", fontStyle: "italic", textAlign: "center", color: "var(--ink-mute)" }}>
                              No scheduled locked allocations detected for your wallet address.
                            </div>
                          ) : (
                            <div style={{ display: "grid", gap: "8px", marginBottom: "14px" }}>
                              {scheduledAllocations.map((item, idx) => (
                                <div className="cert-row" key={idx}>
                                  <span>Release time: {item.friendlyReleaseTime}</span>
                                  <strong style={{ color: item.locked ? "var(--gold)" : "var(--vault-deep)" }}>
                                    {stroopsToXlm(item.amount)} {vaultTokenSymbol} ({item.locked ? "Locked" : "Unlocked"})
                                  </strong>
                                </div>
                              ))}
                            </div>
                          )}
                          <button className="btn btn-primary" onClick={claimFromVault} disabled={sending || !scheduledAllocations.some(s => !s.locked)} style={{ width: "100%" }}>
                            Claim unlocked allocations
                          </button>
                        </div>
                      )}

                      {claimType === "streaming" && (
                        <div>
                          <div className="notice info" style={{ margin: 0, marginBottom: "14px" }}>
                            Accruing payroll is streamed second-by-second and can be partially claimed at any moment.
                          </div>
                          
                          {streamDetails ? (
                            <div style={{ marginBottom: "14px" }}>
                              <div className="cert-row">
                                <span>Accrued & Claimable</span>
                                <strong>{stroopsToXlm(liveStreamClaimable)} {vaultTokenSymbol}</strong>
                              </div>
                              <div className="cert-row">
                                <span>Total Deployed Stream</span>
                                <span>{stroopsToXlm(streamDetails.totalAmount)} {vaultTokenSymbol}</span>
                              </div>
                              <div className="cert-row">
                                <span>Accrued Progress</span>
                                <span>{streamProgress}%</span>
                              </div>
                              <div className="progress-container">
                                <div className="progress-bar" style={{ width: `${streamProgress}%` }}></div>
                              </div>
                            </div>
                          ) : (
                            <div style={{ padding: "14px", fontStyle: "italic", textAlign: "center", color: "var(--ink-mute)", marginBottom: "14px" }}>
                              No active continuous stream found for your wallet address.
                            </div>
                          )}
                          <button className="btn btn-primary" onClick={claimFromVault} disabled={sending || !streamDetails || liveStreamClaimable <= 0n} style={{ width: "100%" }}>
                            Claim streaming salary
                          </button>
                        </div>
                      )}

                      {claimType === "batch" && (
                        <div>
                          <div className="notice info" style={{ margin: 0, marginBottom: "14px" }}>
                            Enter the Batch ID provided by your employer to query and claim your batch payout allocation.
                          </div>
                          
                          <div className="query-bar">
                            <div className="query-bar-input-wrap">
                              <svg className="query-bar-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                                <rect x="2" y="3" width="20" height="18" rx="2"/><path d="M2 9h20M9 21V9"/>
                              </svg>
                              <input
                                type="number"
                                className="query-bar-input"
                                placeholder="Enter Batch ID (e.g. 1)"
                                value={claimBatchIdInput}
                                onChange={(e) => setClaimBatchIdInput(e.target.value)}
                                onKeyDown={(e) => e.key === "Enter" && queryBatchPayout()}
                              />
                            </div>
                            <button className="query-bar-btn" onClick={queryBatchPayout} disabled={sending}>
                              {sending ? (
                                <span style={{ opacity: 0.7 }}>Querying…</span>
                              ) : (
                                <>
                                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
                                  </svg>
                                  Query Batch
                                </>
                              )}
                            </button>
                          </div>


                          {queriedBatchPayout && (
                            <div style={{ background: "var(--paper-dim)", padding: "12px", borderRadius: "8px", marginBottom: "14px" }}>
                              <div className="cert-row">
                                <span>Worker Allocation</span>
                                <strong>{stroopsToXlm(queriedBatchPayout.amount)} {vaultTokenSymbol}</strong>
                              </div>
                              <div className="cert-row">
                                <span>Claim Status</span>
                                <span>{queriedBatchPayout.claimed ? "Claimed" : "Unclaimed"}</span>
                              </div>
                              
                              {!queriedBatchPayout.claimed && (
                                <button className="btn btn-primary" onClick={claimBatchPayout} disabled={sending} style={{ width: "100%", marginTop: "12px" }}>
                                  Claim Batch Allocation
                                </button>
                              )}
                            </div>
                          )}
                        </div>
                      )}
                    </div>

                    <div className="panel">
                      <div className="panel-head">
                        <h3>Discovered Vault Allocations</h3>
                      </div>
                      
                      {myAvailableVaults.length === 0 ? (
                        <div style={{ padding: "20px", textAlign: "center", color: "var(--ink-mute)", fontStyle: "italic" }}>
                          No active payroll allocations found for your wallet address.
                        </div>
                      ) : (
                        <div style={{ display: "grid", gap: "10px" }}>
                          {myAvailableVaults.map((item, idx) => (
                            <div className="stream-row" key={idx} style={{ padding: "8px 0" }}>
                              <div className="stream-info">
                                <div className="name">{shorten(item.address, 8, 8)}</div>
                                <div className="sub">
                                  {item.hasStream ? "Continuous Stream active " : ""}
                                  {item.hasScheduled ? "Time lock active " : ""}
                                </div>
                              </div>
                              <button className="btn btn-ghost btn-sm" onClick={() => { setVaultId(item.address); toast(`Switched active vault: ${shorten(item.address)}`); void loadVaultState(); }}>
                                Route to Vault
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {/* 📄 INCOME PROOFS VIEW */}
              {userRole === "worker" && activeSidebarView === "proofs" && (
                <div className="view active">
                  <div className="two-col">
                    <div className="panel">
                      <div className="panel-head">
                        <h3>Generate Cryptographic Income Proof</h3>
                      </div>
                      <div className="notice info" style={{ margin: 0, marginBottom: "14px" }}>
                        Select the date range window. The smart contract calculates the sum of all payouts claimed by your wallet inside that window and signs it cryptographically.
                      </div>

                      <div className="field-row">
                        <div className="field">
                          <label>Start Date</label>
                          <input type="date" value={proofStartDate} onChange={(e) => setProofStartDate(e.target.value)} />
                        </div>
                        <div className="field">
                          <label>End Date</label>
                          <input type="date" value={proofEndDate} onChange={(e) => setProofEndDate(e.target.value)} />
                        </div>
                      </div>

                      <button className="btn btn-primary" onClick={generateIncomeProof} disabled={sending} style={{ width: "100%", marginTop: "10px" }}>
                        Generate Proof Hash
                      </button>
                    </div>

                    <div className="panel">
                      <div className="panel-head">
                        <h3>Income Certificate Preview</h3>
                      </div>
                      {generatedProof ? (
                        <div>
                          <div className="certificate">
                            <div className="cert-top">
                              <div>
                                <span className="eyebrow" style={{ color: "var(--ink-muted)" }}>Verified Salary</span>
                                <div className="display" style={{ fontSize: "1.15rem", marginTop: "6px" }}>Proof Certificate</div>
                              </div>
                              <div className="stamp">verified<br />on-chain</div>
                            </div>
                            <div className="cert-row">
                              <span>Worker</span>
                              <span>{shorten(stellarWallet.address, 6, 6)}</span>
                            </div>
                            <div className="cert-row">
                              <span>Period</span>
                              <span>
                                {new Date(generatedProof.start * 1000).toLocaleDateString()} – {new Date(generatedProof.end * 1000).toLocaleDateString()}
                              </span>
                            </div>
                            <div className="cert-row">
                              <span>Verified amount</span>
                              <strong>{stroopsToXlm(generatedProof.amount)} {vaultTokenSymbol}</strong>
                            </div>
                            <div className="cert-hash">proof · {generatedProof.hash}</div>
                          </div>

                          <div className="modal-actions" style={{ justifyContent: "flex-start", marginTop: "18px" }}>
                            <button className="btn btn-primary btn-sm" onClick={() => { navigator.clipboard.writeText(generatedProof.hash); toast("Proof hash copied to clipboard!"); }}>
                              Copy Proof Hash
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div style={{ padding: "40px", color: "var(--ink-mute)", textAlign: "center", fontStyle: "italic" }}>
                          Fill the parameters and click generate to load certificate preview.
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {/* 🔍 VERIFIER VIEW */}
              {userRole === "verifier" && activeSidebarView === "portal" && (
                <div className="view active">
                  <div className="panel" style={{ maxWidth: "700px", margin: "0 auto" }}>
                    <div className="panel-head">
                      <h3>Third-Party Income Verification Portal</h3>
                    </div>
                    <div className="notice info" style={{ margin: 0, marginBottom: "14px" }}>
                      Third-party institutions (such as landlords or lenders) check and verify worker income credentials trustlessly against on-chain transaction history.
                    </div>

                    <div className="field">
                      <label>Worker Wallet Address (G...)</label>
                      <input 
                        type="text" 
                        placeholder="G..." 
                        value={verifierWorker}
                        onChange={(e) => setVerifierWorker(e.target.value)}
                      />
                    </div>

                    <div className="field-row">
                      <div className="field">
                        <label>Start Date</label>
                        <input type="date" value={verifierStart} onChange={(e) => setVerifierStart(e.target.value)} />
                      </div>
                      <div className="field">
                        <label>End Date</label>
                        <input type="date" value={verifierEnd} onChange={(e) => setVerifierEnd(e.target.value)} />
                      </div>
                    </div>

                    <div className="field-row">
                      <div className="field">
                        <label>Declared Payout Amount ({vaultTokenSymbol})</label>
                        <input type="number" step="any" placeholder="500.0" value={verifierAmount} onChange={(e) => setVerifierAmount(e.target.value)} />
                      </div>
                      <div className="field">
                        <label>Verification Proof Hash</label>
                        <input type="text" placeholder="32-byte hash hex string" value={verifierHash} onChange={(e) => setVerifierHash(e.target.value)} />
                      </div>
                    </div>

                    <button className="btn btn-primary" onClick={verifyIncomeProof} disabled={sending} style={{ width: "100%", marginTop: "10px" }}>
                      {verificationResult === "pending" ? "Querying chain..." : "Verify Proof On-Chain"}
                    </button>

                    {verificationResult === "valid" && (
                      <div className="tx-status-box success" style={{ marginTop: "14px", textAlign: "center" }}>
                        <span style={{ fontSize: "2rem", display: "block" }}>🛡️</span>
                        <strong style={{ fontSize: "1.1rem", color: "var(--sage)" }}>CRYPTOGRAPHICALLY VERIFIED!</strong>
                        <p style={{ marginTop: "4px" }}>The declared salary matches worker claim history records verified on-chain.</p>
                      </div>
                    )}
                    {verificationResult === "invalid" && (
                      <div className="tx-status-box error" style={{ marginTop: "14px", textAlign: "center" }}>
                        <span style={{ fontSize: "2rem", display: "block" }}>✕</span>
                        <strong style={{ fontSize: "1.1rem", color: "var(--danger)" }}>INVALID HASH OR PARAMETERS!</strong>
                        <p style={{ marginTop: "4px" }}>The details or proof hash did not match on-chain ledger records.</p>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* ⚙️ SETTINGS VIEW */}
              {activeSidebarView === "settings" && (
                <div className="view active">

                  {/* Page header */}
                  <div className="settings-page-header">
                    <div className="settings-page-icon">
                      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
                        <circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 00.3 1.9l.1.1a2 2 0 11-2.9 2.9l-.1-.1a1.7 1.7 0 00-1.9-.3 1.7 1.7 0 00-1 1.6V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1-1.6 1.7 1.7 0 00-1.9.3l-.1.1a2 2 0 11-2.9-2.9l.1-.1a1.7 1.7 0 00.3-1.9 1.7 1.7 0 00-1.6-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.6-1 1.7 1.7 0 00-.3-1.9l-.1-.1a2 2 0 112.9-2.9l.1.1a1.7 1.7 0 001.9.3H9A1.7 1.7 0 0010 3.6V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.6 1.7 1.7 0 001.9-.3l.1-.1a2 2 0 112.9 2.9l-.1.1a1.7 1.7 0 00-.3 1.9V9c.2.7.8 1.2 1.6 1.2H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z"/>
                      </svg>
                    </div>
                    <div>
                      <div className="settings-page-title">Workspace Settings</div>
                      <div className="settings-page-sub">Manage your network, preferences, and feedback submissions</div>
                    </div>
                  </div>

                  {/* ── Network Settings ── */}
                  <div className="settings-section">
                    <div className="settings-section-label">
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><path d="M12 8v4l3 3"/></svg>
                      Network
                    </div>

                    <div className="settings-card">
                      {/* Testnet row */}
                      <div className="scard-row">
                        <div className="scard-row-left">
                          <div className="scard-net-badge active">TESTNET</div>
                          <div className="scard-row-info">
                            <div className="scard-row-title">Stellar Testnet Node</div>
                            <div className="scard-row-desc">All payroll operations compile and broadcast to testnet RPC.</div>
                          </div>
                        </div>
                        <label className="scard-toggle">
                          <input type="checkbox" checked disabled />
                          <span className="scard-slider"></span>
                        </label>
                      </div>

                      <div className="scard-divider"/>

                      {/* Mainnet row */}
                      <div className="scard-row">
                        <div className="scard-row-left">
                          <div className="scard-net-badge locked">MAINNET</div>
                          <div className="scard-row-info">
                            <div className="scard-row-title">Stellar Mainnet Node</div>
                            <div className="scard-row-desc">
                              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ marginRight: "4px", verticalAlign: "middle" }}><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>
                              Locked until formal smart contract audits.
                            </div>
                          </div>
                        </div>
                        <label className="scard-toggle">
                          <input type="checkbox" disabled />
                          <span className="scard-slider"></span>
                        </label>
                      </div>
                    </div>
                  </div>

                  {/* ── Feedback Registry ── */}
                  <div className="settings-section">
                    <div className="settings-section-label">
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>
                      Feedback Registry
                    </div>

                    <div className="settings-card">
                      <div className="sfeedback-notice">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                        Connected pilot remote worker or employer reviews. Submit feedback below to add to the dynamic registry.
                      </div>

                      <form onSubmit={submitFeedback} className="sfeedback-form">
                        <div className="field-row">
                          <div className="field">
                            <label>Full Name</label>
                            <input type="text" placeholder="e.g. Priyanshu Sharma" value={feedbackName} onChange={(e) => setFeedbackName(e.target.value)} />
                          </div>
                          <div className="field">
                            <label>Workspace Role</label>
                            <select value={feedbackRole} onChange={(e) => setFeedbackRole(e.target.value)}>
                              <option value="Worker">👷 Worker</option>
                              <option value="Employer">💼 Employer</option>
                            </select>
                          </div>
                        </div>
                        <div className="field">
                          <label>Review / Feedback</label>
                          <textarea placeholder="Share your experience with ProofPay..." rows={3} value={feedbackText} onChange={(e) => setFeedbackText(e.target.value)} />
                        </div>
                        <div style={{ display: "flex", justifyContent: "flex-end" }}>
                          <button className="sfeedback-submit" type="submit">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
                            Submit Review
                          </button>
                        </div>
                      </form>

                      {/* Review list */}
                      {feedbackList.length > 0 && (
                        <div className="sfeedback-list">
                          <div className="sfeedback-list-label">Submitted Reviews ({feedbackList.length})</div>
                          {feedbackList.map((f, idx) => (
                            <div className="sfeedback-item" key={idx}>
                              <div className="sfeedback-item-top">
                                <div className="sfeedback-avatar">{f.name?.[0]?.toUpperCase() ?? "?"}</div>
                                <div>
                                  <div className="sfeedback-name">{f.name}</div>
                                  <div className="sfeedback-meta">
                                    <span className="sfeedback-role-pill">{f.role}</span>
                                    <span>{f.date}</span>
                                  </div>
                                </div>
                              </div>
                              <div className="sfeedback-text">"{f.text}"</div>
                              <div className="sfeedback-addr">
                                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>
                                {shorten(f.address, 8, 8)}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}

                      {feedbackList.length === 0 && (
                        <div className="sfeedback-empty">
                          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>
                          <span>No reviews yet — be the first to submit!</span>
                        </div>
                      )}
                    </div>
                  </div>

                </div>
              )}


            </div>
          </div>
        </div>
      )}

      {/* ── MODALS & DRAWER OVERLAYS ── */}
      
      {/* Deploy Vault Modal */}
      <div className={`modal-backdrop ${modalVaultOpen ? "open" : ""}`}>
        <div className="modal">
          <div className="modal-head">
            <h3>Deploy a new dynamic vault</h3>
            <button className="modal-close" onClick={() => setModalVaultOpen(false)}>&times;</button>
          </div>
          
          {vaultTxStatus.type === "pending" && (
            <div className="tx-status-box pending" style={{ marginBottom: "14px" }}>
              <div className="tsb-title">⏳ Deploying Vault</div>
              <p>{vaultTxStatus.message}</p>
            </div>
          )}
          {vaultTxStatus.type === "success" && (
            <div className="tx-status-box success" style={{ marginBottom: "14px" }}>
              <div className="tsb-title">✓ Deployed!</div>
              <p>{vaultTxStatus.message}</p>
            </div>
          )}
          {vaultTxStatus.type === "error" && (
            <div className="tx-status-box error" style={{ marginBottom: "14px" }}>
              <div className="tsb-title">✕ Deployment Failed</div>
              <p>{vaultTxStatus.message}</p>
            </div>
          )}

          <form onSubmit={(e) => { e.preventDefault(); void deployDynamicVault(); }}>
            <div className="field">
              <label>Currency Asset Standard</label>
              <select value={deployedTokenType} onChange={(e) => setDeployedTokenType(e.target.value as any)}>
                <option value="USDC">💵 USDC Stablecoin (Testnet)</option>
                <option value="CUSTOM">🔧 Custom SAC Token Address</option>
              </select>
            </div>

            {deployedTokenType === "CUSTOM" && (
              <div className="field">
                <label>Custom SAC Token Address (C...)</label>
                <input 
                  type="text" 
                  placeholder="C..." 
                  value={customTokenSAC} 
                  onChange={(e) => setCustomTokenSAC(e.target.value)} 
                />
              </div>
            )}

            <div className="modal-actions">
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setModalVaultOpen(false)}>Cancel</button>
              <button type="submit" className="btn btn-primary btn-sm" disabled={sending}>
                Deploy Vault
              </button>
            </div>
          </form>
        </div>
      </div>

      {/* Add Teammate Modal */}
      <div className={`modal-backdrop ${modalTeamOpen ? "open" : ""}`}>
        <div className="modal">
          <div className="modal-head">
            <h3>Add a teammate</h3>
            <button className="modal-close" onClick={() => setModalTeamOpen(false)}>&times;</button>
          </div>
          <form onSubmit={(e) => {
            e.preventDefault();
            const el = e.target as any;
            const name = el.ntName.value;
            const role = el.ntRole.value;
            const rate = el.ntRate.value;
            const asset = el.ntAsset.value;
            const vlt = el.ntVault.value;
            setTeamList(prev => [...prev, { name, role, rate: `${rate} ${asset}`, vault: vlt, status: "active" }]);
            setModalTeamOpen(false);
            el.reset();
            toast(`Added ${name} to teammate registry!`);
          }}>
            <div className="field">
              <label>Full Name</label>
              <input name="ntName" required placeholder="e.g. Sofia Marchetti" />
            </div>
            <div className="field">
              <label>Teammate Job Role</label>
              <input name="ntRole" required placeholder="e.g. Frontend developer" />
            </div>
            <div className="field-row">
              <div className="field">
                <label>Rate (per month)</label>
                <input name="ntRate" type="number" required placeholder="800" />
              </div>
              <div className="field">
                <label>Currency Asset</label>
                <select name="ntAsset">
                  <option value="USDC">USDC</option>
                </select>
              </div>
            </div>
              <div className="field">
                <label>Payroll Vault Allocation</label>
                <input name="ntVault" required placeholder="e.g. Engineering — Streaming" />
              </div>
            <div className="modal-actions">
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setModalTeamOpen(false)}>Cancel</button>
              <button type="submit" className="btn btn-primary btn-sm">Add teammate</button>
            </div>
          </form>
        </div>
      </div>

      {/* Vault Details Drawer */}
      <div className={`drawer-backdrop ${drawerOpen ? "open" : ""}`} onClick={() => setDrawerOpen(false)}></div>
      <div className={`drawer ${drawerOpen ? "open" : ""}`}>
        <button className="drawer-close" onClick={() => setDrawerOpen(false)}>&times;</button>
        {drawerVault && (
          <div>
            <span className="eyebrow" style={{ color: "var(--ink-muted)" }}>Vault details</span>
            <h2 className="display" style={{ fontSize: "1.45rem", margin: "12px 0 4px" }}>{drawerVault.name}</h2>
            <div className="mono" style={{ fontSize: "0.78rem", color: "var(--ink-mute)", marginBottom: "22px" }}>
              {drawerVault.type} · {drawerVault.asset}
            </div>
            <div className="cert-row">
              <span>Contract Address</span>
              <span className="mono">{shorten(drawerVault.id, 8, 8)}</span>
            </div>
            <div className="cert-row">
              <span>Current TVL Balance</span>
              <span>{drawerVault.balance.toLocaleString()} {drawerVault.asset}</span>
            </div>
            <div className="cert-row">
              <span>Status</span>
              <span style={{ textTransform: "capitalize" }}>{drawerVault.status}</span>
            </div>
            <div className="cert-row">
              <span>Allocated Workers</span>
              <span>{drawerVault.workers} worker(s)</span>
            </div>

            <div className="modal-actions" style={{ marginTop: "28px", justifyContent: "flex-start", gap: "10px" }}>
              <button className="btn btn-primary btn-sm" onClick={() => {
                if (drawerVault.id.startsWith("C")) {
                  setVaultId(drawerVault.id);
                  setUseCustomVault(true);
                  setDrawerOpen(false);
                  toast(`Routed active workspace to Vault: ${shorten(drawerVault.id)}`);
                  void loadVaultState();
                } else {
                  setUseCustomVault(false);
                  setDrawerOpen(false);
                  toast(`Routed active workspace to Default System Vault`);
                  void loadVaultState();
                }
              }}>
                Activate Route
              </button>
              <button className="btn btn-ghost btn-sm" onClick={() => {
                navigator.clipboard.writeText(drawerVault.id);
                toast("Vault Address Copied!");
              }}>
                Copy ID
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="toast-wrap" id="toast-wrap"></div>
    </>
  );
}
