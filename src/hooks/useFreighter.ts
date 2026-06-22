import { useCallback, useEffect, useState } from "react";
import {
  getAddress,
  getNetwork,
  isConnected,
  requestAccess,
  signTransaction,
} from "@stellar/freighter-api";

type FreighterState = {
  address: string | null;
  installed: boolean;
  connected: boolean;
  network: string | null;
  error: string | null;
};

function readError(error: unknown, fallback: string) {
  if (!error) return fallback;
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && "message" in error) {
    return String((error as { message?: unknown }).message);
  }
  return fallback;
}

export function useFreighter() {
  const [state, setState] = useState<FreighterState>({
    address: null,
    installed: false,
    connected: false,
    network: null,
    error: null,
  });

  const refresh = useCallback(async () => {
    const connection = await isConnected();
    const installed = Boolean(connection.isConnected);

    if (!installed || connection.error) {
      setState((current) => ({
        ...current,
        installed: false,
        connected: false,
        address: null,
        network: null,
        error: connection.error ? readError(connection.error, "Freighter is unavailable.") : null,
      }));
      return;
    }

    const addressResult = await getAddress();
    const networkResult = await getNetwork();
    const address = addressResult.address || null;

    setState({
      installed: true,
      connected: Boolean(address),
      address,
      network: networkResult.network || null,
      error: addressResult.error
        ? readError(addressResult.error, "Wallet access has not been granted.")
        : null,
    });
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const connect = useCallback(async () => {
    const connection = await isConnected();
    if (!connection.isConnected || connection.error) {
      throw new Error("Install Freighter wallet to use ProofPay Alpha.");
    }

    const access = await requestAccess();
    if (access.error || !access.address) {
      throw new Error(readError(access.error, "Wallet connection was cancelled."));
    }

    const networkResult = await getNetwork();
    if (networkResult.error) {
      throw new Error(readError(networkResult.error, "Could not read wallet network."));
    }

    setState({
      installed: true,
      connected: true,
      address: access.address,
      network: networkResult.network || null,
      error: null,
    });

    return access.address;
  }, []);

  const disconnect = useCallback(() => {
    setState((current) => ({
      ...current,
      connected: false,
      address: null,
      error: null,
    }));
  }, []);

  const sign = useCallback(async (xdr: string, networkPassphrase: string) => {
    if (!state.connected || !state.address) {
      throw new Error("Connect Freighter before signing a transaction.");
    }

    const signed = await signTransaction(xdr, { networkPassphrase });
    if (signed.error || !signed.signedTxXdr) {
      throw new Error(readError(signed.error, "Transaction signing was cancelled."));
    }

    return signed.signedTxXdr;
  }, [state.address, state.connected]);

  return {
    ...state,
    connect,
    disconnect,
    refresh,
    sign,
  };
}
