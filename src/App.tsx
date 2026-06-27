import { useCallback, useEffect, useState, FormEvent } from "react";
import { useStellarWallet, WalletError, WalletErrorType } from "./hooks/useStellarWallet";
import * as StellarSdk from "@stellar/stellar-sdk";
import {
  buildPayrollPaymentXdr,
  getNativeBalance,
  isTestnetNetwork,
  NETWORK_PASSPHRASE,
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
  buildDeployVaultXdr,
  getScheduledAllocations,
  getStreamDetails,
  getStreamClaimable,
  buildDepositScheduledXdr,
  buildClaimScheduledXdr,
  buildCreateStreamXdr,
  buildClaimStreamXdr,
  VaultEvent,
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
  const [activePanel, setActivePanel] = useState<"send" | "vault">("send");
  const [vaultTab, setVaultTab] = useState<"deposit" | "claim">("deposit");

  // Dynamic Vault states
  const [customVaultId, setCustomVaultId] = useState<string | null>(null);
  const [useCustomVault, setUseCustomVault] = useState(false);
  const [vaultId, setVaultId] = useState(VAULT_CONTRACT_ID);

  // Send Payroll Panel states
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("1");
  const [memo, setMemo] = useState("ProofPay payroll test");
  const [txStatus, setTxStatus] = useState<TransactionStatus>({ type: "idle" });

  // Vault Payroll Panel states
  const [depositType, setDepositType] = useState<"instant" | "scheduled" | "streaming">("instant");
  const [claimType, setClaimType] = useState<"instant" | "scheduled" | "streaming">("instant");
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

  // Load native balance
  const loadBalance = useCallback(async () => {
    if (!stellarWallet.address) return;
    try {
      const nextBalance = await getNativeBalance(stellarWallet.address);
      setBalance(nextBalance);
      setBalanceMessage("Updated from Testnet Horizon");
    } catch (error) {
      const msg =
        (error as any)?.response?.status === 404
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
    }
  }, [walletReady, checkCustomVault, loadBalance, loadVaultState]);

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
    } catch (e) {}
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
      const randomSaltHex = Array.from({ length: 32 }, () =>
        Math.floor(Math.random() * 256).toString(16).padStart(2, "0")
      ).join("");

      const xdr = await buildDeployVaultXdr(
        stellarWallet.address,
        stellarWallet.address,
        "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC", // Native XLM token SAC address
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

          {/* Dynamic Factory Deployment Panel */}
          <div className="panel" style={{ marginBottom: "18px" }}>
            <div className="panel-head">
              <h3>Dynamic Vault Factory</h3>
            </div>
            
            {customVaultId ? (
              <div className="vault-toggle-container">
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
              <div style={{ display: "grid", gap: "10px" }}>
                <div className="notice warn" style={{ margin: 0 }}>
                  You have not deployed a dynamic vault yet.
                </div>
                <button className="btn-outline" onClick={deployDynamicVault} disabled={sending}>
                  {sending ? "Deploying…" : "Deploy Custom Vault via Factory"}
                </button>
              </div>
            )}
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
                <span className="sc-unit">XLM</span>
              </div>
              <div className="sc-sub">Assets in active vault pool</div>
            </div>
          </div>

          <div className="dash-grid">
            <div style={{ display: "grid", gap: "18px" }}>
              
              <div className="tab-bar">
                <button 
                  className={`tab-btn ${activePanel === "send" ? "active" : ""}`}
                  onClick={() => { setActivePanel("send"); clearErrors(); }}
                >
                  Send Direct Payroll
                </button>
                <button 
                  className={`tab-btn ${activePanel === "vault" ? "active" : ""}`}
                  onClick={() => { setActivePanel("vault"); clearErrors(); }}
                >
                  Smart Payroll Vault
                </button>
              </div>

              {/* Panel 1: Classic Send Payroll Form */}
              {activePanel === "send" && (
                <div className="panel">
                  <div className="panel-head"><h3>Send test payroll (Direct)</h3></div>

                  {renderErrorToast()}

                  <form className="send-form" onSubmit={sendPayroll}>
                    <label className="form-label">
                      Recipient address (G…)
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
                      {sending ? " Processing…" : " Send Test Payroll"}
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

              {/* Panel 2: Smart Vault escrow */}
              {activePanel === "vault" && (
                <div className="panel">
                  <div className="panel-head"><h3>Smart Payroll Vault Operations</h3></div>

                  <div className="contract-badge">
                    <div style={{ flex: 1, minWidth: 0, marginRight: "10px" }}>
                      <span style={{ fontSize: "0.74rem", display: "block", color: "var(--ink-muted)", fontWeight: 600 }}>ACTIVE VAULT CONTRACT ID</span>
                      <code>{vaultId}</code>
                    </div>
                    <button className="copy-btn" onClick={() => {
                      navigator.clipboard.writeText(vaultId);
                    }}>
                      Copy
                    </button>
                  </div>

                  {renderErrorToast()}

                  <div className="vault-tabs">
                    <button 
                      className={`vault-tab ${vaultTab === "deposit" ? "active" : ""}`}
                      onClick={() => { setVaultTab("deposit"); clearErrors(); }}
                    >
                      Deposit Funds
                    </button>
                    <button 
                      className={`vault-tab ${vaultTab === "claim" ? "active" : ""}`}
                      onClick={() => { setVaultTab("claim"); clearErrors(); }}
                    >
                      Claim Payroll
                    </button>
                  </div>

                  {vaultTab === "deposit" && (
                    <form className="send-form" onSubmit={depositToVault}>
                      <label className="form-label">
                        Deposit Flow Type
                        <select 
                          className="form-select"
                          value={depositType}
                          onChange={(e) => setDepositType(e.target.value as any)}
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
                        Amount (XLM)
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
                  )}

                  {vaultTab === "claim" && (
                    <div style={{ display: "grid", gap: "16px" }}>
                      
                      <label className="form-label">
                        Claim Flow Type
                        <select 
                          className="form-select"
                          value={claimType}
                          onChange={(e) => setClaimType(e.target.value as any)}
                        >
                          <option value="instant">Instant allocation</option>
                          <option value="scheduled">Scheduled payments</option>
                          <option value="streaming">Active stream progress</option>
                        </select>
                      </label>

                      {claimType === "instant" && (
                        <div className="stat-card" style={{ background: "var(--cream)", borderStyle: "dashed" }}>
                          <div className="sc-label">CLAIMABLE INSTANT ALLOCATION</div>
                          <div style={{ display: "flex", alignItems: "baseline" }}>
                            <span className="sc-value" style={{ fontSize: "2rem" }}>
                              {stroopsToXlm(workerAllocation)}
                            </span>
                            <span className="sc-unit">XLM</span>
                          </div>
                        </div>
                      )}

                      {claimType === "scheduled" && (
                        <div style={{ display: "grid", gap: "10px" }}>
                          <div className="sc-label">Scheduled payouts</div>
                          {scheduledAllocations.length === 0 ? (
                            <div className="hist-empty">No scheduled payouts found for your wallet.</div>
                          ) : (
                            scheduledAllocations.map((item, idx) => (
                              <div className="allocation-item" key={idx}>
                                <div>
                                  <strong>{stroopsToXlm(item.amount)} XLM</strong>
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
                            <div className="stat-card" style={{ background: "var(--cream)", padding: "14px" }}>
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
                                  <div className="stream-stat-val">{stroopsToXlm(streamDetails.totalAmount)} XLM</div>
                                </div>
                                <div className="stream-stat">
                                  <div className="stream-stat-label">Claimed Already</div>
                                  <div className="stream-stat-val">{stroopsToXlm(streamDetails.claimedAmount)} XLM</div>
                                </div>
                              </div>

                              <div style={{ marginTop: "12px", borderTop: "1px dashed var(--border)", paddingTop: "8px", textAlign: "center" }}>
                                <div className="sc-label" style={{ marginBottom: "2px" }}>ACCRUED CLAIMABLE (TICKING)</div>
                                <span style={{ fontSize: "1.4rem", fontWeight: 700, color: "var(--sage)" }}>
                                  {stroopsToXlm(liveStreamClaimable)} XLM
                                </span>
                              </div>
                            </div>
                          ) : (
                            <div className="hist-empty">No active stream found for your wallet.</div>
                          )}
                        </div>
                      )}

                      <button 
                        id="btn-send" 
                        onClick={claimFromVault} 
                        disabled={
                          sending || 
                          (claimType === "instant" && workerAllocation === 0n) ||
                          (claimType === "scheduled" && !scheduledAllocations.some(item => !item.locked)) ||
                          (claimType === "streaming" && liveStreamClaimable === 0n)
                        }
                      >
                        {sending ? " Claiming…" : ` Claim (${claimType})`}
                      </button>
                    </div>
                  )}

                  {vaultTxStatus.type !== "idle" && (
                    <div className={`tx-status-box ${vaultTxStatus.type}`} style={{ display: "block" }}>
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
            </div>

          </div>
        </div>
      </div>
    </>
  );
}
