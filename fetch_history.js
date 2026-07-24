import * as StellarSdk from "@stellar/stellar-sdk";

async function main() {
  const rpc = new StellarSdk.rpc.Server("https://soroban-testnet.stellar.org:443");
  const contractId = "CCOQVDUZXNMXZGZRBOLVVHM2NGPD3NTT27UL6CJLOAMWRRFMVCW7P6GC";
  
  try {
    const ledgerInfo = await rpc.getLatestLedger();
    const endLedger = ledgerInfo.sequence;
    const startLedger = Math.max(1, endLedger - 28800); // Look back ~40 hours
    
    console.log(`Fetching events from ${startLedger} to ${endLedger}`);
    
    const events = await rpc.getEvents({
      startLedger,
      filters: [{
        type: "contract",
        contractIds: [contractId]
      }],
      limit: 50
    });
    
    console.log(`Found ${events.events.length} events!`);
    events.events.forEach(e => {
       console.log(`- Tx: ${e.txHash}`);
    });
  } catch(e) {
    console.error(e);
  }
}
main();
