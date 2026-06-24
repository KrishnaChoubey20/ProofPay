import * as StellarSdk from "@stellar/stellar-sdk";

// ── Network constants ────────────────────────────────────────────────────────
export const STELLAR_EXPERT_TESTNET = "https://stellar.expert/explorer/testnet/tx";
export const NETWORK_PASSPHRASE = StellarSdk.Networks.TESTNET;

// ── Horizon (classic XLM payments) ──────────────────────────────────────────
export const horizon = new StellarSdk.Horizon.Server(
  "https://horizon-testnet.stellar.org"
);

// ── Soroban RPC (contract calls & events) ────────────────────────────────────
export const rpc = new StellarSdk.rpc.Server(
  "https://soroban-testnet.stellar.org"
);

// ── Vault contract ID  (filled after deployment) ─────────────────────────────
// Replace this placeholder with the real C… contract address after you run:
//   stellar contract deploy ...
export const VAULT_CONTRACT_ID: string =
  "CD35FOUT64RGU4UKZQHCQPPDSPB7XIJ6AVRLFYN2NDR3MFJG5HL4VSRD";

// ── Utilities ─────────────────────────────────────────────────────────────────

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

// ── Classic payment helpers ───────────────────────────────────────────────────

export async function getNativeBalance(address: string) {
  try {
    const account = await horizon.loadAccount(address);
    const nativeBalance = account.balances.find(
      (balance) => balance.asset_type === "native"
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
      })
    )
    .setTimeout(180)
    .build();
  return transaction.toXDR();
}

export async function submitSignedTransaction(signedXdr: string) {
  const transaction = StellarSdk.TransactionBuilder.fromXDR(
    signedXdr,
    NETWORK_PASSPHRASE
  ) as StellarSdk.Transaction;
  const response = await horizon.submitTransaction(transaction);
  return { hash: response.hash, ledger: response.ledger };
}

// ── Soroban contract helpers ──────────────────────────────────────────────────

/**
 * Build a simulated+assembled Soroban transaction XDR ready for signing.
 * Handles simulation and resource estimation automatically.
 */
