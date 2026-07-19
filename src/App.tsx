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
  const [activeSidebarView, setActiveSidebarView] = useState("overview");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [modalVaultOpen, setModalVaultOpen] = useState(false);
  const [modalTeamOpen, setModalTeamOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerVault, setDrawerVault] = useState<any>(null);

  // Teammates state
  const [teamList, setTeamList] = useState([
    { name: "Amara Nwosu", role: "Backend engineer", rate: "1,200 XLM", vault: "Engineering — Streaming", status: "active" },
    { name: "Diego Fuentes", role: "Frontend engineer", rate: "1,100 XLM", vault: "Engineering — Streaming", status: "active" },
    { name: "Lin Wei", role: "Product designer", rate: "950 XLM", vault: "Design — Streaming", status: "active" },
    { name: "Priya Raman", role: "Product designer", rate: "900 XLM", vault: "Design — Streaming", status: "active" },
    { name: "Tomás Silva", role: "Smart contract engineer", rate: "1,400 XLM", vault: "Engineering — Streaming", status: "active" },
    { name: "Kwame Boateng", role: "Contractor — audit", rate: "2,000 USDC", vault: "Contractors — Scheduled", status: "active" },
  ]);

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
  const sparklinePoints = "10 150 Q 80 120 150 100 T 290 50 T 370 20";

  // Resolved list of vaults
  const activeVaultsData = [
    { id: vaultId, name: useCustomVault ? "My Deployed Vault" : "Default ProofPay Vault", type: "Streaming", asset: vaultTokenSymbol, balance: Number(stroopsToXlm(vaultTotal)), status: "active", rate: 1.2, workers: myAvailableVaults.length || 1 },
    { id: "VAULT-007", name: "Design payroll", type: "Streaming", asset: "XLM", balance: 9210.0, status: "active", rate: 0.6, workers: 2 },
    { id: "VAULT-011", name: "Contractors — Q3", type: "Scheduled", asset: "USDC", balance: 6500.0, status: "locked", rate: 0.0, workers: 3 },
    { id: "VAULT-013", name: "Founders vesting", type: "Scheduled", asset: "XLM", balance: 12000.0, status: "locked", rate: 0.0, workers: 2 },
    { id: "VAULT-009", name: "Support payroll", type: "Streaming", asset: "USDC", balance: 689.5, status: "paused", rate: 0.35, workers: 1 },
  ];

  return (
    <>
      {/* ══ LANDING PAGE ══ */}
      {!walletReady && (
        <div id="view-landing">
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
                <button id="btn-connect" onClick={connectWallet} disabled={sending}>
                  {sending ? <span className="spin">↻</span> : "Connect Wallet"}
                </button>
              </div>
            </div>
          </nav>

          <header className="hero">
            <div className="container hero-inner">
              <div>
                <div className="hero-badge">
                  <span className="dot"></span>
                  <span>Stellar Testnet Pilot</span>
                </div>
                <h1 className="display">
                  Decentralized payroll that <em>streams</em> second by second.
                </h1>
                <p className="hero-sub">
                  Secure on-chain vaults, scheduled lockups, and privacy-preserving salary verification built on Stellar & Soroban.
                </p>
                <div className="hero-actions">
                  <button className="btn-primary" onClick={connectWallet} disabled={sending}>
                    Launch Dashboard →
                  </button>
                  <a href="#how-it-works" className="btn-outline">How it works</a>
                </div>
              </div>
              <div className="hero-card">
                <div className="card-header">
                  <span className="card-title">Live Vault Status</span>
                  <div className="status-chip connected">
                    <span className="dot"></span>
                    Ready
                  </div>
                </div>
                <div className="balance-block">
                  <div className="balance-label">Total Value Locked</div>
                  <div className="balance-amount">
                    48,920<span className="balance-unit">XLM</span>
                  </div>
                </div>
                <div style={{ marginTop: "14px" }}>
                  <div className="tx-row">
                    <div className="tx-info">
                      <div className="tx-icon">💸</div>
                      <div>
                        <div className="tx-label">Salary Stream</div>
                        <div className="tx-sub">Engineering Vault</div>
                      </div>
                    </div>
                    <div className="tx-amt">+1.20 XLM/m</div>
                  </div>
                  <div className="tx-row">
                    <div className="tx-info">
                      <div className="tx-icon">🔒</div>
                      <div>
                        <div className="tx-label">Contractor Q3</div>
                        <div className="tx-sub">Time Locked</div>
                      </div>
                    </div>
                    <div className="tx-amt">6,500 USDC</div>
                  </div>
                </div>
              </div>
            </div>
          </header>

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

          <section className="process-section" id="how-it-works">
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
                <label style={{ fontSize: "0.65rem", color: "rgba(243, 238, 226, 0.4)", textTransform: "uppercase", fontWeight: "bold", display: "block", marginBottom: "4px" }}>Workspace Role</label>
                <div className="sidebar-select-container">
                  <select 
                    value={userRole} 
                    onChange={(e) => { 
                      const role = e.target.value as "employer" | "worker" | "verifier";
                      setUserRole(role); 
                      clearErrors();
                      if (role === "employer") setActiveSidebarView("overview");
                      else if (role === "worker") setActiveSidebarView("claims");
                      else if (role === "verifier") setActiveSidebarView("portal");
                    }}
                    className="sidebar-select"
                  >
                    <option value="employer">💼 Employer Workspace</option>
                    <option value="worker">👷 Worker Dashboard</option>
                    <option value="verifier">🔍 Verifier Portal</option>
                  </select>
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
              <a href="#" onClick={(e) => { e.preventDefault(); disconnectWallet(); }} style={{ display: "block", fontSize: "0.76rem", color: "rgba(243,238,226,.5)", marginBottom: "12px" }}>
                ← Leave Dashboard
              </a>
              <div className="wallet-pill">
                <span className="wallet-dot"></span>
                <div className="wallet-meta">
                  <span className="wallet-addr">{shorten(stellarWallet.address, 4, 4)}</span>
                  <span className="wallet-net">Stellar · Testnet</span>
                </div>
              </div>
            </div>
          </aside>

          <div className="main-workspace">
            <div className="topbar">
              <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                <button className="btn-ghost btn btn-sm" onClick={() => setSidebarOpen(!sidebarOpen)} style={{ display: "inline-flex" }}>☰</button>
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
                    <table>
                      <thead>
                        <tr>
                          <th>Name</th>
                          <th>Role</th>
                          <th>Allocation Rate</th>
                          <th>Asset Code</th>
                          <th>Target Vault</th>
                          <th>Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {teamList.map((t, idx) => (
                          <tr key={idx}>
                            <td><strong>{t.name}</strong></td>
                            <td>{t.role}</td>
                            <td className="mono">{t.rate}</td>
                            <td className="mono">{t.rate.split(" ")[1] || "XLM"}</td>
                            <td>{t.vault}</td>
                            <td><span className="pill active">{t.status}</span></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
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
                          
                          <div style={{ display: "flex", gap: "10px", marginBottom: "14px" }}>
                            <input 
                              type="number" 
                              placeholder="Enter Batch ID (e.g. 1)" 
                              value={claimBatchIdInput}
                              onChange={(e) => setClaimBatchIdInput(e.target.value)}
                            />
                            <button className="btn btn-ghost" onClick={queryBatchPayout} disabled={sending}>
                              Query Batch
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
                  <div className="panel">
                    <div className="panel-head"><h3>Network Settings</h3></div>
                    <div className="settings-row">
                      <div>
                        <div className="t">Stellar Testnet Node</div>
                        <div className="d">All payroll operations compile and broadcast to testnet RPC.</div>
                      </div>
                      <label className="switch">
                        <input type="checkbox" checked disabled />
                        <span className="slider"></span>
                      </label>
                    </div>
                    <div className="settings-row">
                      <div>
                        <div className="t">Stellar Mainnet Node</div>
                        <div className="d">Locked until formal smart contract audits.</div>
                      </div>
                      <label className="switch">
                        <input type="checkbox" disabled />
                        <span className="slider"></span>
                      </label>
                    </div>
                  </div>

                  <div className="panel">
                    <div className="panel-head"><h3>Worker Onboarding Feedback Registry</h3></div>
                    <div className="notice info" style={{ margin: 0, marginBottom: "14px" }}>
                      Connected pilot remote worker or employer reviews. Submit feedback below to add to the dynamic registry!
                    </div>

                    <form onSubmit={submitFeedback} style={{ display: "grid", gap: "10px", marginBottom: "20px" }}>
                      <div className="field-row">
                        <div className="field">
                          <label>Full Name</label>
                          <input type="text" placeholder="e.g. Priyanshu Sharma" value={feedbackName} onChange={(e) => setFeedbackName(e.target.value)} />
                        </div>
                        <div className="field">
                          <label>Workspace Role</label>
                          <select value={feedbackRole} onChange={(e) => setFeedbackRole(e.target.value)}>
                            <option value="Worker">Worker</option>
                            <option value="Employer">Employer</option>
                          </select>
                        </div>
                      </div>
                      <div className="field">
                        <label>Review / Feedback</label>
                        <textarea placeholder="Write feedback notes..." rows={2} value={feedbackText} onChange={(e) => setFeedbackText(e.target.value)} />
                      </div>
                      <button className="btn btn-ghost" type="submit" style={{ justifySelf: "start" }}>
                        Submit Review
                      </button>
                    </form>

                    <div className="registry-list">
                      {feedbackList.length === 0 ? (
                        <div style={{ padding: "14px", fontStyle: "italic", color: "var(--ink-mute)", textAlign: "center" }}>
                          No reviews submitted yet. Use the form above to add a dynamic entry!
                        </div>
                      ) : (
                        feedbackList.map((f, idx) => (
                          <div className="registry-item" key={idx}>
                            <div className="registry-header">
                              <strong>{f.name} ({f.role})</strong>
                              <span>{f.date}</span>
                            </div>
                            <div className="registry-text">"{f.text}"</div>
                            <div style={{ fontSize: "0.7rem", color: "var(--ink-mute)", marginTop: "4px" }}>
                              Sender Address: {shorten(f.address, 8, 8)}
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                  </div>

                  <div className="panel">
                    <div className="panel-head"><h3>Account Operations</h3></div>
                    <div className="settings-row">
                      <div>
                        <div className="t">Disconnect Stellar Wallet</div>
                        <div className="d">Ends active session. You'll need to reconnect using Freighter to authorize payrolls.</div>
                      </div>
                      <button className="btn btn-danger-ghost btn-sm" onClick={disconnectWallet}>
                        Disconnect
                      </button>
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
                <option value="XLM">Native XLM Token</option>
                <option value="USDC">Testnet USDC Token Stablecoin</option>
                <option value="CUSTOM">Custom SAC Token Address</option>
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
                  <option value="XLM">XLM</option>
                  <option value="USDC">USDC</option>
                </select>
              </div>
            </div>
            <div className="field">
              <label>Payroll Vault Allocation</label>
              <select name="ntVault">
                <option value="Engineering — Streaming">Engineering — Streaming</option>
                <option value="Design — Streaming">Design — Streaming</option>
                <option value="Contractors — Scheduled">Contractors — Scheduled</option>
              </select>
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
