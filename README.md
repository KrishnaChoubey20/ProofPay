# 💳 ProofPay

[![CI/CD Pipeline](https://github.com/KrishnaChoubey20/ProofPay/actions/workflows/ci.yml/badge.svg)](https://github.com/KrishnaChoubey20/ProofPay/actions)

> **Privacy-Preserving Payroll, Dynamic On-Chain Vaults & Real-Time Streams for Global Remote Teams**
> 
> ProofPay is a decentralized payroll platform built on **Stellar Testnet** and **Soroban Smart Contracts**. It allows employers to set up secure vault escrows, deploy dynamic custom vaults via an on-chain factory, schedule locked funds, stream real-time continuous payroll, and enables workers to claim their allocations in a secure, non-interactive manner.

---

## 🏆 Level 4 - Green Belt Submission Checklist

We have successfully completed all requirements for the Level 4 Green Belt, building a production-ready MVP with real users.

### Production MVP
- [x] **Fully functional production-ready MVP:** Employer and Worker dashboards with live on-chain operations.
- [x] **Stable frontend & contract architecture:** React + Vite + TypeScript frontend interacting with Soroban Rust Smart Contracts.
- [x] **Mobile responsive UI:** Grid layouts and media queries ensure the app is fully usable on mobile devices.
- [x] **Proper loading states and error handling:** Global toast notifications, transaction status banners (idle, pending, success, error) and comprehensive try/catch blocks.

### User Onboarding (10+ Real Wallet Interactions)
- [x] **Minimum 10 real users onboarded:** See the [Proof of Interactions](#-proof-of-10-wallet-interactions) section below for transaction hashes of 10 workers claiming streamed payroll on testnet!
- [x] **Proof of wallet interactions required:** Documented via Stellar Expert links below.
- [x] **Basic user feedback collection:** Implemented a persistent **Feedback Widget** in the bottom right corner of the app for immediate pilot user input.

### Product Quality
- [x] **Production deployment:** Live on Vercel.
- [x] **Monitoring and analytics integration:** `@vercel/analytics` integrated for real-time traffic and usage monitoring.
- [x] **Proper project structure and documentation:** Professional README and isolated React component structure.

### Technical Standards
- [x] **Smart contracts deployed on Stellar testnet:** Contract ID listed below.
- [x] **Minimum 15+ meaningful commits:** History contains over 30 meaningful, descriptive commits.
- [x] **Public GitHub repository:** Open source!

### Demo & Review
- [x] **Live demo video:** *(Link below)*
- [x] **Screenshots:** *(Added below)*

---

## 📊 Proof of 10+ Wallet Interactions

Below is the cryptographic proof of 10 distinct worker wallets interacting with the deployed Vault Contract (`CCOQVDUZXNMXZGZRBOLVVHM2NGPD3NTT27UL6CJLOAMWRRFMVCW7P6GC`) on the Stellar Testnet, covering all three core payroll features.

| Worker Address | Feature | Deposit Tx (Employer) | Claim Tx (Worker) |
|---|---|---|---|
| `GBFXS4SKNVEXCZT5CYGZAGYTWACBTVINCLZHOI7XFGQZVH6Q5O4QWOF2` | **Instant** | [852acef7...](https://stellar.expert/explorer/testnet/tx/852acef78513b198ef179144f3362b703740bef0d66b1ab3d23e6d7606d281a0) | N/A (Direct Alloc) |
| `GAIITXJ4ACMK6ZNXG2FFLA6FGSEFWYMWCDMUPV6PPZBV4FW3SMORXSSP` | **Instant** | [c008ddf6...](https://stellar.expert/explorer/testnet/tx/c008ddf6514fa8a3f6851e587fcd3cffd8c4788686cf0eab1c11a3041ffd74a0) | N/A (Direct Alloc) |
| `GBVFCNDGI7XFKGLW2WHMRRQ5P5D6CSWCKHH4N3A7IOJCOW5XEIZ52IO2` | **Instant** | [cf200b52...](https://stellar.expert/explorer/testnet/tx/cf200b526b0dbf3a0a4140bc07184e556b3a8308792c1016a5f84a0839ed8aa4) | N/A (Direct Alloc) |
| `GA35AR2GEJIQXQ6VJHIVACOQCZPPFGZIVLASXLRZJY7JZQ3GJXQCYKEX` | **Instant** | [df5347a9...](https://stellar.expert/explorer/testnet/tx/df5347a9451de29ad79bd60c7e476d7e8664b65fdc291ee8d968b33d3ca36ef0) | N/A (Direct Alloc) |
| `GBZ5AVZHRU36JDBZQ4EMTRJ7TDLL5CWVW3LSHP7CXRXRZI5AR3MBTJS2` | **Time-Locked** | [8fd32250...](https://stellar.expert/explorer/testnet/tx/8fd322509b305d2d1fc1de0b6336c6f9286211f374f33eef4b95d201a6e821f5) | [7d625aee...](https://stellar.expert/explorer/testnet/tx/7d625aee58a21e3d56c10e7d98de84543d301842eb10f6cac0132e546f545624) |
| `GAL5MJ5IVBBVJFQCAZ5EZ57XRGZK7NPSZVUCGDTPZYMHQRYUNBM6GI7F` | **Time-Locked** | [6ac83aa0...](https://stellar.expert/explorer/testnet/tx/6ac83aa00893515feef73371a7c74d652249392ca96ff24abf70872ae229f837) | [5b13d5bb...](https://stellar.expert/explorer/testnet/tx/5b13d5bb1d6a63df8dec40ea04fd24c81bed87f621b50f2c9a75776d81487c0e) |
| `GAUNKEADRTLLOFS3EFP256BIQKW62GTORAFQGJCS2A7SO7PWOY6LJ4JB` | **Time-Locked** | [99cf4aaf...](https://stellar.expert/explorer/testnet/tx/99cf4aaf684cb337968bf19622ecc40af413ebff7164a11aa332fdd5c48aaa98) | [a6dce0de...](https://stellar.expert/explorer/testnet/tx/a6dce0de34088a98250a53b90e0bdfcb3495295e855fb82c7d5cc26753c381ad) |
| `GAE6YFGHYE6HS6N3FWHFDHCXAVAPKK5PQS26KK5V7NQSPMATATQKNTFO` | **Live Streaming** | [a3d93922...](https://stellar.expert/explorer/testnet/tx/a3d939221087d55e44a767b47f3239dd98228443d6ab3d87274b4f1aa0b61668) | [9444b8b3...](https://stellar.expert/explorer/testnet/tx/9444b8b3c5e80d062cf49b95c729247104d0e398e797277ac932b8d387320e6c) |
| `GCJEYV5XOK5M2BP35MMQLGPFVRB4UDHEHHRM6EC4VAIK6RBJYTJ3PIAT` | **Live Streaming** | [21313b82...](https://stellar.expert/explorer/testnet/tx/21313b82c01803a219def96b09a6d62f1d4d5c33d695f421fea94dad8fca0772) | [b785f94b...](https://stellar.expert/explorer/testnet/tx/b785f94b482794bc2f494684324c07b6f485115a8faa43accc12591bed7937f7) |
| `GCYKSZGP6EVFFK4WYOOLFIVSUXHQ7OH7ZDPG3OND5FSRTSHUBE36L3LX` | **Live Streaming** | [7ee129b4...](https://stellar.expert/explorer/testnet/tx/7ee129b4d5af87450b3bd877e39940e2aed746a5224c8bf7bd11f568c2468022) | [85dcc59a...](https://stellar.expert/explorer/testnet/tx/85dcc59a9aa30d653213cd0dc0a3a13cc47a5dfd96a4317280a1ecb8903ef8ea) |

---

## 🗣️ Basic User Feedback Summary

During our pilot testing with the 10 users above, we collected feedback via our in-app persistent Feedback Widget. Here is a brief summary of the pilot feedback:

- **UX Clarity:** Users loved the unified dashboard layout and the distinction between Instant, Scheduled, and Streaming allocations.
- **Wallet Connection:** Connecting via Freighter and Stellar Wallets Kit was seamless for most users.
- **Trustline Management:** Some users were initially confused by the need to add a USDC trustline before receiving funds, which prompted us to ensure our scripts/UX auto-prompts or documents this clearly.
- **Performance:** Stream claims felt incredibly fast and responsive on the Stellar Testnet.

---

## 🔗 Submission Links & Artifacts

| Item | Value |
|---|---|
| **Live Demo (Vercel)** | [https://proofpay-brown.vercel.app/](https://proofpay-brown.vercel.app/) |
| **Demo Walkthrough Video** | [https://youtu.be/8PIKkv-BaEY](https://youtu.be/8PIKkv-BaEY) |
| **Default Vault ID** | `CCOQVDUZXNMXZGZRBOLVVHM2NGPD3NTT27UL6CJLOAMWRRFMVCW7P6GC` |
| **USDC Testnet Token** | `CDHJGGDSEOTXHNYV7Y2CQYU5CX3CV4ZOB5EDWDO4QPYHAKNWUPNYNPJQ` |

### Screenshots

#### Employer Dashboard
![Employer Dashboard](public/screenshots/employer%20dashboard.png)

#### Worker Dashboard
![Worker Dashboard](public/screenshots/worker%20dashboard.png)

#### Analytics / Feedback (Level 4 features)
![Analytics & Feedback](public/screenshots/image.png)

---

## 🛠️ Tech Stack & Architecture

*   **Frontend:** React 18, TypeScript, Vite, Vanilla CSS
*   **Smart Contracts:** Rust, Soroban SDK v25.3.1, WASM (`wasm32v1-none` target)
*   **Stellar Integration:** `@stellar/stellar-sdk` v16.0.1, `@creit.tech/stellar-wallets-kit` v2.3.0
*   **CI/CD:** GitHub Actions Pipeline
*   **Analytics:** Vercel Web Analytics

## 🚀 Running Locally

### 1. Install dependencies:
```bash
npm install
```

### 2. Run unit tests:
```bash
npm run test
```

### 3. Start development server:
```bash
npm run dev
```
