import { useState, useCallback, useRef } from "react";
import { StellarWalletsKit } from "@creit.tech/stellar-wallets-kit/sdk";
import { defaultModules } from "@creit.tech/stellar-wallets-kit/modules/utils";
import { Networks, KitEventType } from "@creit.tech/stellar-wallets-kit/types";
import { NETWORK_PASSPHRASE } from "../lib/stellar";

// Initialize kit once globally for Testnet
StellarWalletsKit.init({
  modules: defaultModules(),
  network: Networks.TESTNET,
});

// ── Error types ─────────────────────────────────────────────────────────────
export type WalletErrorType =
  | "WalletNotFound"
  | "UserRejected"
  | "InsufficientBalance"
  | "Unknown";

export class WalletError extends Error {
  constructor(
    public readonly kind: WalletErrorType,
    message: string
  ) {
    super(message);
    this.name = "WalletError";
  }
}

function classifyError(error: unknown): WalletError {
  const msg =
    error instanceof Error
      ? error.message
      : typeof error === "string"
      ? error
      : "An unexpected error occurred.";

  const lower = msg.toLowerCase();

  if (
    lower.includes("not installed") ||
    lower.includes("not found") ||
    lower.includes("no wallet") ||
    lower.includes("extension") ||
    lower.includes("unavailable")
  ) {
    return new WalletError(
      "WalletNotFound",
      "No Stellar wallet extension detected. Install Freighter or LOBSTR."
    );
  }

  if (
    lower.includes("reject") ||
    lower.includes("cancel") ||
    lower.includes("denied") ||
    lower.includes("declined") ||
    lower.includes("user") ||
    lower.includes("abort")
  ) {
    return new WalletError(
      "UserRejected",
      "You rejected the transaction in your wallet."
    );
  }

  if (
    lower.includes("insufficient") ||
    lower.includes("balance") ||
    lower.includes("funds") ||
    lower.includes("too low")
  ) {
    return new WalletError(
      "InsufficientBalance",
      "Your XLM balance is too low to cover this transaction + fees."
    );
  }

  return new WalletError("Unknown", msg);
}

// ── Hook ─────────────────────────────────────────────────────────────────────
type WalletState = {
  address: string | null;
  connected: boolean;
  walletId: string | null;
  error: WalletError | null;
};

export function useStellarWallet() {
  const [state, setState] = useState<WalletState>({
    address: null,
    connected: false,
    walletId: null,
    error: null,
  });

  const connectingRef = useRef(false);

  const clearError = useCallback(() => {
    setState((prev) => ({ ...prev, error: null }));
  }, []);

  const connect = useCallback(async () => {
    if (connectingRef.current) return;
    connectingRef.current = true;
    setState((prev) => ({ ...prev, error: null }));

    try {
      let selectedWallet: string | null = null;
      
      // Listen to wallet selection event to capture which wallet was selected
      const unsubscribe = StellarWalletsKit.on(
        KitEventType.WALLET_SELECTED,
        (event) => {
          selectedWallet = event.payload.id || null;
        }
      );

      const { address } = await StellarWalletsKit.authModal();
      
      unsubscribe();

      if (!address) {
        throw new WalletError(
          "WalletNotFound",
          "Could not retrieve wallet address. Make sure your wallet is set up."
        );
      }

      setState({
        address,
        connected: true,
        walletId: selectedWallet || "freighter",
        error: null,
      });
    } catch (err) {
      const walletErr = err instanceof WalletError ? err : classifyError(err);
      setState((prev) => ({
        ...prev,
        error: walletErr,
        connected: false,
        address: null,
        walletId: null,
      }));
    } finally {
      connectingRef.current = false;
    }
  }, []);

  const disconnect = useCallback(async () => {
    try {
      await StellarWalletsKit.disconnect();
    } catch (e) {}
    setState({ address: null, connected: false, walletId: null, error: null });
  }, []);

  const sign = useCallback(
    async (xdr: string): Promise<string> => {
      if (!state.connected || !state.address) {
        throw new WalletError("WalletNotFound", "No wallet connected.");
      }
      try {
        const { signedTxXdr } = await StellarWalletsKit.signTransaction(xdr, {
          networkPassphrase: NETWORK_PASSPHRASE,
          address: state.address,
        });
        if (!signedTxXdr) {
          throw new WalletError("UserRejected", "You rejected the transaction in your wallet.");
        }
        return signedTxXdr;
      } catch (err) {
        if (err instanceof WalletError) throw err;
        throw classifyError(err);
      }
    },
    [state.connected, state.address]
  );

  return {
    ...state,
    connect,
    disconnect,
    sign,
    clearError,
  };
}
