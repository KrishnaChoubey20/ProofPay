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

### 2. Exclusive USDC Stablecoin Payrolls
Our dynamic vault factory has been upgraded to strictly enforce USDC testnet usage for all payroll environments:
* **Contract-Level Lock**: The `payroll-factory` and `payroll-vault` smart contracts strictly enforce the USDC testnet contract ID (`CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA`) at the constructor level.
* **Security**: This prevents deployment of malicious or "fake" tokens, ensuring workers are always paid in authentic USDC stablecoins.
* **Unified Currency**: The entire frontend UI and backend logic uses USDC natively, ensuring pricing stability and a consistent token economy for employers and workers alike.

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
| **Factory Deploy** | Contract ID: `CCUC235LIRROH7TVU2ZPHXANNAGF6HVESV4WHKHUNKLRFJEDRHFF3DAP` | [StellarExpert Transaction](https://stellar.expert/explorer/testnet/tx/0f6f653ba42320abc980dff8499082107569dfdc6edf1d3a5cae769994c23cda) |
| **WASM upload** | Hash: `cffec1bddaa312890ceb812eb16ce16cc8c05d13fd0e7f45fc951dd5976638fa` | [StellarExpert Transaction](https://stellar.expert/explorer/testnet/tx/790723f5bce6d8791828c977fc9ce08a0211b155390ab59e70b0639f73fe5e2d) |

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

To rigorously validate real-world onboarding, ProofPay actively collects and audits feedback from remote contractors and employers interacting with our decentralized streaming and time-locked vaults.

* **📄 Complete Pilot User Feedback & Onboarding Registry**: [View Dedicated Markdown Documentation](./PILOT_USER_FEEDBACK_REGISTRY.md)
* **📊 Raw Live Evidence Google Sheet**: [View Real User Feedback Responses & Timestamps](https://docs.google.com/spreadsheets/d/1w3wulMS3E9hz4aagpLwuUOaBN7Sfrq9RnwejelcNQuY/edit?usp=sharing)
* **📝 Pilot Tester Onboarding & Feedback Google Form**: [Open User Testing Google Form](https://forms.gle/ELxvMWXgsaV8FavM8)

* Pilot remote contractors connect their testnet wallets via **Freighter**, experience instant payouts, streaming escrows, and cryptographic income proof verifications directly on-chain (`invokeHostFunction`).
* Every submission is backed by an explicit **Soroban smart contract transaction hash** verified on StellarExpert.
* Detailed reviews emphasize high satisfaction with our intuitive GUI, lightning-fast execution times, and responsive transaction flow.

---

## ✅ Level 4 - Green Belt Submission Checklist

We have rigorously followed the Green Belt requirements to ensure ProofPay is a production-ready MVP with real user validation.

### Production MVP
- [x] **Fully functional production-ready MVP**: Multi-worker batch payrolls and cryptographic income proofs are fully functional.
- [x] **Stable frontend and smart contract architecture**: Smart contracts enforce strict USDC locking; frontend handles errors and edge cases cleanly.
- [x] **Mobile responsive UI**: Sidebar collapses into a hamburger menu; tables and widgets scale perfectly on mobile devices.
- [x] **Proper loading states and error handling**: `stellar-sdk` transactions are wrapped in try-catch blocks with UI toast notifications for success/failure.

### User Onboarding
- [x] **Minimum 10 real users onboarded**: See the **Proof of Wallet Interactions** below.
- [x] **Proof of wallet interactions required**: 10 external pilot test users successfully onboarded, connected their individual testnet wallets via Freighter, and established verified on-chain Soroban smart contract interactions.
- [x] **Basic user feedback collection mandatory**: Implemented via the *Pilot Feedback Registry* on the dashboard.

### Product Quality
- [x] **Production deployment required**: Live at [https://proofpay-brown.vercel.app/](https://proofpay-brown.vercel.app/)
- [x] **Monitoring and analytics integration**: Built-in RPC latency tracking, execution limit telemetry, and Vercel Analytics.
- [x] **Optimized user experience**: Instant UI updates, skeleton loaders, and intuitive multi-step modals.
- [x] **Proper project structure and documentation**: Clean `src/lib`, `contracts/`, and `README.md` structure.

### Technical Standards
- [x] **Smart contracts deployed on Stellar testnet**: Factory deployed at `CCUC235LIRROH7TVU2ZPHXANNAGF6HVESV4WHKHUNKLRFJEDRHFF3DAP`.
- [x] **Minimum 15+ meaningful commits**: Completed, covering USDC enforcement, batch payments, and UI improvements.
- [x] **Public GitHub repository required**: [KrishnaChoubey20/ProofPay](https://github.com/KrishnaChoubey20/ProofPay)



### Demo & Review
- [x] **Live demo video showcasing complete functionality**: [YouTube Link](https://youtu.be/5cFZdiSHbZI)
- [x] **Screenshots**: 
  - **Product UI:**  
    ![Product UI](./public/screenshots/new%20ui.png)
  - **Mobile Responsive Design:**  
    ![Mobile UI](./public/screenshots/mobile%20view%20sidebar.png)
  - **Analytics Monitoring:**  
    ![Analytics](./public/screenshots/vercel%20analytics.png)

---

### 🧾 Proof of 10+ User Wallet Interactions (Testnet) & Evidence Registry
To rigorously validate our smart contract architecture under production load, 10 external pilot testers and remote contractors connected their Freighter wallets and independently interacted with our platform on the Stellar Testnet. Below is our verified evidence table connecting tester accounts, live wallet addresses, feature evaluations, explicit **Soroban Smart Contract Invocations (`invokeHostFunction`)**, and real-time user UX reviews:

* **📄 Complete Evidence Registry File**: [Read Full Onboarding Registry](./PILOT_USER_FEEDBACK_REGISTRY.md)
* **📊 Raw Live Google Sheet Responses**: [View Complete Responses & Timestamps](https://docs.google.com/spreadsheets/d/1w3wulMS3E9hz4aagpLwuUOaBN7Sfrq9RnwejelcNQuY/edit?usp=sharing)
* **📝 Pilot Tester Google Form**: [Submit & Review Pilot Feedback](https://forms.gle/ELxvMWXgsaV8FavM8)

| # | Timestamp | Tester Email | Stellar Testnet Wallet (Worker) | Features Tested | Verified Soroban Contract Interaction (Tx Link) | Rating | User Feedback & UX Review |
|:-:|:---|:---|:---|:---|:---:|:---:|:---|
| **1** | 28/07/2026 16:53:51 | `gf201007@gmail.com` | `GDJYCVRN4ZARTGVPCCCSY5L33EBWMXOQO4WRFGQLBBEIC5XRZ3RBU34T` | ⚡ Direct Instant Payroll | [View Soroban Call Tx](https://stellar.expert/explorer/testnet/tx/5f7f3df46d0f306309ce3eab31bfed91ba1ba9c652eace11f513a6aece035166) | ⭐⭐⭐⭐⭐ (5/5) | "Amazing GUI and super clean transaction flow!" |
| **2** | 28/07/2026 16:55:23 | `Mausamkumri871gamil.com` | `GAEL5RXFUYGQC46CTOX27IVEGM3OJMUDXMIOIUGD6XE32HM24BDA7V4K` | ⚡ Direct Payroll, 🌊 Streaming Escrow, ⏳ Time-Locked Escrow, 🔐 Income Proofs | [View Soroban Call Tx](https://stellar.expert/explorer/testnet/tx/bb5a8894b8851003c2bbb4c2d40550090d9bc24844f40ddf10ac39b5b4a4eace) | ⭐⭐⭐⭐⭐ (5/5) | "The transaction flow is super smooth and Freighter wallet connected to the smart contract without any lag." |
| **3** | 28/07/2026 16:57:29 | `sonikeshav838@gmail.com` | `GD7O7YL2AK4LCN4F6KK3D25XJQRCEXK5JWQXMTCDZZYGEN45UZROI6HB` | ⚡ Direct Payroll, 🌊 Streaming Escrow, ⏳ Time-Locked Escrow | [View Soroban Call Tx](https://stellar.expert/explorer/testnet/tx/a6f577631a4249a57cf68ed2e7c55e152620eda921833e9fe99a94b8c0f12364) | ⭐⭐⭐⭐⭐ (5/5) | "Loved the intuitive UI!" |
| **4** | 28/07/2026 17:05:53 | `Omsoni54441@gmail.com` | `GBOQ32HBIVDIM7FDXKVDFIPIVAG5UKKQXQMKPPO7HJVKQXKGQA3J25I3` | ⚡ Direct Payroll, 🌊 Streaming Escrow, ⏳ Time-Locked Escrow, 🔐 Income Proofs | [View Soroban Call Tx](https://stellar.expert/explorer/testnet/tx/9eb7be645b0414a776340688a3c5efe795d30d44f45842da5082ab86c2af8157) | ⭐⭐⭐⭐⭐ (5/5) | "Great user experience" |
| **5** | 28/07/2026 17:05:23 | `palakrajak2233@gmail.com` | `GDOGC4SDTYXGBMLJH6UAKIFFBIEEH36DTZT5FBNBIFLEM7GK2EACNFB5` | ⚡ Direct Payroll, 🌊 Streaming Escrow, ⏳ Time-Locked Escrow | [View Soroban Call Tx](https://stellar.expert/explorer/testnet/tx/fc9d49e814cd7b9fc7fe68699e0b02ab911ebc16a86dd7593aea6b64646d0293) | ⭐⭐⭐⭐⭐ (5/5) | "Very impressive dashboard design!" |
| **6** | 28/07/2026 17:15:29 | `Siddharthguru19@gmail.com` | `GBXHGX27Y2LMWYC3NOHHQL6MR25NBNKMEH3S4OK252RWORITDDYS2TRF` | ⚡ Direct Payroll, 🌊 Streaming Escrow | [View Soroban Call Tx](https://stellar.expert/explorer/testnet/tx/c4f6c0438ce47decc175b982a3426013783d852bd15c5b50711c8ca6f4514773) | ⭐⭐⭐⭐⭐ (5/5) | "The entire GUI and interaction flow feels premium and responsive." |
| **7** | 28/07/2026 17:20:56 | `rathorerohan94579@gmail.com` | `GAKVZK6CR4BR6WTFFFXIGTLSI4PA6RGQVWI5HGYDPIXIYJHYK4YTRZQM` | ⚡ Direct Instant Payroll | [View Soroban Call Tx](https://stellar.expert/explorer/testnet/tx/88f62e5506bd4c3df9c73a7deaa0ad93254faf6f6b6c4d936c470ef10b2d53ab) | ⭐⭐⭐⭐⭐ (5/5) | "Smooth wallet onboarding" |
| **8** | 28/07/2026 17:25:10 | `aakashrajpoot274@gmail.com` | `GBNULPUTXZ4XKFJ5HJ5NR5W42K3CIA7GIRUMIDV4GP2PIHZ3ATMYKTZH` | ⚡ Direct Payroll, 🌊 Streaming Escrow | [View Soroban Call Tx](https://stellar.expert/explorer/testnet/tx/f288b7eb04c1586d0bb5dcd84f5948a7957fc5ef3885e7a17dc65d5ac503da12) | ⭐⭐⭐⭐⭐ (5/5) | "Clean layout, beautiful UI" |
| **9** | 28/07/2026 17:28:30 | `devkirajak722@gmail.com` | `GAKKP6MJVSU2RLTXT3LV5HMV3OUMH2OAOWS7NBAJQGSRXFOJGYS7QOBP` | ⚡ Direct Payroll, 🌊 Streaming Escrow, ⏳ Time-Locked Escrow | [View Soroban Call Tx](https://stellar.expert/explorer/testnet/tx/69fb5cbcc6d3178604c4d05fc895973f52037d6199d90f007fa77a173049c178) | ⭐⭐⭐⭐☆ (4/5) | "Really liked how seamless the GUI claiming flow is! Everything ran so quickly on testnet." |
| **10**| 28/07/2026 17:30:06 | `nikunjdarji1432@gmail.com` | `GB74FH7VOWUC4IHHB237QJF4QSBHS2FFTEYOSTUWCAGHKSZNC2UJQGJS` | ⚡ Direct Payroll, 🌊 Streaming Escrow, ⏳ Time-Locked Escrow | [View Soroban Call Tx](https://stellar.expert/explorer/testnet/tx/e77521fe1680747cc22db551ed27f029855399ce08e45e16886928f85f933dc5) | ⭐⭐⭐⭐⭐ (5/5) | "Fantastic UI design and super quick transaction times" |

*All transactions above reflect verified, independent smart contract interactions executed on the Stellar Testnet.*
