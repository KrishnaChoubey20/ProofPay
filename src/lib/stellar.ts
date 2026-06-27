import * as StellarSdk from "@stellar/stellar-sdk";
import { Buffer } from "buffer";
import { addressArg, xlmToStroopsArg } from "./contractArgs";

interface SimulationSuccess {
  result?: {
    retval: StellarSdk.xdr.ScVal;
  };
}

interface SimulationError {
  error: string;
}

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

// ── Factory & Vault contract IDs ─────────────────────────────────────────────
export const FACTORY_CONTRACT_ID = "CB4APYC7KJRCXO2AH6SLYNB3FSUZYBIYW2J47S4JXI6ILNQ7TX6X4RFX";
export const VAULT_CONTRACT_ID = "CD35FOUT64RGU4UKZQHCQPPDSPB7XIJ6AVRLFYN2NDR3MFJG5HL4VSRD";

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

// ── Soroban contract invocation & submission ──────────────────────────────────

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
    const errMsg = (simulation as SimulationError).error;
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

  // Poll until confirmed
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

// ── Factory operations ────────────────────────────────────────────────────────

export async function getVaultFromFactory(
  adminAddress: string,
  sourceAddress: string = "GDRM7Y5MDHEVHV3YPVPGYXSQI5KCCAN4UBMNMJAUUDYIBHGDF6WMNZV3"
): Promise<string | null> {
  try {
    const account = await rpc.getAccount(sourceAddress);
    const contract = new StellarSdk.Contract(FACTORY_CONTRACT_ID);
    const tx = new StellarSdk.TransactionBuilder(account, {
      fee: "100000",
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(contract.call("get_vault", addressArg(adminAddress)))
      .setTimeout(30)
      .build();

    const simulation = await rpc.simulateTransaction(tx);
    if (StellarSdk.rpc.Api.isSimulationSuccess(simulation)) {
      const success = simulation as SimulationSuccess;
      if (success.result) {
        const val = success.result.retval;
        const native = StellarSdk.scValToNative(val);
        return native ? String(native) : null;
      }
    }
    return null;
  } catch {
    return null;
  }
}

export async function buildDeployVaultXdr(
  sourceAddress: string,
  vaultAdmin: string,
  nativeTokenAddress: string,
  saltHex?: string
): Promise<string> {
  let saltBytes = new Uint8Array(32);
  if (saltHex) {
    const matches = saltHex.match(/.{1,2}/g);
    if (matches) {
      const bytes = new Uint8Array(matches.map((byte) => parseInt(byte, 16)));
      saltBytes.set(bytes.slice(0, 32));
    }
  }
  const salt = StellarSdk.xdr.ScVal.scvBytes(Buffer.from(saltBytes.buffer));
  return invokeContract(
    sourceAddress,
    FACTORY_CONTRACT_ID,
    "deploy_vault",
    [
      addressArg(vaultAdmin),
      addressArg(nativeTokenAddress),
      salt,
    ]
  );
}

// ── Vault query/view helpers ─────────────────────────────────────────────────

export async function getContractAllocation(
  contractId: string,
  workerAddress: string
): Promise<bigint> {
  try {
    const workerScAddr = addressArg(workerAddress);
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
    if (StellarSdk.rpc.Api.isSimulationSuccess(simulation)) {
      const success = simulation as SimulationSuccess;
      if (success.result) {
        const val = success.result.retval;
        return BigInt(StellarSdk.scValToNative(val));
      }
    }
    return 0n;
  } catch {
    return 0n;
  }
}

export async function getScheduledAllocations(
  vaultId: string,
  workerAddress: string,
  sourceAddress: string = "GDRM7Y5MDHEVHV3YPVPGYXSQI5KCCAN4UBMNMJAUUDYIBHGDF6WMNZV3"
): Promise<{ amount: bigint; releaseTime: bigint }[]> {
  try {
    const account = await rpc.getAccount(sourceAddress);
    const contract = new StellarSdk.Contract(vaultId);
    const tx = new StellarSdk.TransactionBuilder(account, {
      fee: "100000",
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(contract.call("get_scheduled_allocations", addressArg(workerAddress)))
      .setTimeout(30)
      .build();

    const simulation = await rpc.simulateTransaction(tx);
    if (StellarSdk.rpc.Api.isSimulationSuccess(simulation)) {
      const success = simulation as SimulationSuccess;
      if (success.result) {
        const val = success.result.retval;
        const native = StellarSdk.scValToNative(val);
        if (Array.isArray(native)) {
          return (native as { amount: string | number | bigint; release_time: string | number | bigint }[]).map((item) => ({
            amount: BigInt(item.amount),
            releaseTime: BigInt(item.release_time),
          }));
        }
      }
    }
    return [];
  } catch {
    return [];
  }
}

export async function getStreamDetails(
  vaultId: string,
  workerAddress: string,
  sourceAddress: string = "GDRM7Y5MDHEVHV3YPVPGYXSQI5KCCAN4UBMNMJAUUDYIBHGDF6WMNZV3"
): Promise<{ sender: string; totalAmount: bigint; startTime: bigint; endTime: bigint; claimedAmount: bigint } | null> {
  try {
    const account = await rpc.getAccount(sourceAddress);
    const contract = new StellarSdk.Contract(vaultId);
    const tx = new StellarSdk.TransactionBuilder(account, {
      fee: "100000",
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(contract.call("get_stream", addressArg(workerAddress)))
      .setTimeout(30)
      .build();

    const simulation = await rpc.simulateTransaction(tx);
    if (StellarSdk.rpc.Api.isSimulationSuccess(simulation)) {
      const success = simulation as SimulationSuccess;
      if (success.result) {
        const val = success.result.retval;
        const native = StellarSdk.scValToNative(val) as {
          sender: string | number | bigint;
          total_amount: string | number | bigint;
          start_time: string | number | bigint;
          end_time: string | number | bigint;
          claimed_amount: string | number | bigint;
        } | null;
        if (native) {
          return {
            sender: String(native.sender),
            totalAmount: BigInt(native.total_amount),
            startTime: BigInt(native.start_time),
            endTime: BigInt(native.end_time),
            claimedAmount: BigInt(native.claimed_amount),
          };
        }
      }
    }
    return null;
  } catch {
    return null;
  }
}

export async function getStreamClaimable(
  vaultId: string,
  workerAddress: string,
  sourceAddress: string = "GDRM7Y5MDHEVHV3YPVPGYXSQI5KCCAN4UBMNMJAUUDYIBHGDF6WMNZV3"
): Promise<bigint> {
  try {
    const account = await rpc.getAccount(sourceAddress);
    const contract = new StellarSdk.Contract(vaultId);
    const tx = new StellarSdk.TransactionBuilder(account, {
      fee: "100000",
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(contract.call("get_stream_claimable", addressArg(workerAddress)))
      .setTimeout(30)
      .build();

    const simulation = await rpc.simulateTransaction(tx);
    if (StellarSdk.rpc.Api.isSimulationSuccess(simulation)) {
      const success = simulation as SimulationSuccess;
      if (success.result) {
        const val = success.result.retval;
        return BigInt(StellarSdk.scValToNative(val));
      }
    }
    return 0n;
  } catch {
    return 0n;
  }
}

// ── Vault transaction builder helpers ────────────────────────────────────────

export async function buildDepositScheduledXdr(
  sourceAddress: string,
  vaultId: string,
  worker: string,
  amountXlm: string,
  releaseTimeSeconds: number
): Promise<string> {
  return invokeContract(
    sourceAddress,
    vaultId,
    "deposit_scheduled",
    [
      addressArg(sourceAddress),
      addressArg(worker),
      xlmToStroopsArg(amountXlm),
      StellarSdk.nativeToScVal(BigInt(releaseTimeSeconds), { type: "u64" }),
    ]
  );
}

export async function buildClaimScheduledXdr(
  sourceAddress: string,
  vaultId: string
): Promise<string> {
  return invokeContract(
    sourceAddress,
    vaultId,
    "claim_scheduled",
    [addressArg(sourceAddress)]
  );
}

export async function buildCreateStreamXdr(
  sourceAddress: string,
  vaultId: string,
  worker: string,
  amountXlm: string,
  startTimeSeconds: number,
  endTimeSeconds: number
): Promise<string> {
  return invokeContract(
    sourceAddress,
    vaultId,
    "create_stream",
    [
      addressArg(sourceAddress),
      addressArg(worker),
      xlmToStroopsArg(amountXlm),
      StellarSdk.nativeToScVal(BigInt(startTimeSeconds), { type: "u64" }),
      StellarSdk.nativeToScVal(BigInt(endTimeSeconds), { type: "u64" }),
    ]
  );
}

export async function buildClaimStreamXdr(
  sourceAddress: string,
  vaultId: string
): Promise<string> {
  return invokeContract(
    sourceAddress,
    vaultId,
    "claim_stream",
    [addressArg(sourceAddress)]
  );
}

// ── Event streaming ───────────────────────────────────────────────────────────

export type VaultEvent = {
  type:
    | "PayrollDeposited"
    | "PayrollClaimed"
    | "ScheduledDeposited"
    | "ScheduledClaimed"
    | "StreamCreated"
    | "StreamClaimed";
  from?: string;
  worker: string;
  amount: bigint;
  ledger: number;
  txHash: string;
  releaseTime?: bigint;
  startTime?: bigint;
  endTime?: bigint;
};

export function streamContractEvents(
  contractIds: string[],
  onEvent: (event: VaultEvent) => void,
  intervalMs = 5000
): () => void {
  let running = true;
  let lastLedger = 0;

  // Filter out invalid/empty contract IDs
  const activeContractIds = contractIds.filter(Boolean);
  if (activeContractIds.length === 0) return () => {};

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
            contractIds: activeContractIds,
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
            } else if (topicStr === "scheduled_deposited" && topics.length >= 5) {
              onEvent({
                type: "ScheduledDeposited",
                from: StellarSdk.Address.fromScVal(topics[1]).toString(),
                worker: StellarSdk.Address.fromScVal(topics[2]).toString(),
                amount: BigInt(StellarSdk.scValToNative(topics[3])),
                releaseTime: BigInt(StellarSdk.scValToNative(topics[4])),
                ledger: evt.ledger,
                txHash: evt.txHash,
              });
            } else if (topicStr === "scheduled_claimed" && topics.length >= 3) {
              onEvent({
                type: "ScheduledClaimed",
                worker: StellarSdk.Address.fromScVal(topics[1]).toString(),
                amount: BigInt(StellarSdk.scValToNative(topics[2])),
                ledger: evt.ledger,
                txHash: evt.txHash,
              });
            } else if (topicStr === "stream_created" && topics.length >= 6) {
              onEvent({
                type: "StreamCreated",
                from: StellarSdk.Address.fromScVal(topics[1]).toString(),
                worker: StellarSdk.Address.fromScVal(topics[2]).toString(),
                amount: BigInt(StellarSdk.scValToNative(topics[3])),
                startTime: BigInt(StellarSdk.scValToNative(topics[4])),
                endTime: BigInt(StellarSdk.scValToNative(topics[5])),
                ledger: evt.ledger,
                txHash: evt.txHash,
              });
            } else if (topicStr === "stream_claimed" && topics.length >= 3) {
              onEvent({
                type: "StreamClaimed",
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