export async function invokeContract(
  sourceAddress: string,
  contractId: string,
  method: string,
  args: StellarSdk.xdr.ScVal[]
): Promise<string> {
  const account = await rpc.getAccount(sourceAddress);
  const contract = new StellarSdk.Contract(contractId);

  let tx = new StellarSdk.TransactionBuilder(account, {
    fee: String(10_000_000), // generous fee ceiling for Soroban
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(180)
    .build();

  // Simulate to get resource estimates and detect errors early
  const simulation = await rpc.simulateTransaction(tx);

  if (StellarSdk.rpc.Api.isSimulationError(simulation)) {
    const errMsg = (simulation as any).error;
    // Surface InsufficientBalance for the fee-estimation check
    if (
      errMsg.toLowerCase().includes("balance") ||
      errMsg.toLowerCase().includes("insufficient")
    ) {
      throw new Error(
        "insufficient balance: Your XLM balance is too low to cover this transaction + fees."
      );
    }
    throw new Error(`Contract simulation failed: ${errMsg}`);
  }

  // Assemble with authorizations + resource footprint
  tx = StellarSdk.rpc.assembleTransaction(tx, simulation).build();
  return tx.toXDR();
}

/**
 * Submit a signed Soroban transaction and poll until confirmation.
 */
export async function submitSorobanTx(signedXdr: string): Promise<{
  hash: string;
  ledger?: number;
  returnValue?: StellarSdk.xdr.ScVal;
}> {
  const tx = StellarSdk.TransactionBuilder.fromXDR(
    signedXdr,
    NETWORK_PASSPHRASE
  ) as StellarSdk.Transaction;

  const sendResponse = await rpc.sendTransaction(tx);

  if (sendResponse.status === "ERROR") {
    throw new Error(
      `Transaction submission failed: ${JSON.stringify(sendResponse.errorResult)}`
    );
  }

  const hash = sendResponse.hash;

  // Poll until confirmed (NOT_FOUND = still processing)
  let attempt = 0;
  while (attempt < 30) {
    await new Promise((r) => setTimeout(r, 2000));
    const result = await rpc.getTransaction(hash);

    if (result.status === StellarSdk.rpc.Api.GetTransactionStatus.SUCCESS) {
      return {
        hash,
        ledger: result.ledger,
        returnValue: result.returnValue,
      };
    }

    if (result.status === StellarSdk.rpc.Api.GetTransactionStatus.FAILED) {
      throw new Error(`Transaction failed on-chain. Hash: ${hash}`);
    }

    attempt++;
  }

  throw new Error(`Transaction timed out after 60 s. Hash: ${hash}`);
}

/**
 * Read a worker's claimable allocation directly from contract persistent storage.
 */
export async function getContractAllocation(
  contractId: string,
  workerAddress: string
): Promise<bigint> {
  try {
    // Build the Allocation(Address) persistent key using nativeToScVal for the contracttype enum variant
    const workerScAddr = StellarSdk.Address.fromString(workerAddress).toScVal();
    const key = StellarSdk.xdr.ScVal.scvVec([
      StellarSdk.xdr.ScVal.scvSymbol("Allocation"),
      workerScAddr,
    ]);

    const ledgerKey = StellarSdk.xdr.LedgerKey.contractData(
      new StellarSdk.xdr.LedgerKeyContractData({
        contract: new StellarSdk.Address(contractId).toScAddress(),
        key,
        durability: StellarSdk.xdr.ContractDataDurability.persistent(),
      })
    );

    const entries = await rpc.getLedgerEntries(ledgerKey);
    if (!entries.entries || entries.entries.length === 0) return 0n;

    const val = entries.entries[0].val.contractData().val();
    const native = StellarSdk.scValToNative(val);
    return BigInt(native);
  } catch {
    return 0n;
  }
}

/**
 * Query the total XLM deposited in the vault contract by simulating get_total_deposited call.
 */
export async function getVaultTotalDeposited(
  contractId: string,
  sourceAddress: string
): Promise<bigint> {
  try {
    const account = await rpc.getAccount(sourceAddress);
    const contract = new StellarSdk.Contract(contractId);
    const tx = new StellarSdk.TransactionBuilder(account, {
      fee: "100000",
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(contract.call("get_total_deposited"))
      .setTimeout(30)
      .build();

    const simulation = await rpc.simulateTransaction(tx);
    if (StellarSdk.rpc.Api.isSimulationSuccess(simulation) && (simulation as any).result) {
      const val = (simulation as any).result.retval;
      return BigInt(StellarSdk.scValToNative(val));
    }
    return 0n;
  } catch {
    return 0n;
  }
}

// ── Event streaming ───────────────────────────────────────────────────────────

export type VaultEvent = {
  type: "PayrollDeposited" | "PayrollClaimed";
  from?: string;
  worker: string;
  amount: bigint;
  ledger: number;
  txHash: string;
};

/**
 * Poll getEvents() for PayrollDeposited and PayrollClaimed events.
 * Calls `onEvent` for each new event found.
 * Returns a cleanup function to stop polling.
 */
export function streamContractEvents(
  contractId: string,
  onEvent: (event: VaultEvent) => void,
  intervalMs = 5000
): () => void {
  let running = true;
  let lastLedger = 0;

  async function poll() {
    if (!running) return;

    try {
      const ledgerInfo = await rpc.getLatestLedger();
      const endLedger = ledgerInfo.sequence;
      const startLedger = lastLedger > 0 ? lastLedger : Math.max(1, endLedger - 200);

      if (startLedger >= endLedger) {
        if (running) setTimeout(poll, intervalMs);
        return;
      }

      const response = await rpc.getEvents({
        startLedger,
        filters: [
          {
            type: "contract",
            contractIds: [contractId],
            topics: [["*"]],
          },
        ],
        limit: 100,
      });

      lastLedger = endLedger;

      if (response.events && response.events.length > 0) {
        for (const evt of response.events) {
          try {
            const topics = evt.topic;
            if (!topics || topics.length === 0) continue;

            const topicStr = StellarSdk.scValToNative(topics[0]) as string;

            if (topicStr === "payroll_deposited" && topics.length >= 4) {
              onEvent({
                type: "PayrollDeposited",
                from: StellarSdk.Address.fromScVal(topics[1]).toString(),
                worker: StellarSdk.Address.fromScVal(topics[2]).toString(),
                amount: BigInt(StellarSdk.scValToNative(topics[3])),
                ledger: evt.ledger,
                txHash: evt.txHash,
              });
            } else if (topicStr === "payroll_claimed" && topics.length >= 3) {
              onEvent({
                type: "PayrollClaimed",
                worker: StellarSdk.Address.fromScVal(topics[1]).toString(),
                amount: BigInt(StellarSdk.scValToNative(topics[2])),
                ledger: evt.ledger,
                txHash: evt.txHash,
              });
            }
          } catch {
            // skip malformed events
          }
        }
      }
    } catch {
      // network error — will retry
    }

    if (running) setTimeout(poll, intervalMs);
  }

  void poll();

  return () => {
    running = false;
  };
}
