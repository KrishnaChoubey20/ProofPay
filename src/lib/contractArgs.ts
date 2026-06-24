import * as StellarSdk from "@stellar/stellar-sdk";

/**
 * Build an Address ScVal from a Stellar account address string.
 */
export function addressArg(addr: string): StellarSdk.xdr.ScVal {
  return StellarSdk.Address.fromString(addr).toScVal();
}

/**
 * Build an i128 ScVal from a strobe XLM amount string (e.g. "10.5000000").
 * Internally converts to stroops (1 XLM = 10_000_000 stroops).
 */
export function xlmToStroopsArg(xlmAmount: string): StellarSdk.xdr.ScVal {
  const stroops = BigInt(Math.round(parseFloat(xlmAmount) * 10_000_000));
  return StellarSdk.nativeToScVal(stroops, { type: "i128" });
}

/**
 * Build an i128 ScVal directly from a BigInt stroops value.
 */
export function i128Arg(stroops: bigint): StellarSdk.xdr.ScVal {
  return StellarSdk.nativeToScVal(stroops, { type: "i128" });
}

/**
 * Convert stroops (i128 ScVal result) back to an XLM display string.
 */
export function stroopsToXlm(stroops: bigint | number): string {
  return (Number(stroops) / 10_000_000).toFixed(7);
}
