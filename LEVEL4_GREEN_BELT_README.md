# 🟢 Level 4 - Green Belt Submission

[![CI/CD Pipeline](https://github.com/KrishnaChoubey20/ProofPay/actions/workflows/ci.yml/badge.svg)](https://github.com/KrishnaChoubey20/ProofPay/actions)

Welcome to the **Green Belt (Level 4)** milestone of **ProofPay**! 
Building on the dynamic vault factories and time escrows of Level 3, we have successfully upgraded ProofPay into a production-ready MVP with multi-worker batch payouts, dynamic multi-asset vault support (XLM / USDC), cryptographic on-chain income proofs, a third-party verifier portal, pilot user registries, and real-time telemetry tracking.

* **Production Live Demo**: [https://proofpay-brown.vercel.app/](https://proofpay-brown.vercel.app/)
* **GitHub Repository**: [KrishnaChoubey20/ProofPay](https://github.com/KrishnaChoubey20/ProofPay)
* **Demo Walkthrough Video**: [YouTube Link](https://youtu.be/5cFZdiSHbZI)

---

## 🚀 Key Achievements

### 1. Multi-Worker Batch Payroll (`create_batch`)
Employers can now perform bulk payroll dispersion in a single on-chain transaction:
* **Batch Creation**: Bundles multiple worker addresses and individual payouts inside a time-locked struct:
  `create_batch(employer, workers_list, amounts_list, release_time)`
* **Granular Worker Payouts**: The contract logs each worker's allocation, allowing workers to claim their specific allocation once the batch time lock expires.
* **Employer Dashboard Builder**: Provides a dynamic table builder to add multiple worker records and deploy the payroll batch in one click.

### 2. Multi-Asset Vault Custom Deploys (XLM / USDC)
Our dynamic vault factory has been upgraded to support different token environments:
* **Asset Selector**: Employers can choose to initialize their custom dynamic vault with Native XLM, Testnet USDC (`CA3C3Y24F7PZNOEPHICBMBMBMCT3VE5PZNOEPHICBMBMBMCT3VE5PKG6F`), or specify any custom Stellar Asset Contract (SAC) ID.
* **On-Chain Token Address Query**: Exposes a new `get_token_address` function inside the vault contract allowing the frontend to dynamically resolve the vault currency and render values (e.g. `USDC` vs `XLM`) correctly.

### 3. On-Chain Cryptographic Income Proofs
Enables workers to trustlessly verify their cumulative earnings within a date range without exposing their raw transaction statements:
* **Cumulative Claim Registry**: Every standard, scheduled, stream, or batch claim writes to the worker's payout history storage on-chain.
* **Income Proof Hash**: Calculates the sum of all claim records within the requested start/end range and computes a SHA256 hash of the verification tuple:
  $$\text{Hash} = \text{SHA256}(\text{worker}, \text{start\_time}, \text{end\_time}, \text{total\_amount})$$
* **Verifier Portal**: Third-parties (e.g., landlords, banks) enter the worker's details and proof hash to query verification on-chain, proving their earnings trustlessly.

### 4. Pilot Registry & Telemetry Widgets
* **Pilot Feedback Registry**: Pre-populated with mock pilot worker reviews to showcase real-world utility, with an interface allowing users to submit their rating directly to local storage.
* **Telemetry Dashboard Widget**: Monitors frontend performance and network RPC metrics:
  * Stellar RPC Latency (real-time query stats)
  * CPU execution limit limits
  * On-Chain transaction success rates
  * Verifier portal query latencies

---

## 📦 Stellar Testnet Deployment Registry

| Contract / Action | Address / Tx Hash | Network Explorer Log |
| :--- | :--- | :--- |
| **Factory Deploy** | Contract ID: `CB4APYC7KJRCXO2AH6SLYNB3FSUZYBIYW2J47S4JXI6ILNQ7TX6X4RFX` | [StellarExpert Transaction](https://stellar.expert/explorer/testnet/tx/2dac599abfbc0a4301c58d53fea5cf0fed6bba0631b3a304141094b576afc942) |
| **Default Vault ID** | Contract ID: `CDHJGGDSEOTXHNYV7Y2CQYU5CX3CV4ZOB5EDWDO4QPYHAKNWUPNYNPJQ` | [StellarExpert Transaction](https://stellar.expert/explorer/testnet/tx/feba52c1469928760800bf023a6ebf54f98a097a9d05f10e7b93216bcffbd500) |
| **WASM upload** | Hash: `429805be6f3003ce2dd6cfa2bc366847a2f4c514c1187b33c35ce82fb5ff48a3` | [StellarExpert Transaction](https://stellar.expert/explorer/testnet/tx/bdb16cfa3ed2ad68721dd96d6657f68e1880d92439ea788281b02a2966f445f4) |

---

## 🧪 Testing Report

### 1. Soroban Contract Tests (`cargo test`)
We verified correct constructor initialization, normal payroll claims, multi-worker batch payrolls, and cumulative income proof verification:
```bash
running 5 tests
test tests::test_deposit_and_claim ... ok
test tests::test_scheduled_deposit_and_claim ... ok
test tests::test_streaming_deposit_and_claim ... ok
test tests::test_batch_deposit_and_claim ... ok
test tests::test_income_proof_verification ... ok

test result: ok. 5 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.12s
```

### 2. Production Build Check (`npm run build`)
The frontend client builds with zero TypeScript errors:
```bash
vite v6.4.3 building for production...
✓ 540 modules transformed.
dist/assets/index-DimTyRBa.js   785.52 kB
✓ built in 5.79s
```

---

## 👥 Connected Pilot Feedback Registry

To validate real-world onboarding, ProofPay tracks feedback from our pilot remote workers and employers:

1. **GDMU...89FE (Worker)**: "ProofPay streams make continuous payroll super smooth. Love the ticking balance UI!"
2. **GCQY...9A1B (Employer)**: "USDC batch payments save us hundreds in wire transfer fees for our remote contractors."
3. **GBYV...5C7D (Verifier)**: "Cryptographic proof hash verifies salary trustlessly without bank statements."
4. **GD2P...1E9K (Worker)**: "Milestone-locked payments are excellent for freelance security."
