import React, { useCallback, useEffect, useState, useRef, FormEvent } from "react";
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
  getScheduledAllocations,
  getStreamDetails,
  buildDepositScheduledXdr,
  buildClaimScheduledXdr,
  buildCreateStreamXdr,
  buildBatchCreateStreamXdr,
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
  buildAddUsdcTrustlineXdr,
  hasUsdcTrustline,
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

  // --- HASH ROUTING ---
  useEffect(() => {
    const handleHashChange = () => {
      const hash = window.location.hash;
      if (!hash) return;
      
      const parts = hash.replace("#/", "").split("/");
      if (parts.length === 2) {
        const [role, view] = parts;
        if (["employer", "worker", "verifier"].includes(role)) {
          setUserRole(role as "employer" | "worker" | "verifier");
        }
        if (["overview", "vaults", "team", "batch", "claims", "proofs", "portal", "settings", "history"].includes(view)) {
          setActiveSidebarView(view);
        }
      }
    };
    
    window.addEventListener("hashchange", handleHashChange);
    handleHashChange(); // process on mount
    return () => window.removeEventListener("hashchange", handleHashChange);
  }, []);

  // Teammates state
  const [teamList, setTeamList] = useState<{ name: string; role: string; rate: string; vault: string; status: string }[]>([]);

  // Dynamic Vault states
  const [customVaultId, setCustomVaultId] = useState<string | null>(null);
  const [isCheckingVault, setIsCheckingVault] = useState(true);
  const [useCustomVault, setUseCustomVault] = useState(false);
  const [vaultId, setVaultId] = useState(VAULT_CONTRACT_ID);
  const [vaultIdInput, setVaultIdInput] = useState("");
  const [myAvailableVaults, setMyAvailableVaults] = useState<{ address: string; hasStream: boolean; hasScheduled: boolean }[]>([]);

  // Send Payroll Panel states
  const [recipient, setRecipient] = useState("");
  const [batchRecipients, setBatchRecipients] = useState([{ address: "", amount: "1" }]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [amount, setAmount] = useState("1");
  const [memo, setMemo] = useState("ProofPay payroll test");
  const [txStatus, setTxStatus] = useState<TransactionStatus>({ type: "idle" });

  // Vault Payroll Panel states
  const [depositType, setDepositType] = useState<"batch_stream" | "instant" | "scheduled" | "streaming">("batch_stream");
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
  const [employerSendType, setEmployerSendType] = useState<"batch_stream" | "instant" | "scheduled">("batch_stream");

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
  const [roleSelectionModalOpen, setRoleSelectionModalOpen] = useState(false);
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
      void loadBalance();
      void loadVaultState();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [walletReady]);

  // Polling updates
  useEffect(() => {
    if (!walletReady) return;
    const interval = setInterval(() => {
      void loadBalance();
      void loadVaultState();
    }, 6000);
    return () => clearInterval(interval);
  }, [walletReady, loadBalance, loadVaultState]);

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

    const channels = [VAULT_CONTRACT_ID];
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
    setRoleSelectionModalOpen(true);
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

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (evt) => {
      const text = evt.target?.result as string;
      if (!text) return;
      const lines = text.split('\n');
      const parsed = lines.map(line => {
        const parts = line.split(',');
        if (parts.length >= 2) {
          return { address: parts[0].trim(), amount: parts[1].trim() };
        }
        return null;
      }).filter(Boolean) as { address: string; amount: string }[];
      
      if (parsed.length > 0) {
        setBatchRecipients(parsed);
      }
    };
    reader.readAsText(file);
    // Reset input so the same file can be uploaded again if needed
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

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
  async function claimFromVault(overrideType?: string) {
    if (sending) return;
    clearErrors();

    const ct = overrideType || claimType;

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
      title: "Checking USDC trustline",
      message: "Verifying your wallet can receive USDC tokens…",
    });

    try {
      // ── Ensure the worker has a USDC trustline before claiming ──
      const hasTrustline = await hasUsdcTrustline(stellarWallet.address);
      if (!hasTrustline) {
        setVaultTxStatus({
          type: "pending",
          title: "USDC Trustline Required",
          message: "Your wallet needs a USDC trustline. Please sign the trustline transaction…",
        });
        const trustXdr = await buildAddUsdcTrustlineXdr(stellarWallet.address);
        const signedTrustXdr = await stellarWallet.sign(trustXdr);
        await submitSignedTransaction(signedTrustXdr);
        toast("✓ USDC trustline added successfully!");
        setVaultTxStatus({
          type: "pending",
          title: "Trustline added",
          message: "Now proceeding to claim your payroll…",
        });
      }

      let xdr = "";

      if (ct === "instant") {
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
      } else if (ct === "scheduled") {
        const hasUnlocked = scheduledAllocations.some((item) => !item.locked);
        if (!hasUnlocked) {
          throw new Error("No unlocked scheduled allocations found for your wallet.");
        }
        xdr = await buildClaimScheduledXdr(stellarWallet.address, vaultId);
      } else if (ct === "streaming") {
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
      {roleSelectionModalOpen && (
        <div className="modal-backdrop open" style={{ zIndex: 9999 }}>
          <div className="modal" style={{ textAlign: "center", padding: "40px" }}>
            <h2 style={{ marginBottom: "10px" }}>How do you want to use ProofPay?</h2>
            <p style={{ color: "var(--ink-mute)", marginBottom: "30px" }}>Choose your workspace to continue.</p>
            <div style={{ display: "flex", gap: "16px", justifyContent: "center" }}>
              <button className="btn btn-primary" style={{ flex: 1, padding: "24px 16px", fontSize: "1.15rem", display: "flex", flexDirection: "column", alignItems: "center", gap: "12px", whiteSpace: "nowrap", borderRadius: "12px" }} onClick={async () => {
                setRoleSelectionModalOpen(false);
                setSending(true);
                clearErrors();
                try {
                  await stellarWallet.connect();
                  setUserRole("employer");
                  window.location.hash = "#/employer/overview";
                } catch(e) { console.error(e); } finally { setSending(false); }
              }}>
                <span style={{ fontSize: "2rem" }}>💼</span>
                I'm an Employer
              </button>
              <button className="btn btn-secondary" style={{ flex: 1, padding: "24px 16px", fontSize: "1.15rem", display: "flex", flexDirection: "column", alignItems: "center", gap: "12px", whiteSpace: "nowrap", borderRadius: "12px", background: "rgba(20,17,13,0.05)", color: "var(--ink-body)", border: "1px solid rgba(20,17,13,0.1)" }} onClick={async () => {
                setRoleSelectionModalOpen(false);
                setSending(true);
                clearErrors();
                try {
                  await stellarWallet.connect();
                  setUserRole("worker");
                  window.location.hash = "#/worker/claims";
                } catch(e) { console.error(e); } finally { setSending(false); }
              }}>
                <span style={{ fontSize: "2rem" }}>👷</span>
                I'm a Worker
              </button>
            </div>
          </div>
        </div>
      )}

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
                <div className="role-badge" style={{ display: "flex", alignItems: "center", gap: "8px", padding: "8px", background: "rgba(243,238,226,0.05)", borderRadius: "6px", fontSize: "0.85rem", color: "var(--ink-body)" }}>
                  <span>{userRole === "employer" ? "💼" : userRole === "worker" ? "👷" : "🔍"}</span>
                  <span style={{ fontWeight: 500 }}>
                    {userRole === "employer" ? "Employer Workspace" : userRole === "worker" ? "Worker Dashboard" : "Verifier Portal"}
                  </span>
                </div>
              </div>

              <div style={{ marginTop: "12px", display: "flex", flexDirection: "column", gap: "2px" }}>
                {userRole === "employer" && (
                    <>
                      <a href="#/employer/overview" className={`side-link ${activeSidebarView === "overview" ? "active" : ""}`}>
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><rect x="3" y="3" width="8" height="8" rx="1.5"/><rect x="13" y="3" width="8" height="5" rx="1.5"/><rect x="13" y="12" width="8" height="9" rx="1.5"/><rect x="3" y="14" width="8" height="7" rx="1.5"/></svg>
                        Send Payroll
                      </a>
                      <a href="#/employer/history" className={`side-link ${activeSidebarView === "history" ? "active" : ""}`}>
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                        Tx History
                      </a>
                    </>
                  )}

                {userRole === "worker" && (
                    <>
                      <a href="#/worker/claims" className={`side-link ${activeSidebarView === "claims" ? "active" : ""}`}>
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" /></svg>
                        Claim Salary
                      </a>
                      <a href="#/worker/history" className={`side-link ${activeSidebarView === "history" ? "active" : ""}`}>
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                        Tx History
                      </a>
                    </>
                  )}


                

                <a href={`#/${userRole}/settings`} className={`side-link ${activeSidebarView === "settings" ? "active" : ""}`}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 00.3 1.9l.1.1a2 2 0 11-2.9 2.9l-.1-.1a1.7 1.7 0 00-1.9-.3 1.7 1.7 0 00-1 1.6V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1-1.6 1.7 1.7 0 00-1.9.3l-.1.1a2 2 0 11-2.9-2.9l.1-.1a1.7 1.7 0 00.3-1.9 1.7 1.7 0 00-1.6-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.6-1 1.7 1.7 0 00-.3-1.9l-.1-.1a2 2 0 112.9-2.9l.1.1a1.7 1.7 0 001.9.3H9A1.7 1.7 0 0010 3.6V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.6 1.7 1.7 0 001.9-.3l.1-.1a2 2 0 112.9 2.9l-.1.1a1.7 1.7 0 00-.3 1.9V9c.2.7.8 1.2 1.6 1.2H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z"/></svg>
                  Settings
                </a>
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

            </div>

            <div className="page">

              {/* 📊 OVERVIEW VIEW */}
              {userRole === "employer" && activeSidebarView === "overview" && (
                  <div className="view active">
                    <div className="panel" style={{ maxWidth: "600px", margin: "0 auto" }}>
                      <div className="panel-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <h2>Send Payroll</h2>
                        <div style={{ display: "flex", gap: "8px", background: "var(--paper)", padding: "4px", borderRadius: "8px" }}>
                          <button 
                            className={`btn ${employerSendType === "batch_stream" ? "btn-primary" : "btn-ghost"}`} 
                            style={{ padding: "6px 12px", fontSize: "0.85rem" }}
                            onClick={() => { setEmployerSendType("batch_stream"); setDepositType("streaming"); }}
                          >
                            Streaming
                          </button>
                          <button 
                            className={`btn ${employerSendType === "instant" ? "btn-primary" : "btn-ghost"}`} 
                            style={{ padding: "6px 12px", fontSize: "0.85rem" }}
                            onClick={() => { setEmployerSendType("instant"); setDepositType("instant"); }}
                          >
                            Instant
                          </button>
                          <button 
                            className={`btn ${employerSendType === "scheduled" ? "btn-primary" : "btn-ghost"}`} 
                            style={{ padding: "6px 12px", fontSize: "0.85rem" }}
                            onClick={() => { setEmployerSendType("scheduled"); setDepositType("scheduled"); }}
                          >
                            Time-Locked
                          </button>
                        </div>
                      </div>
                      <div className="panel-body">
                        {employerSendType === "batch_stream" && (
                          <form onSubmit={async (e) => {
                            e.preventDefault();
                            if (!stellarWallet.address) return;
                            setSending(true);
                            setTxStatus({ type: "pending", title: "Sending Batch", message: "Awaiting wallet signature..." });
                            try {
                              const streams = batchRecipients.map(r => ({
                                worker: r.address,
                                amountXlm: r.amount
                              }));
                              const xdr = await buildBatchCreateStreamXdr(
                                stellarWallet.address,
                                vaultId,
                                streams,
                                Math.floor(Date.now() / 1000) - 10,
                                Math.floor(Date.now() / 1000) + 3600 * 24 * 30 // 1 month default stream for batch
                              );
                              const signed = await stellarWallet.sign(xdr);
                              setTxStatus({ type: "pending", title: "Confirming", message: "Submitting to Stellar..." });
                              const result = await submitSorobanTx(signed);
                              setTxStatus({ type: "success", title: "Batch Sent!", message: `Successfully started ${streams.length} streaming payrolls.`, hash: result.hash });
                              setBatchRecipients([{ address: "", amount: "1" }]);
                              await loadVaultState();
                            } catch (error) {
                              setTxStatus({ type: "error", title: "Failed", message: friendlyErr(error) });
                            } finally {
                              setSending(false);
                            }
                          }} style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
                            <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                              {batchRecipients.map((recip, idx) => (
                                <div key={idx} style={{ display: "flex", gap: "12px", alignItems: "flex-end", background: "var(--paper-panel)", padding: "16px", borderRadius: "12px", border: "1px solid var(--paper-line-strong)" }}>
                                  <div className="field" style={{ flex: 2, marginBottom: 0 }}>
                                    <label>Worker {idx + 1} Address</label>
                                    <input type="text" placeholder="G..." value={recip.address} onChange={e => {
                                      const updated = [...batchRecipients];
                                      updated[idx].address = e.target.value;
                                      setBatchRecipients(updated);
                                    }} required />
                                  </div>
                                  <div className="field" style={{ flex: 1, marginBottom: 0 }}>
                                    <label>Amount (USDC)</label>
                                    <input type="number" step="0.01" placeholder="100.00" value={recip.amount} onChange={e => {
                                      const updated = [...batchRecipients];
                                      updated[idx].amount = e.target.value;
                                      setBatchRecipients(updated);
                                    }} required />
                                  </div>
                                  {batchRecipients.length > 1 && (
                                    <button type="button" onClick={() => {
                                      setBatchRecipients(batchRecipients.filter((_, i) => i !== idx));
                                    }} style={{ background: "rgba(235, 87, 87, 0.1)", color: "#eb5757", border: "none", padding: "10px", borderRadius: "8px", cursor: "pointer", height: "40px", display: "flex", alignItems: "center", justifyContent: "center" }}>
                                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
                                    </button>
                                  )}
                                </div>
                              ))}
                            </div>
                            <div style={{ display: "flex", gap: "12px", alignItems: "center", alignSelf: "flex-start" }}>
                              <button type="button" className="btn btn-ghost" style={{ fontSize: "0.9rem", display: "flex", alignItems: "center", gap: "6px" }} onClick={() => setBatchRecipients([...batchRecipients, { address: "", amount: "1" }])}>
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
                                Add Worker
                              </button>
                              <button type="button" className="btn btn-ghost" style={{ fontSize: "0.9rem", display: "flex", alignItems: "center", gap: "6px", color: "var(--vault)" }} onClick={() => fileInputRef.current?.click()}>
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="17 8 12 3 7 8"></polyline><line x1="12" y1="3" x2="12" y2="15"></line></svg>
                                Upload CSV
                              </button>
                              <input type="file" accept=".csv" ref={fileInputRef} style={{ display: "none" }} onChange={handleFileUpload} />
                            </div>
                            
                            {txStatus.type !== "idle" && (
                              <div className={`tx-status-box ${txStatus.type}`} style={{ marginTop: "12px", marginBottom: "4px", padding: "12px", borderRadius: "8px", background: txStatus.type === 'error' ? 'rgba(235, 87, 87, 0.1)' : txStatus.type === 'success' ? 'rgba(39, 174, 96, 0.1)' : 'var(--paper-panel)' }}>
                                <div style={{ fontWeight: 600, color: txStatus.type === 'error' ? '#eb5757' : txStatus.type === 'success' ? '#27ae60' : 'var(--ink)' }}>{txStatus.title}</div>
                                <div style={{ fontSize: "0.9rem", color: txStatus.type === 'error' ? '#eb5757' : 'var(--ink-mute)', marginTop: "4px" }}>
                                  {txStatus.message}
                                </div>
                                {txStatus.type === 'success' && txStatus.hash && (
                                  <a
                                    href={`https://stellar.expert/explorer/testnet/tx/${txStatus.hash}`}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    style={{ fontSize: "0.85rem", color: "#27ae60", textDecoration: "underline", display: "inline-block", marginTop: "6px" }}
                                  >
                                    View transaction on Stellar Expert ↗
                                  </a>
                                )}
                              </div>

                            )}

                            <button type="submit" className="btn btn-primary" style={{ marginTop: "8px", padding: "16px", fontSize: "1.05rem" }} disabled={sending}>
                              {sending ? "Processing Batch..." : `Fund ${batchRecipients.length} Streaming Payment${batchRecipients.length > 1 ? "s" : ""}`}
                            </button>
                          </form>
                        )}

                        {(employerSendType === "instant" || employerSendType === "scheduled") && (
                          <form onSubmit={depositToVault} style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
                            <div className="field">
                              <label>Worker Address</label>
                              <input 
                                type="text" 
                                placeholder="G..." 
                                value={vaultWorker}
                                onChange={e => setVaultWorker(e.target.value)} 
                                required 
                              />
                            </div>
                            <div className="field">
                              <label>Amount (USDC)</label>
                              <input 
                                type="number" 
                                step="0.01" 
                                placeholder="100.00" 
                                value={vaultAmount}
                                onChange={e => setVaultAmount(e.target.value)} 
                                required 
                              />
                            </div>
                            
                            {employerSendType === "scheduled" && (
                              <div className="field">
                                <label>Release Date & Time</label>
                                <input 
                                  type="datetime-local" 
                                  value={releaseTime}
                                  onChange={e => setReleaseTime(e.target.value)} 
                                  required 
                                />
                                <div style={{ fontSize: "0.8rem", color: "var(--ink-mute)", marginTop: "4px" }}>
                                  Funds will be locked and unclaimable until this exact time.
                                </div>
                              </div>
                            )}

                            {vaultTxStatus.type !== "idle" && (
                              <div className={`tx-status-box ${vaultTxStatus.type}`} style={{ padding: "12px", borderRadius: "8px", background: vaultTxStatus.type === 'error' ? 'rgba(235, 87, 87, 0.1)' : vaultTxStatus.type === 'success' ? 'rgba(39, 174, 96, 0.1)' : 'var(--paper-panel)' }}>
                                <div style={{ fontWeight: 600, color: vaultTxStatus.type === 'error' ? '#eb5757' : vaultTxStatus.type === 'success' ? '#27ae60' : 'var(--ink)' }}>{vaultTxStatus.title}</div>
                                <div style={{ fontSize: "0.9rem", color: vaultTxStatus.type === 'error' ? '#eb5757' : 'var(--ink-mute)', marginTop: "4px" }}>
                                  {vaultTxStatus.message}
                                </div>
                                {vaultTxStatus.type === 'success' && vaultTxStatus.hash && (
                                  <a
                                    href={`https://stellar.expert/explorer/testnet/tx/${vaultTxStatus.hash}`}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    style={{ fontSize: "0.85rem", color: "#27ae60", textDecoration: "underline", display: "inline-block", marginTop: "6px" }}
                                  >
                                    View transaction on Stellar Expert ↗
                                  </a>
                                )}
                              </div>
                            )}

                            <button type="submit" className="btn btn-primary" style={{ marginTop: "8px", padding: "16px", fontSize: "1.05rem" }} disabled={sending}>
                              {sending ? "Processing..." : `Send ${employerSendType === "instant" ? "Instant" : "Time-Locked"} Payment`}
                            </button>
                          </form>
                        )}
                      </div>
                    </div>
                  </div>
                )}
              {/* 🏛️ VAULTS VIEW */}
              {userRole === "employer" && activeSidebarView === "vaults" && (
                <div className="view active">
                  <div className="panel">
                    <div className="panel-head">
                      <h3>ProofPay Global Vault</h3>
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
                      <div className="notice info" style={{ margin: 0 }}>
                        ProofPay uses a single global shared vault contract on Stellar Testnet. All batch streaming payments are routed through it automatically.
                      </div>
                      <div style={{ background: "var(--paper-panel)", borderRadius: "12px", padding: "16px", border: "1px solid var(--paper-line-strong)" }}>
                        <div style={{ fontSize: "0.78rem", color: "var(--ink-mute)", marginBottom: "6px", textTransform: "uppercase", letterSpacing: "0.05em" }}>Active Vault Contract</div>
                        <div style={{ fontFamily: "monospace", fontSize: "0.9rem", wordBreak: "break-all", color: "var(--vault)" }}>{vaultId}</div>
                        <div style={{ marginTop: "12px", display: "flex", gap: "10px" }}>
                          <a
                            href={`https://stellar.expert/explorer/testnet/contract/${vaultId}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="btn btn-ghost btn-sm"
                            style={{ fontSize: "0.85rem" }}
                          >
                            View on Stellar Expert ↗
                          </a>
                          <button
                            className="btn btn-ghost btn-sm"
                            style={{ fontSize: "0.85rem" }}
                            onClick={() => { navigator.clipboard.writeText(vaultId); toast("Contract address copied!"); }}
                          >
                            Copy Address
                          </button>
                        </div>
                      </div>
                      <div className="vault-grid">
                        {activeVaultsData.map((v, idx) => (
                          <div className="vcard" key={idx}>
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
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>
              )}

                {userRole === "worker" && activeSidebarView === "claims" && (
                  <div className="view active">
                  {/* Tx status banner */}
                  {vaultTxStatus.type === "pending" && (

                    <div className="tx-status-box pending" style={{ marginBottom: "14px" }}>
                      <div className="tsb-title">⏳ Processing Claim…</div>
                      <p>{vaultTxStatus.message}</p>
                    </div>
                  )}
                  {vaultTxStatus.type === "success" && (
                    <div className="tx-status-box success" style={{ marginBottom: "14px" }}>
                      <div className="tsb-title">✓ Claim Confirmed!</div>
                      <p>{vaultTxStatus.message}</p>
                      {vaultTxStatus.hash && (
                        <a href={`https://stellar.expert/explorer/testnet/tx/${vaultTxStatus.hash}`} target="_blank" rel="noopener noreferrer"
                          style={{ fontSize: "0.85rem", color: "#27ae60", textDecoration: "underline", display: "inline-block", marginTop: "6px" }}>
                          View on Stellar Expert ↗
                        </a>
                      )}
                    </div>
                  )}
                  {vaultTxStatus.type === "error" && (
                    <div className="tx-status-box error" style={{ marginBottom: "14px" }}>
                      <div className="tsb-title">✕ Claim Failed</div>
                      <p>{vaultTxStatus.message}</p>
                    </div>
                  )}

                  <div style={{ display: "grid", gap: "16px" }}>

                    {/* ── STREAMING PAYROLL (Primary: what employer sends via batch) ── */}
                    <div className="panel">
                      <div className="panel-head">
                        <h3>🔴 Live Streaming Payroll</h3>
                        <span style={{ fontSize: "0.75rem", padding: "2px 10px", borderRadius: "20px",
                          background: streamDetails && liveStreamClaimable > 0n ? "rgba(39,174,96,0.15)" : "rgba(0,0,0,0.08)",
                          color: streamDetails && liveStreamClaimable > 0n ? "#27ae60" : "var(--ink-mute)" }}>
                          {streamDetails && liveStreamClaimable > 0n ? "● CLAIMABLE NOW" : "No active stream"}
                        </span>
                      </div>
                      {streamDetails ? (
                        <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
                            <div style={{ background: "rgba(39,174,96,0.08)", borderRadius: "12px", padding: "16px", border: "1px solid rgba(39,174,96,0.2)" }}>
                              <div style={{ fontSize: "0.72rem", color: "var(--ink-mute)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: "6px" }}>Claimable Now</div>
                              <div style={{ fontSize: "1.5rem", fontWeight: 700, color: "#27ae60", fontFamily: "monospace" }}>{stroopsToXlm(liveStreamClaimable)}</div>
                              <div style={{ fontSize: "0.8rem", color: "var(--ink-mute)" }}>{vaultTokenSymbol}</div>
                            </div>
                            <div style={{ background: "var(--paper-panel)", borderRadius: "12px", padding: "16px", border: "1px solid var(--paper-line-strong)" }}>
                              <div style={{ fontSize: "0.72rem", color: "var(--ink-mute)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: "6px" }}>Total Stream</div>
                              <div style={{ fontSize: "1.5rem", fontWeight: 700, fontFamily: "monospace" }}>{stroopsToXlm(streamDetails.totalAmount)}</div>
                              <div style={{ fontSize: "0.8rem", color: "var(--ink-mute)" }}>{vaultTokenSymbol}</div>
                            </div>
                          </div>
                          <div>
                            <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.8rem", color: "var(--ink-mute)", marginBottom: "6px" }}>
                              <span>Stream progress</span>
                              <span style={{ fontWeight: 600, color: "var(--vault)" }}>{streamProgress}%</span>
                            </div>
                            <div className="progress-container">
                              <div className="progress-bar" style={{ width: `${streamProgress}%` }}></div>
                            </div>
                            <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.75rem", color: "var(--ink-mute)", marginTop: "4px" }}>
                              <span>Started {new Date(Number(streamDetails.startTime) * 1000).toLocaleDateString()}</span>
                              <span>Ends {new Date(Number(streamDetails.endTime) * 1000).toLocaleDateString()}</span>
                            </div>
                          </div>
                          <button className="btn btn-primary" onClick={() => claimFromVault("streaming")}
                            disabled={sending || liveStreamClaimable <= 0n}
                            style={{ width: "100%", padding: "14px", fontSize: "1rem" }}>
                            {sending ? "Claiming…" : liveStreamClaimable > 0n
                              ? `Claim ${stroopsToXlm(liveStreamClaimable)} ${vaultTokenSymbol}`
                              : "Nothing to claim yet — accruing…"}
                          </button>
                        </div>
                      ) : (
                        <div style={{ textAlign: "center", padding: "32px 16px", color: "var(--ink-mute)" }}>
                          <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.3" style={{ marginBottom: "12px", opacity: 0.4 }}>
                            <circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>
                          </svg>
                          <div style={{ fontStyle: "italic" }}>No active streaming payroll found for your wallet.</div>
                          <div style={{ fontSize: "0.8rem", marginTop: "6px" }}>Ask your employer to fund a stream to your address.</div>
                        </div>
                      )}
                    </div>

                    {/* ── INSTANT / STANDARD ALLOCATION ── */}
                    <div className="panel">
                      <div className="panel-head">
                        <h3>⚡ Standard Allocation</h3>
                        <span style={{ fontSize: "0.75rem", padding: "2px 10px", borderRadius: "20px",
                          background: workerAllocation > 0n ? "rgba(39,174,96,0.15)" : "rgba(0,0,0,0.08)",
                          color: workerAllocation > 0n ? "#27ae60" : "var(--ink-mute)" }}>
                          {workerAllocation > 0n ? `${stroopsToXlm(workerAllocation)} ${vaultTokenSymbol} available` : "Nothing available"}
                        </span>
                      </div>
                      <div style={{ fontSize: "0.88rem", color: "var(--ink-mute)", marginBottom: "12px" }}>
                        Instant one-off allocations deposited directly by your employer — claimable immediately with no waiting period.
                      </div>
                      <button className="btn btn-primary" onClick={() => claimFromVault("instant")}
                        disabled={sending || workerAllocation <= 0n} style={{ width: "100%" }}>
                        {workerAllocation > 0n ? `Claim ${stroopsToXlm(workerAllocation)} ${vaultTokenSymbol}` : "No standard allocation"}
                      </button>
                    </div>

                    {/* ── SCHEDULED / TIME-LOCKED ── */}
                    <div className="panel">
                      <div className="panel-head">
                        <h3>🔒 Time-Locked Payroll</h3>
                        <span style={{ fontSize: "0.75rem", padding: "2px 10px", borderRadius: "20px",
                          background: scheduledAllocations.some(s => !s.locked) ? "rgba(39,174,96,0.15)" : "rgba(0,0,0,0.08)",
                          color: scheduledAllocations.some(s => !s.locked) ? "#27ae60" : "var(--ink-mute)" }}>
                          {scheduledAllocations.some(s => !s.locked) ? "● Unlocked & Claimable" : scheduledAllocations.length > 0 ? "🔒 Still Locked" : "None"}
                        </span>
                      </div>
                      {scheduledAllocations.length === 0 ? (
                        <div style={{ fontSize: "0.88rem", color: "var(--ink-mute)", padding: "8px 0" }}>
                          No time-locked allocations found for your address.
                        </div>
                      ) : (
                        <div style={{ display: "grid", gap: "8px", marginBottom: "12px" }}>
                          {scheduledAllocations.map((item, idx) => (
                            <div key={idx} style={{ display: "flex", justifyContent: "space-between", alignItems: "center",
                              background: item.locked ? "rgba(255,180,0,0.07)" : "rgba(39,174,96,0.07)",
                              border: `1px solid ${item.locked ? "rgba(255,180,0,0.2)" : "rgba(39,174,96,0.2)"}`,
                              borderRadius: "10px", padding: "10px 14px" }}>
                              <div>
                                <div style={{ fontSize: "0.9rem", fontWeight: 600 }}>{stroopsToXlm(item.amount)} {vaultTokenSymbol}</div>
                                <div style={{ fontSize: "0.75rem", color: "var(--ink-mute)" }}>Unlocks: {item.friendlyReleaseTime}</div>
                              </div>
                              <span style={{ fontSize: "0.78rem", fontWeight: 600, color: item.locked ? "var(--gold)" : "#27ae60" }}>
                                {item.locked ? "🔒 Locked" : "✓ Claimable"}
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                      <button className="btn btn-primary" onClick={() => claimFromVault("scheduled")}
                        disabled={sending || !scheduledAllocations.some(s => !s.locked)} style={{ width: "100%" }}>
                        Claim Unlocked Allocations
                      </button>
                    </div>

                  </div>
                  </div>
                )}


              {/* 📜 TX HISTORY VIEW (Shared by Worker & Employer) */}
              {(userRole === "worker" || userRole === "employer") && activeSidebarView === "history" && (
                <div className="view active">
                  <div className="panel">
                    <div className="panel-head">
                      <h3>Transaction History</h3>
                    </div>
                    <div style={{ marginBottom: "16px", fontSize: "0.88rem", color: "var(--ink-mute)" }}>
                      Live on-chain activity from the ProofPay vault contract streamed in real time.
                    </div>

                    {activityFeed.length === 0 ? (
                      <div style={{ textAlign: "center", padding: "48px 16px", color: "var(--ink-mute)" }}>
                        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.3" style={{ marginBottom: "14px", opacity: 0.35 }}>
                          <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
                        </svg>
                        <div style={{ fontStyle: "italic" }}>No transactions recorded yet in this session.</div>
                        <div style={{ fontSize: "0.8rem", marginTop: "6px" }}>Transactions appear here as they happen on-chain.</div>
                      </div>
                    ) : (
                      <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                        {activityFeed.slice().reverse().map((event, idx) => {
                          const isClaim = event.type === "PayrollClaimed" || event.type === "ScheduledClaimed" || event.type === "StreamClaimed";
                          const isDeposit = event.type === "PayrollDeposited" || event.type === "ScheduledDeposited";
                          const icon = isClaim ? "💸" : isDeposit ? "📥" : "⚡";
                          const iconBg = isClaim ? "rgba(39,174,96,0.15)" : "rgba(108,92,231,0.15)";
                          const amountColor = isClaim ? "#27ae60" : "var(--vault)";
                          const label = event.type.replace(/([A-Z])/g, ' $1').trim();
                          return (
                            <div key={idx} style={{
                              display: "flex", alignItems: "flex-start", gap: "12px",
                              background: "var(--paper-panel)", borderRadius: "12px", padding: "14px 16px",
                              border: "1px solid var(--paper-line-strong)"
                            }}>
                              <div style={{
                                width: "36px", height: "36px", borderRadius: "50%", flexShrink: 0,
                                background: iconBg,
                                display: "flex", alignItems: "center", justifyContent: "center", fontSize: "1rem"
                              }}>
                                {icon}
                              </div>
                              <div style={{ flex: 1, minWidth: 0 }}>
                                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "8px" }}>
                                  <div style={{ fontWeight: 600, fontSize: "0.9rem" }}>{label}</div>
                                  <div style={{ fontSize: "0.78rem", color: "var(--ink-mute)", whiteSpace: "nowrap" }}>
                                    Ledger #{event.ledger}
                                  </div>
                                </div>
                                <div style={{ fontSize: "0.82rem", color: "var(--ink-mute)", marginTop: "2px", fontFamily: "monospace" }}>
                                  {shorten(event.worker, 8, 8)}
                                </div>
                                <div style={{ fontSize: "0.9rem", fontWeight: 600, color: amountColor, marginTop: "4px" }}>
                                  {isClaim ? "+" : "-"}{stroopsToXlm(event.amount)} {vaultTokenSymbol}
                                </div>
                                <a href={`https://stellar.expert/explorer/testnet/tx/${event.txHash}`}
                                  target="_blank" rel="noopener noreferrer"
                                  style={{ fontSize: "0.78rem", color: "var(--vault)", textDecoration: "underline", display: "inline-block", marginTop: "4px" }}>
                                  {shorten(event.txHash, 8, 8)} ↗
                                </a>
                              </div>
                            </div>
                          );
                        })}

                      </div>
                    )}
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
                  setCustomVaultId(drawerVault.id);
                  setUseCustomVault(true);
                  setDrawerOpen(false);
                  toast(`Routed active workspace to Vault: ${shorten(drawerVault.id)}`);
                  void loadVaultState();
                } else {
                  setVaultId(VAULT_CONTRACT_ID);
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

      <a href="mailto:feedback@proofpay.app?subject=ProofPay Feedback" className="feedback-float-btn" target="_blank" rel="noreferrer">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="20" height="20">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
        </svg>
        Feedback
      </a>

      <div className="toast-wrap" id="toast-wrap"></div>
    </>
  );
}
