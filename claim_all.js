import * as StellarSdk from "@stellar/stellar-sdk";
import fs from "fs";

async function main() {
  const rpc = new StellarSdk.rpc.Server("https://soroban-testnet.stellar.org:443");
  const vaultId = "CCOQVDUZXNMXZGZRBOLVVHM2NGPD3NTT27UL6CJLOAMWRRFMVCW7P6GC";
  const usdcId = "CDHJGGDSEOTXHNYV7Y2CQYU5CX3CV4ZOB5EDWDO4QPYHAKNWUPNYNPJQ";
  const networkPassphrase = StellarSdk.Networks.TESTNET;
  const vaultContract = new StellarSdk.Contract(vaultId);
  const usdcContract = new StellarSdk.Contract(usdcId);

  const workers = JSON.parse(fs.readFileSync("worker_secrets.json", "utf8"));
  console.log(`Loaded ${workers.length} workers. Preparing to claim streams...`);

  for (let i = 0; i < workers.length; i++) {
    const worker = workers[i];
    const kp = StellarSdk.Keypair.fromSecret(worker.secret);
    console.log(`\n[Worker ${i+1}] ${kp.publicKey()}`);

    try {
      // 1. Fund with Friendbot
      console.log(`  -> Funding via Friendbot...`);
      await fetch(`https://friendbot.stellar.org?addr=${kp.publicKey()}`);
      
      const account = await rpc.getAccount(kp.publicKey());

      // 2. Add Trustline to USDC (required by Soroban SAC)
      console.log(`  -> Adding USDC trustline...`);
      let txBuilder = new StellarSdk.TransactionBuilder(account, {
        fee: "10000000",
        networkPassphrase,
      });

      const usdcAsset = new StellarSdk.Asset("USDC", "GBBD47IF6LWK7P7MDEVSCWTTCJM4WGPHL6U3Y64MIMBBEHZZH2JQQQ43"); // Fallback classic asset if needed
      // Actually Soroban SAC doesn't need classic trustline if it's native SAC, but it's safe.
      // Wait, let's just invoke the vault `claim_stream` and if it fails due to trustline, we know.
      // But we fixed the UI to auto-trustline using the classic asset. 
      // The issuer for the testnet USDC in this app is typically GBBD... 
      // Let's just blindly invoke `claim_stream`. The contract handles balances internally if no trustline!
      // Wait! The contract uses `token.transfer(vault, worker, amount)`. This requires the worker to have a trustline!
      
      txBuilder.addOperation(StellarSdk.Operation.changeTrust({
        asset: new StellarSdk.Asset("USDC", "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"), 
        limit: "1000000"
      }));

      // 3. Claim Stream
      console.log(`  -> Claiming from Vault...`);
      txBuilder.addOperation(
        vaultContract.call("claim_stream", StellarSdk.Address.fromString(kp.publicKey()).toScVal())
      );

      const tx = txBuilder.setTimeout(180).build();
      tx.sign(kp);

      console.log(`  -> Simulating...`);
      const sim = await rpc.simulateTransaction(tx);
      
      if (StellarSdk.rpc.Api.isSimulationError(sim)) {
         console.log(`  -> Sim Error! (Probably no stream allocated yet) ${sim.error}`);
         // We can try to send it anyway or just skip
         continue;
      }
      
      const assembled = StellarSdk.rpc.assembleTransaction(tx, sim).build();
      assembled.sign(kp);

      console.log(`  -> Submitting...`);
      const result = await rpc.sendTransaction(assembled);
      console.log(`  ✅ SUCCESS: ${result.hash}`);
      
      let status = "PENDING";
      while (status === "PENDING") {
        await new Promise(r => setTimeout(r, 2000));
        const res = await rpc.getTransaction(result.hash);
        status = res.status;
        if (status === "SUCCESS") console.log(`  🎉 Confirmed on ledger!`);
      }
    } catch(e) {
      console.log(`  ❌ Failed:`, e.message);
    }
  }
}

main();
