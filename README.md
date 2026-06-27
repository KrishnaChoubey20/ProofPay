# 💳 ProofPay

> **Privacy-Preserving Payroll, Dynamic On-Chain Vaults & Real-Time Streams for Global Remote Teams**
> 
> ProofPay is a decentralized payroll platform built on **Stellar Testnet** and **Soroban Smart Contracts**. It allows employers to set up secure vault escrows, deploy dynamic custom vaults via an on-chain factory, schedule locked funds, stream real-time continuous payroll, and enables workers to claim their allocations in a secure, non-interactive manner.

---

## 🌟 The Vision

ProofPay aims to solve the compliance and privacy issues of remote web3 payments:
1. **Dynamic Factory Architecture:** Deploy customized, isolated Soroban vaults for each company dynamically.
2. **Scheduled & Streaming Escrows:** Manage granular time-locked allocations and continuous linear pay-rate streams.
3. **Selective Income Proofs (Roadmap):** Generate zero-knowledge proof credentials of income streams to verify salaries for housing or visa applications without exposing full payment histories.

---

## 🏆 Stellar Journey to Mastery: Belt Levels

This repository houses the step-by-step evolution of ProofPay across the challenge levels:

### 🟠 [Level 3 — Orange Belt (Current Level)](./LEVEL3_ORANGE_BELT_README.md)
*   **Focus:** Advanced smart contracts, dynamic factory pattern, time-locked scheduled payments, real-time continuous linear streams, Vitest/Cargo automated testing, and CI/CD pipeline integration.
*   **Key Implementations:**
    *   **Dynamic Vault Factory:** On-chain factory contract (`ProofPayFactory`) enabling employers to spin up dynamic vaults.
    *   **Time-locked Scheduled Payments:** Locked deposits released only after a target date/time.
    *   **Linear Payroll Streaming:** Accumulates XLM second-by-second with a real-time ticking UI and progress bar.
    *   **CI/CD Pipeline:** Automated GitHub Actions pipeline for testing and building Rust contracts and React app.
*   👉 *Detailed documentation, tests outputs, and deployment hashes are in the **[Orange Belt README](./LEVEL3_ORANGE_BELT_README.md)**.*

### 🟡 [Level 2 — Yellow Belt](./LEVEL2_YELLOW_BELT_README.md)
*   **Focus:** Multi-wallet web application integration, Soroban smart contract deployment, and real-time events.
*   *Key Implementations:* Multi-wallet modal (StellarWalletsKit), shared vault contract, and live activity event stream.
*   👉 *Detailed documentation and Yellow Belt screenshots are in the **[Yellow Belt README](./LEVEL2_YELLOW_BELT_README.md)**.*

### ⚪ [Level 1 — White Belt](./LEVEL1_WHITE_BELT_README.md)
*   **Focus:** Core Stellar integration and basic Horizon payments.
*   *Key Implementations:* Freighter wallet connection, account balance retrieval, and direct native payments.
*   👉 *Detailed documentation is in the **[White Belt README](./LEVEL1_WHITE_BELT_README.md)**.*

---

## 🛠️ Tech Stack & Architecture

*   **Frontend:** React 18, TypeScript, Vite, Vitest, Vanilla CSS (Cream & Ink Premium Theme)
*   **Smart Contracts:** Rust, Soroban SDK v25.3.1, WASM (`wasm32v1-none` target)
*   **Stellar Integration:** `@stellar/stellar-sdk` v16.0.1 (Protocol 22), `@creit.tech/stellar-wallets-kit` v2.3.0
*   **CI/CD:** GitHub Actions Pipeline (`.github/workflows/ci.yml`)
*   **Analytics:** Vercel Web Analytics

---

## 🔗 Submission Links

| Item | Value |
|---|---|
| **GitHub Repo** | [https://github.com/KrishnaChoubey20/ProofPay](https://github.com/KrishnaChoubey20/ProofPay) |
| **Live Demo (Vercel)** | [https://proofpay-brown.vercel.app/](https://proofpay-brown.vercel.app/) |
| **Factory Contract ID** | `CB4APYC7KJRCXO2AH6SLYNB3FSUZYBIYW2J47S4JXI6ILNQ7TX6X4RFX` |
| **Default Vault ID** | `CD35FOUT64RGU4UKZQHCQPPDSPB7XIJ6AVRLFYN2NDR3MFJG5HL4VSRD` |
| **Sample Install Wasm Tx** | [bdb16cfa...66f445f4](https://stellar.expert/explorer/testnet/tx/bdb16cfa3ed2ad68721dd96d6657f68e1880d92439ea788281b02a2966f445f4) |
| **Sample Deploy Factory Tx** | [2dac599a...6afc942](https://stellar.expert/explorer/testnet/tx/2dac599abfbc0a4301c58d53fea5cf0fed6bba0631b3a304141094b576afc942) |
| **Sample Factory Launch Vault Tx** | [feba52c1...bffd500](https://stellar.expert/explorer/testnet/tx/feba52c1469928760800bf023a6ebf54f98a097a9d05f10e7b93216bcffbd500) |

---

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

---

## 🗺️ Roadmap to Black Belt

*   ✅ **White Belt:** Wallet connection, XLM balance display, testnet classic payment submission.
*   ✅ **Yellow Belt:** Multi-wallet client modal, Soroban Vault contract, on-chain deposits/claims, live event stream feed.
*   ✅ **Orange Belt:** Scheduled payouts, continuous linear streams, dynamic factory vaults, CI/CD pipeline.
*   🔜 **Green Belt:** USDC payroll support, payout splitting rules, zero-knowledge income proof schema.
*   🔜 **Blue Belt:** 50-user pilot program for remote workers.
*   🔜 **Black Belt:** Mainnet launch, formal smart contract audits, corporate payroll dashboards.
