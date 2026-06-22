import * as StellarSdk from "@stellar/stellar-sdk";

export const STELLAR_EXPERT_TESTNET = "https://stellar.expert/explorer/testnet/tx";
export const NETWORK_PASSPHRASE = StellarSdk.Networks.TESTNET;

export const horizon = new StellarSdk.Horizon.Server(
  "https://horizon-testnet.stellar.org",
);

export function shortenAddress(address: string, lead = 5, tail = 5) {
  if (!address) return "";
  return `${address.slice(0, lead)}...${address.slice(-tail)}`;
}

export function isTestnetNetwork(network?: string | null) {
  if (!network) return false;
  const normalized = network.toLowerCase();
  return (
    normalized.includes("testnet") ||
    network === NETWORK_PASSPHRASE ||
    normalized.includes("test sdf network")
  );
}

export function validatePaymentInput(destination: string, amount: string) {
  if (!StellarSdk.StrKey.isValidEd25519PublicKey(destination.trim())) {
    throw new Error("Enter a valid Stellar public key that starts with G.");
  }

  const parsedAmount = Number(amount);
  if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
    throw new Error("Enter an XLM amount greater than 0.");
  }

  if (parsedAmount < 0.0000001) {
    throw new Error("Amount is below Stellar's minimum precision.");
  }
}

export async function getNativeBalance(address: string) {
  try {
    const account = await horizon.loadAccount(address);
    const nativeBalance = account.balances.find(
      (balance) => balance.asset_type === "native",
    );

    return nativeBalance?.balance ?? "0";
  } catch (error) {
    const possibleResponse = error as { response?: { status?: number } };
    if (possibleResponse.response?.status === 404) {
      throw new Error("This wallet is not funded on Stellar Testnet yet.");
    }

    throw error;
  }
}

export async function buildPayrollPaymentXdr({
  sourceAddress,
  destinationAddress,
  amount,
  memo,
}: {
  sourceAddress: string;
  destinationAddress: string;
  amount: string;
  memo: string;
}) {
  validatePaymentInput(destinationAddress, amount);

  const account = await horizon.loadAccount(sourceAddress);
  const transaction = new StellarSdk.TransactionBuilder(account, {
    fee: StellarSdk.BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addMemo(StellarSdk.Memo.text(memo.slice(0, 28) || "ProofPay payroll"))
    .addOperation(
      StellarSdk.Operation.payment({
        destination: destinationAddress.trim(),
        asset: StellarSdk.Asset.native(),
        amount: Number(amount).toFixed(7),
      }),
    )
    .setTimeout(180)
    .build();

  return transaction.toXDR();
}

export async function submitSignedTransaction(signedXdr: string) {
  const transaction = StellarSdk.TransactionBuilder.fromXDR(
    signedXdr,
    NETWORK_PASSPHRASE,
  ) as StellarSdk.Transaction;

  const response = await horizon.submitTransaction(transaction);

  return {
    hash: response.hash,
    ledger: response.ledger,
  };
}
