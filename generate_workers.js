import * as StellarSdk from "@stellar/stellar-sdk";
import fs from "fs";

async function main() {
  const workers = [];
  const csvLines = [];
  
  for (let i = 0; i < 10; i++) {
    const kp = StellarSdk.Keypair.random();
    workers.push({
      pubkey: kp.publicKey(),
      secret: kp.secret()
    });
    csvLines.push(`${kp.publicKey()}, ${Math.floor(Math.random() * 50) + 10}`);
  }
  
  fs.writeFileSync("10_workers.csv", csvLines.join("\n"));
  fs.writeFileSync("worker_secrets.json", JSON.stringify(workers, null, 2));
  
  console.log("Generated 10_workers.csv and worker_secrets.json");
}

main();
