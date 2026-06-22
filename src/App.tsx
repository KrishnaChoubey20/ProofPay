import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import {
  ArrowRight,
  BadgeCheck,
  Copy,
  ExternalLink,
  Loader2,
  LogOut,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Wallet,
} from "lucide-react";
import { useFreighter } from "./hooks/useFreighter";
import {
  buildPayrollPaymentXdr,
  getNativeBalance,
  isTestnetNetwork,
  NETWORK_PASSPHRASE,
  shortenAddress,
  STELLAR_EXPERT_TESTNET,
  submitSignedTransaction,
} from "./lib/stellar";

type TransactionStatus =
  | { type: "idle"; message: string }
  | { type: "pending"; message: string }
  | { type: "success"; message: string; hash: string; ledger?: number }
  | { type: "error"; message: string };

const demoMilestones = [
  "Wallet connection",
  "Live XLM balance",
  "Signed testnet payroll",
  "Transaction receipt",
];

function friendlyError(error: unknown) {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Something went wrong. Please try again.";
}

function App() {
  const freighter = useFreighter();
  const [balance, setBalance] = useState<string | null>(null);
  const [balanceStatus, setBalanceStatus] = useState("Connect a wallet to load balance.");
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("1");
  const [memo, setMemo] = useState("ProofPay payroll test");
  const [copied, setCopied] = useState(false);
  const [txStatus, setTxStatus] = useState<TransactionStatus>({
    type: "idle",
    message: "Ready to send a Stellar testnet payroll transaction.",
  });

  const walletReady = Boolean(freighter.connected && freighter.address);
  const onTestnet = isTestnetNetwork(freighter.network);

  const networkLabel = useMemo(() => {
    if (!freighter.network) return "Not connected";
    return onTestnet ? "Stellar Testnet" : freighter.network;
  }, [freighter.network, onTestnet]);

  const loadBalance = useCallback(async () => {
    if (!freighter.address) {
      setBalance(null);
      setBalanceStatus("Connect a wallet to load balance.");
      return;
    }

    setBalanceStatus("Loading XLM balance...");

    try {
      const nextBalance = await getNativeBalance(freighter.address);
      setBalance(nextBalance);
      setBalanceStatus("Balance updated from Stellar Testnet.");
    } catch (error) {
      setBalance(null);
      setBalanceStatus(friendlyError(error));
    }
  }, [freighter.address]);

  useEffect(() => {
    void loadBalance();
  }, [loadBalance]);

  async function connectWallet() {
    setTxStatus({ type: "idle", message: "Opening Freighter wallet..." });

    try {
      await freighter.connect();
      setTxStatus({
        type: "idle",
        message: "Wallet connected. You can now send a test payroll transaction.",
      });
    } catch (error) {
      setTxStatus({ type: "error", message: friendlyError(error) });
    }
  }

  function disconnectWallet() {
    freighter.disconnect();
    setBalance(null);
    setRecipient("");
    setTxStatus({
      type: "idle",
      message: "Wallet disconnected. Connect again when you are ready.",
    });
  }

  async function copyHash(hash: string) {
    await navigator.clipboard.writeText(hash);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }

  async function sendPayroll(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!freighter.address) {
      setTxStatus({ type: "error", message: "Connect Freighter before sending payroll." });
      return;
    }

    if (!onTestnet) {
      setTxStatus({
        type: "error",
        message: "Switch Freighter to Stellar Testnet before signing.",
      });
      return;
    }

    try {
      setTxStatus({ type: "pending", message: "Building payroll transaction..." });
      const xdr = await buildPayrollPaymentXdr({
        sourceAddress: freighter.address,
        destinationAddress: recipient,
        amount,
        memo,
      });

      setTxStatus({ type: "pending", message: "Review and sign in Freighter..." });
      const signedXdr = await freighter.sign(xdr, NETWORK_PASSPHRASE);

      setTxStatus({ type: "pending", message: "Submitting to Stellar Testnet..." });
      const result = await submitSignedTransaction(signedXdr);

      setTxStatus({
        type: "success",
        message: "Test payroll sent successfully.",
        hash: result.hash,
        ledger: result.ledger,
      });
      await loadBalance();
    } catch (error) {
      setTxStatus({ type: "error", message: friendlyError(error) });
    }
  }

  return (
    <main className="app-shell">
      <section className="hero-band">
        <nav className="topbar" aria-label="ProofPay navigation">
          <div className="brand">
            <img src="/proofpay-mark.svg" alt="" className="brand-mark" />
            <span>ProofPay Alpha</span>
          </div>
          <div className={`network-pill ${onTestnet ? "ok" : "warn"}`}>
            <span />
            {networkLabel}
          </div>
        </nav>

        <div className="hero-grid">
          <div className="hero-copy">
            <p className="eyebrow">Stellar White Belt submission</p>
            <h1>Private payroll starts with a real testnet transaction.</h1>
            <p>
              ProofPay Alpha lets a remote worker connect Freighter, view their
              Stellar Testnet XLM balance, and send a signed payroll-style XLM
              transaction with a visible receipt.
            </p>
            <div className="hero-actions">
              {walletReady ? (
                <button className="secondary-button" type="button" onClick={disconnectWallet}>
                  <LogOut size={18} />
                  Disconnect
                </button>
              ) : (
                <button className="primary-button" type="button" onClick={connectWallet}>
                  <Wallet size={18} />
                  Connect Freighter
                </button>
              )}
              <a
                className="text-link"
                href="https://friendbot.stellar.org"
                target="_blank"
                rel="noreferrer"
              >
                Fund testnet wallet
                <ExternalLink size={16} />
              </a>
            </div>
          </div>

          <div className="payroll-visual" aria-label="ProofPay payroll flow preview">
            <div className="flow-node employer">
              <span>Employer</span>
              <strong>Payroll batch</strong>
            </div>
            <div className="flow-line">
              <ArrowRight size={22} />
            </div>
            <div className="flow-node worker">
              <span>Worker</span>
              <strong>Verified income</strong>
            </div>
            <div className="proof-strip">
              {demoMilestones.map((item) => (
                <span key={item}>
                  <BadgeCheck size={15} />
                  {item}
                </span>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section className="workspace-grid">
        <aside className="panel wallet-panel">
          <div className="panel-heading">
            <div>
              <p className="label">Wallet setup</p>
              <h2>Freighter on Testnet</h2>
            </div>
            <ShieldCheck size={24} />
          </div>

          <div className="status-list">
            <div>
              <span>Connection</span>
              <strong>{walletReady ? "Connected" : "Disconnected"}</strong>
            </div>
            <div>
              <span>Public key</span>
              <strong>{freighter.address ? shortenAddress(freighter.address) : "Not connected"}</strong>
            </div>
            <div>
              <span>Network</span>
              <strong className={onTestnet ? "success-text" : "warning-text"}>{networkLabel}</strong>
            </div>
          </div>

          {!freighter.installed && (
            <div className="notice warning">
              Install Freighter, create a testnet account, and fund it before sending.
            </div>
          )}

          {walletReady && !onTestnet && (
            <div className="notice warning">
              Freighter is connected, but the challenge requires Stellar Testnet.
            </div>
          )}

          <button
            className={walletReady ? "secondary-button full" : "primary-button full"}
            type="button"
            onClick={walletReady ? disconnectWallet : connectWallet}
          >
            {walletReady ? <LogOut size={18} /> : <Wallet size={18} />}
            {walletReady ? "Disconnect wallet" : "Connect wallet"}
          </button>
        </aside>

        <section className="panel balance-panel">
          <div className="panel-heading">
            <div>
              <p className="label">Balance handling</p>
              <h2>XLM balance</h2>
            </div>
            <button
              className="icon-button"
              type="button"
              onClick={() => void loadBalance()}
              disabled={!walletReady}
              aria-label="Refresh balance"
              title="Refresh balance"
            >
              <RefreshCw size={18} />
            </button>
          </div>

          <div className="balance-display">
            <span>{balance ? Number(balance).toLocaleString(undefined, {
              maximumFractionDigits: 7,
            }) : "--"}</span>
            <strong>XLM</strong>
          </div>
          <p className="muted">{balanceStatus}</p>
        </section>

        <section className="panel transaction-panel">
          <div className="panel-heading">
            <div>
              <p className="label">Transaction flow</p>
              <h2>Send test payroll</h2>
            </div>
            <Sparkles size={24} />
          </div>

          <form className="payment-form" onSubmit={(event) => void sendPayroll(event)}>
            <label>
              Worker recipient address
              <input
                value={recipient}
                onChange={(event) => setRecipient(event.target.value)}
                placeholder="G..."
                autoComplete="off"
              />
            </label>

            <div className="form-row">
              <label>
                Amount
                <input
                  value={amount}
                  onChange={(event) => setAmount(event.target.value)}
                  inputMode="decimal"
                  placeholder="1"
                />
              </label>
              <label>
                Memo
                <input
                  value={memo}
                  onChange={(event) => setMemo(event.target.value)}
                  maxLength={28}
                  placeholder="ProofPay payroll test"
                />
              </label>
            </div>

            <button
              className="primary-button full"
              type="submit"
              disabled={!walletReady || txStatus.type === "pending"}
            >
              {txStatus.type === "pending" ? <Loader2 className="spin" size={18} /> : <ArrowRight size={18} />}
              {txStatus.type === "pending" ? "Processing..." : "Send Test Payroll"}
            </button>
          </form>

          <div className={`transaction-status ${txStatus.type}`}>
            <strong>
              {txStatus.type === "success"
                ? "Success"
                : txStatus.type === "error"
                  ? "Needs attention"
                  : txStatus.type === "pending"
                    ? "In progress"
                    : "Ready"}
            </strong>
            <p>{txStatus.message}</p>

            {txStatus.type === "success" && (
              <div className="receipt">
                <span>Hash</span>
                <code>{shortenAddress(txStatus.hash, 8, 8)}</code>
                <button
                  className="icon-button"
                  type="button"
                  onClick={() => void copyHash(txStatus.hash)}
                  aria-label="Copy transaction hash"
                  title="Copy transaction hash"
                >
                  <Copy size={16} />
                </button>
                <a
                  className="icon-button"
                  href={`${STELLAR_EXPERT_TESTNET}/${txStatus.hash}`}
                  target="_blank"
                  rel="noreferrer"
                  aria-label="Open transaction in StellarExpert"
                  title="Open transaction in StellarExpert"
                >
                  <ExternalLink size={16} />
                </a>
                {copied && <em>Copied</em>}
              </div>
            )}
          </div>
        </section>

        <section className="panel roadmap-panel">
          <div className="panel-heading">
            <div>
              <p className="label">ProofPay roadmap</p>
              <h2>Beyond White Belt</h2>
            </div>
          </div>
          <ul className="roadmap">
            <li>
              <strong>Yellow Belt</strong>
              Employer and worker views with payroll transaction history.
            </li>
            <li>
              <strong>Orange Belt</strong>
              Smart payroll vault for scheduled and split payments.
            </li>
            <li>
              <strong>Green Belt+</strong>
              Selective private income proofs for rent, loans, visas, and taxes.
            </li>
          </ul>
        </section>
      </section>
    </main>
  );
}

export default App;
