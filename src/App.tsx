import { useCallback, useEffect, useState, FormEvent } from "react";
import { useStellarWallet, WalletError, WalletErrorType } from "./hooks/useStellarWallet";
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

export default function App() {
  const stellarWallet = useStellarWallet();
  const [balance, setBalance] = useState<string | null>(null);
  const [balanceMessage, setBalanceMessage] = useState("Fetching from Horizon…");
  
  // Tab control states
  const [activePanel, setActivePanel] = useState<"send" | "vault">("send");
  const [vaultTab, setVaultTab] = useState<"deposit" | "claim">("deposit");

  // Send Payroll Panel states
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("1");
  const [memo, setMemo] = useState("ProofPay payroll test");
  const [txStatus, setTxStatus] = useState<TransactionStatus>({ type: "idle" });

  // Vault Payroll Panel states
  const [vaultWorker, setVaultWorker] = useState("");
  const [vaultAmount, setVaultAmount] = useState("1");
  const [workerAllocation, setWorkerAllocation] = useState<bigint>(0n);
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
  const onTestnet = true; // stellar-wallets-kit is configured for Testnet

  const activeError = localError || stellarWallet.error;

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

  const loadVaultState = useCallback(async () => {
    if (!stellarWallet.address || VAULT_CONTRACT_ID === "PLACEHOLDER_DEPLOY_CONTRACT_ID_HERE") return;
    try {
      const alloc = await getContractAllocation(VAULT_CONTRACT_ID, stellarWallet.address);
      setWorkerAllocation(alloc);

      const total = await getVaultTotalDeposited(VAULT_CONTRACT_ID, stellarWallet.address);
      setVaultTotal(total);
    } catch (e) {
      console.error("Failed to load vault state", e);
    }
  }, [stellarWallet.address]);

  // Initial load when wallet becomes ready
  useEffect(() => {
    if (walletReady) {
      void loadBalance();
      void loadVaultState();
    }
  }, [loadBalance, loadVaultState, walletReady]);

  // Periodic polling for balance and vault state
  useEffect(() => {
    if (!walletReady) return;
    const interval = setInterval(() => {
      void loadBalance();
      void loadVaultState();
    }, 5000);
    return () => clearInterval(interval);
  }, [loadBalance, loadVaultState, walletReady]);

  // Real-time event streaming via Soroban RPC
  useEffect(() => {
    if (!walletReady || VAULT_CONTRACT_ID === "PLACEHOLDER_DEPLOY_CONTRACT_ID_HERE") return;

    setIsStreamingEvents(true);
    const cleanup = streamContractEvents(VAULT_CONTRACT_ID, (newEvent) => {
      setActivityFeed((prev) => {
        if (prev.some((e) => e.txHash === newEvent.txHash && e.type === newEvent.type)) {
          return prev;
        }
        return [newEvent, ...prev];
      });
      // Automatically refresh balance and vault state when an event occurs
      void loadVaultState();
      void loadBalance();
    });

    return () => {
      cleanup();
      setIsStreamingEvents(false);
    };
  }, [walletReady, loadVaultState, loadBalance]);

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

  // classic send payroll
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

  // Soroban vault deposit
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

    if (VAULT_CONTRACT_ID === "PLACEHOLDER_DEPLOY_CONTRACT_ID_HERE") {
      setVaultTxStatus({
        type: "error",
        title: "Contract Not Deployed",
        message: "Please deploy the vault contract and set VAULT_CONTRACT_ID in stellar.ts.",
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
      message: "Estimating resources for depositing XLM into Vault…",
    });

    try {
      const args = [
        addressArg(stellarWallet.address),
        addressArg(trimmedWorker),
        xlmToStroopsArg(vaultAmount),
      ];

      const xdr = await invokeContract(
        stellarWallet.address,
        VAULT_CONTRACT_ID,
        "deposit",
        args
      );

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
        message: `${vaultAmount} XLM has been deposited in the vault for ${shorten(trimmedWorker, 6, 6)}.`,
        hash: result.hash,
        ledger: result.ledger,
      });

      setVaultWorker("");
      setVaultAmount("1");
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

  // Soroban vault claim
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

    if (VAULT_CONTRACT_ID === "PLACEHOLDER_DEPLOY_CONTRACT_ID_HERE") {
      setVaultTxStatus({
        type: "error",
        title: "Contract Not Deployed",
        message: "Please deploy the vault contract and set VAULT_CONTRACT_ID in stellar.ts.",
      });
      return;
    }

    if (workerAllocation <= 0n) {
      setVaultTxStatus({
        type: "error",
        title: "No allocation",
        message: "You do not have any claimable allocation in the vault.",
      });
      return;
    }

    setSending(true);
    setVaultTxStatus({
      type: "pending",
      title: "Simulating claim",
      message: "Estimating resources for claiming your payroll allocation…",
    });

    try {
      const args = [addressArg(stellarWallet.address)];

      const xdr = await invokeContract(
        stellarWallet.address,
        VAULT_CONTRACT_ID,
        "claim",
        args
      );

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
      
      const claimedAmountXlm = stroopsToXlm(workerAllocation);

      setVaultTxStatus({
        type: "success",
        title: "Payroll claimed!",
        message: `Successfully claimed ${claimedAmountXlm} XLM from the vault.`,
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
                  <span>Stellar Yellow Belt Submission</span>
                </div>
                <h1 className="display">
                  Private payroll,<br />
                  <em>proven on-chain.</em>
                </h1>
                <p className="hero-sub">
                  ProofPay Yellow Belt enables multi-wallet wallet connections to Stellar Testnet, integrates on-chain escrow via a Rust Soroban Vault, and streams live payout history in real time.
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
                <div className="hero-trust">
                  <div className="trust-item">
                    <svg className="trust-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                    </svg>
                    StellarWalletsKit (Multi-Wallet)
                  </div>
                  <div className="trust-item">
                    <svg className="trust-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <circle cx="12" cy="12" r="10" />
                      <polyline points="12 6 12 12 16 14" />
                    </svg>
                    Soroban RPC Integration
                  </div>
                  <div className="trust-item">
                    <svg className="trust-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                    Payroll Vault Contract
                  </div>
                </div>
              </div>
              <div className="hero-card">
                <div className="card-header">
                  <span className="card-title">ProofPay Yellow Belt</span>
                  <span className="status-chip connected">
                    <span className="dot"></span>Connected
                  </span>
                </div>
                <div style={{ display: "flex", gap: "8px", marginBottom: "14px" }}>
                  <span className="status-chip testnet">
                    <span className="dot"></span>Stellar Testnet
                  </span>
                </div>
                <div className="balance-block">
                  <div className="balance-label">Available balance</div>
                  <div>
                    <span className="balance-amount">9,842</span>
                    <span className="balance-unit">XLM</span>
                  </div>
                  <div style={{ fontSize: "0.76rem", color: "var(--ink-muted)", marginTop: "5px" }}>
                    GACT...K7WM · Testnet
                  </div>
                </div>
                <div style={{ marginTop: "14px" }}>
                  <div style={{ fontSize: "0.75rem", color: "var(--ink-muted)", marginBottom: "9px", fontWeight: 600, letterSpacing: "0.04em" }}>
                    RECENT PAYROLLS
                  </div>
                  <div className="tx-row">
                    <div className="tx-info">
                      <div className="tx-icon">
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--sage)" strokeWidth="2">
                          <line x1="12" y1="1" x2="12" y2="23" />
                          <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
                        </svg>
                      </div>
                      <div>
                        <div className="tx-label">Payroll #01</div>
                        <div className="tx-sub">GDX5...M2N4</div>
                      </div>
                    </div>
                    <span className="tx-amt">+250 XLM</span>
                  </div>
                  <div className="tx-row">
                    <div className="tx-info">
                      <div className="tx-icon">
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--sage)" strokeWidth="2">
                          <line x1="12" y1="1" x2="12" y2="23" />
                          <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
                        </svg>
                      </div>
                      <div>
                        <div className="tx-label">Payroll #02</div>
                        <div className="tx-sub">GDX5...M2N4</div>
                      </div>
                    </div>
                    <span className="tx-amt">+100 XLM</span>
                  </div>
                </div>
                <div className="mock-send-btn">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <line x1="22" y1="2" x2="11" y2="13" />
                    <polygon points="22 2 15 22 11 13 2 9 22 2" />
                  </svg>
                  Send Test Payroll
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="how-it-works">
          <div className="container">
            <div className="section-head">
              <p className="eyebrow">Transaction flow</p>
              <h2 className="display">How ProofPay works</h2>
              <p>Four steps from wallet connection to a verified on-chain payroll receipt.</p>
            </div>
            <div className="steps-grid">
              <div className="step">
                <div className="step-num">01</div>
                <div className="step-icon">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <rect x="2" y="5" width="20" height="14" rx="2" />
                    <line x1="2" y1="10" x2="22" y2="10" />
                  </svg>
                </div>
                <h3>Connect Wallet</h3>
                <p>Select your favorite wallet extension (Freighter, LOBSTR, xBull) using StellarWalletsKit.</p>
              </div>
              <div className="step">
                <div className="step-num">02</div>
                <div className="step-icon">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <circle cx="12" cy="12" r="10" />
                    <line x1="12" y1="8" x2="12" y2="12" />
                    <line x1="12" y1="16" x2="12.01" y2="16" />
                  </svg>
                </div>
                <h3>Manage Vault</h3>
                <p>Employers allocate payroll to worker addresses using the smart contract vault.</p>
              </div>
              <div className="step">
                <div className="step-num">03</div>
                <div className="step-icon">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <line x1="22" y1="2" x2="11" y2="13" />
                    <polygon points="22 2 15 22 11 13 2 9 22 2" />
                  </svg>
                </div>
                <h3>Worker Claim</h3>
                <p>Workers trigger claim() on-chain to pull their assigned XLM allocations instantly.</p>
              </div>
              <div className="step">
                <div className="step-num">04</div>
                <div className="step-icon">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                    <polyline points="22 4 12 14.01 9 11.01" />
                  </svg>
                </div>
                <h3>Activity Feed</h3>
                <p>On-chain contract events are streamed in real time to show live payroll operations.</p>
              </div>
            </div>
          </div>
        </section>

        <section className="tech-section">
          <div className="container">
            <div className="section-head">
              <p className="eyebrow">Technology</p>
              <h2 className="display">Built on proven tools</h2>
              <p>A lean, well-typed stack for Stellar-native development.</p>
            </div>
            <div className="tech-grid">
              <div className="tech-card">
                <div className="tech-icon" style={{ background: "#F0F4FF" }}>⚛️</div>
                <h3>React + TypeScript</h3>
                <p>Typed, component-driven UI with strict compiler settings and full ESLint coverage.</p>
              </div>
              <div className="tech-card">
                <div className="tech-icon" style={{ background: "#FFFBEA" }}>⚡</div>
                <h3>StellarWalletsKit</h3>
                <p>Multi-wallet adapter that allows Freighter, LOBSTR, xBull, and other standard wallets.</p>
              </div>
              <div className="tech-card">
                <div className="tech-icon" style={{ background: "#EEF6F1" }}>🦀</div>
                <h3>Soroban Rust Contract</h3>
                <p>A secure on-chain payroll vault with atomic state changes, events, and TTL management.</p>
              </div>
              <div className="tech-card">
                <div className="tech-icon" style={{ background: "#F6F2EA" }}>🛰️</div>
                <h3>Soroban RPC client</h3>
                <p>Submit transactions, simulate invocations, read ledger states, and stream events directly.</p>
              </div>
              <div className="tech-card">
                <div className="tech-icon" style={{ background: "#F0FAF4" }}>🚀</div>
                <h3>Testnet Horizon</h3>
                <p>Public Testnet API — free, no key needed, always live at horizon-testnet.stellar.org.</p>
              </div>
              <div className="tech-card">
                <div className="tech-icon" style={{ background: "#FFF5F5" }}>🔗</div>
                <h3>StellarExpert</h3>
                <p>Explorer link shown in every success receipt for independent transaction verification.</p>
              </div>
            </div>
          </div>
        </section>

        <footer>
          <div className="container">
            <div className="footer-inner">
              <div className="footer-brand">
                <h3>ProofPay Yellow Belt</h3>
                <p>A Stellar Testnet payroll platform prototype for the Stellar Journey to Mastery challenge.</p>
              </div>
              <div className="footer-links">
                <div className="footer-col">
                  <h4>Resources</h4>
                  <ul>
                    <li><a href="https://github.com/KrishnaChoubey20/ProofPay" target="_blank" rel="noreferrer">GitHub repository</a></li>
                    <li><a href="https://friendbot.stellar.org" target="_blank" rel="noreferrer">Stellar Friendbot</a></li>
                    <li><a href="https://stellar.expert/explorer/testnet" target="_blank" rel="noreferrer">StellarExpert Testnet</a></li>
                    <li><a href="https://www.freighter.app" target="_blank" rel="noreferrer">Freighter wallet</a></li>
                  </ul>
                </div>
              </div>
            </div>
            <div className="footer-bottom">
              <p>ProofPay Yellow Belt · Stellar Yellow Belt · React + Vite + Stellar SDK v13</p>
              <a className="github-link" href="https://github.com/KrishnaChoubey20/ProofPay" target="_blank" rel="noreferrer">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12 0C5.374 0 0 5.373 0 12c0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23A11.509 11.509 0 0 1 12 5.803c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576C20.566 21.797 24 17.3 24 12c0-6.627-5.373-12-12-12z" />
                </svg>
                KrishnaChoubey20/ProofPay
              </a>
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
            <button className="btn-outline" onClick={loadBalance} id="btn-refresh" style={{ gap: "7px", padding: "9px 16px", fontSize: "0.86rem" }}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="23 4 23 10 17 10" />
                <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
              </svg>
              Refresh balance
            </button>
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
              <div className="sc-label">CONNECTED WALLET</div>
              <div className="sc-value" id="sc-network" style={{ fontSize: "1.5rem", color: "var(--sage)" }}>
                {walletName}
              </div>
              <div className="sc-sub" id="sc-network-sub">
                Stellar Test SDF Network
              </div>
            </div>
            <div className="stat-card">
              <div className="sc-label">TRANSACTIONS SENT</div>
              <div><span className="sc-value" id="sc-tx-count">{txCount}</span></div>
              <div className="sc-sub">This session</div>
            </div>
          </div>

          <div className="dash-grid">
            <div style={{ display: "grid", gap: "18px" }}>
              
              {/* Tab Bar switcher for Panels */}
              <div className="tab-bar">
                <button 
                  className={`tab-btn ${activePanel === "send" ? "active" : ""}`}
                  onClick={() => { setActivePanel("send"); clearErrors(); }}
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <line x1="22" y1="2" x2="11" y2="13" />
                    <polygon points="22 2 15 22 11 13 2 9 22 2" />
                  </svg>
                  Send Direct Payroll
                </button>
                <button 
                  className={`tab-btn ${activePanel === "vault" ? "active" : ""}`}
                  onClick={() => { setActivePanel("vault"); clearErrors(); }}
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                  </svg>
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
                      {sending ? (
                        <span className="spin">↻</span>
                      ) : (
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                          <line x1="22" y1="2" x2="11" y2="13" />
                          <polygon points="22 2 15 22 11 13 2 9 22 2" />
                        </svg>
                      )}
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
                          {txStatus.ledger && (
                            <div style={{ fontSize: "0.76rem", color: "var(--ink-muted)", marginTop: "6px" }}>
                              Ledger: {txStatus.ledger}
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* Panel 2: Smart Vault escrow */}
              {activePanel === "vault" && (
                <div className="panel">
                  <div className="panel-head"><h3>Smart Payroll Vault</h3></div>

                  {/* Contract state badge */}
                  <div className="contract-badge">
                    <div style={{ flex: 1, minWidth: 0, marginRight: "10px" }}>
                      <span style={{ fontSize: "0.74rem", display: "block", color: "var(--ink-muted)", fontWeight: 600 }}>VAULT CONTRACT ID</span>
                      <code>{VAULT_CONTRACT_ID}</code>
                    </div>
                    <button className="copy-btn" onClick={() => {
                      navigator.clipboard.writeText(VAULT_CONTRACT_ID);
                    }}>
                      Copy
                    </button>
                  </div>

                  {VAULT_CONTRACT_ID === "PLACEHOLDER_DEPLOY_CONTRACT_ID_HERE" ? (
                    <div className="notice warn" style={{ fontSize: "0.82rem", padding: "10px" }}>
                      <strong>Contract not deployed yet.</strong> Build and deploy the Rust contract to Testnet, then update <code>VAULT_CONTRACT_ID</code> in <code>stellar.ts</code>.
                    </div>
                  ) : (
                    <div className="notice info" style={{ fontSize: "0.82rem", padding: "10px" }}>
                      Vault Total Deposited Asset Pool: <strong>{stroopsToXlm(vaultTotal)} XLM</strong>
                    </div>
                  )}

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
                      <button id="btn-send" type="submit" disabled={sending || VAULT_CONTRACT_ID === "PLACEHOLDER_DEPLOY_CONTRACT_ID_HERE"}>
                        {sending ? (
                          <span className="spin">↻</span>
                        ) : (
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                            <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                            <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                          </svg>
                        )}
                        {sending ? " Depositing…" : " Deposit to Vault"}
                      </button>
                    </form>
                  )}

                  {vaultTab === "claim" && (
                    <div style={{ display: "grid", gap: "16px" }}>
                      <div className="stat-card" style={{ background: "var(--cream)", borderStyle: "dashed" }}>
                        <div className="sc-label">YOUR CLAIMABLE ALLOCATION</div>
                        <div style={{ display: "flex", alignItems: "baseline" }}>
                          <span className="sc-value" style={{ fontSize: "2rem" }}>
                            {stroopsToXlm(workerAllocation)}
                          </span>
                          <span className="sc-unit">XLM</span>
                        </div>
                        <div className="sc-sub">Claim payroll instantly to your connected address.</div>
                      </div>

                      <button 
                        id="btn-send" 
                        onClick={claimFromVault} 
                        disabled={sending || workerAllocation === 0n || VAULT_CONTRACT_ID === "PLACEHOLDER_DEPLOY_CONTRACT_ID_HERE"}
                        style={{ background: workerAllocation > 0n ? "var(--sage)" : "var(--ink-muted)" }}
                      >
                        {sending ? (
                          <span className="spin">↻</span>
                        ) : (
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                            <polyline points="21 15 16 20 11 15" />
                            <line x1="16" y1="10" x2="16" y2="20" />
                            <path d="M4 4h18" />
                          </svg>
                        )}
                        {sending ? " Claiming…" : " Claim Payroll"}
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
                
                {VAULT_CONTRACT_ID === "PLACEHOLDER_DEPLOY_CONTRACT_ID_HERE" ? (
                  <div className="hist-empty">Deploy contract to stream real-time activity feed.</div>
                ) : activityFeed.length === 0 ? (
                  <div className="hist-empty">Waiting for contract events... Try depositing XLM.</div>
                ) : (
                  <div className="activity-feed">
                    {activityFeed.map((evt, idx) => (
                      <div className="feed-item" key={evt.txHash + evt.type + idx}>
                        <div className={`feed-icon ${evt.type === "PayrollDeposited" ? "deposit" : "claim"}`}>
                          {evt.type === "PayrollDeposited" ? (
                            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                              <line x1="12" y1="5" x2="12" y2="19" />
                              <polyline points="19 12 12 19 5 12" />
                            </svg>
                          ) : (
                            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                              <line x1="12" y1="19" x2="12" y2="5" />
                              <polyline points="5 12 12 5 19 12" />
                            </svg>
                          )}
                        </div>
                        <div className="feed-content">
                          <div className="feed-title">
                            {evt.type === "PayrollDeposited" ? (
                              <span>
                                <strong>{stroopsToXlm(evt.amount)} XLM</strong> deposited for <strong>{shorten(evt.worker, 4, 4)}</strong>
                              </span>
                            ) : (
                              <span>
                                <strong>{shorten(evt.worker, 4, 4)}</strong> claimed <strong>{stroopsToXlm(evt.amount)} XLM</strong>
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
