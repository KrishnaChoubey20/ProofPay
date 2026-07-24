import * as StellarSdk from "@stellar/stellar-sdk";

async function test() {
  console.log("Starting test...");
  try {
    const rpc = new StellarSdk.rpc.Server("https://soroban-testnet.stellar.org:443");
    
    // We need a funded account to test. I'll just use a random testnet account.
    const keypair = StellarSdk.Keypair.random();
    console.log("Funding account...", keypair.publicKey());
    await fetch("https://friendbot.stellar.org?addr=" + keypair.publicKey());
    
    await new Promise(r => setTimeout(r, 4000));
    const account = await rpc.getAccount(keypair.publicKey());
    
    // Use the native token (XLM) contract ID on testnet for testing
    // CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC
    const contract = new StellarSdk.Contract("CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC");
    
    // Create a transaction builder
    let txBuilder = new StellarSdk.TransactionBuilder(account, {
      fee: "10000000",
      networkPassphrase: StellarSdk.Networks.TESTNET,
    });
    
    // Let's simulate calling transfer twice. (Our contract calls token transfer internally, 
    // but directly calling transfer twice is a good test of assembleTransaction).
    const dest1 = StellarSdk.Keypair.random().publicKey();
    const dest2 = StellarSdk.Keypair.random().publicKey();

    txBuilder.addOperation(
      contract.call(
        "transfer",
        StellarSdk.Address.fromString(keypair.publicKey()).toScVal(),
        StellarSdk.Address.fromString(dest1).toScVal(),
        StellarSdk.nativeToScVal(BigInt(10000000), { type: "i128" })
      )
    );

    txBuilder.addOperation(
      contract.call(
        "transfer",
        StellarSdk.Address.fromString(keypair.publicKey()).toScVal(),
        StellarSdk.Address.fromString(dest2).toScVal(),
        StellarSdk.nativeToScVal(BigInt(15000000), { type: "i128" })
      )
    );
    
    const tx = txBuilder.setTimeout(180).build();
    
    console.log("Simulating...");
    const sim = await rpc.simulateTransaction(tx);
    if (StellarSdk.rpc.Api.isSimulationError(sim)) {
      console.log("Sim error:", sim.error);
    } else {
      console.log("Sim success!");
      const assembled = StellarSdk.rpc.assembleTransaction(tx, sim);
      console.log("Assembled successfully!");
    }

  } catch (e) {
    console.error(e);
  }
}
test();
