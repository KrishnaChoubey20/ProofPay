# 💳 ProofPay

> **Privacy-Preserving Payroll & On-Chain Vaults for Global Remote Teams**
> 
> ProofPay is a decentralized payroll platform built on **Stellar Testnet** and **Soroban Smart Contracts**. It allows employers to set up secure vault escrows, streams real-time deposit/claim activity feeds on-chain, and enables workers to claim their allocations in a secure, non-interactive manner.

---

## 🌟 The Vision

ProofPay aims to solve the compliance and privacy issues of remote web3 payments:
1. **On-Chain Vaults:** Secure multi-wallet payroll management via dedicated Soroban smart contracts.
2. **Selective Income Proofs (Roadmap):** Workers receive payroll on Stellar and can generate zero-knowledge proof credentials of their income stream to verify their salary for visas, renting, or loan applications without disclosing their entire transaction history.

---

## 🏆 Stellar Journey to Mastery: Belt Levels

This repository houses the step-by-step evolution of ProofPay across the challenge levels:

### 🟡 [Level 2 — Yellow Belt (Current Level)](./LEVEL2_YELLOW_BELT_README.md)
*   **Focus:** Multi-wallet web application integration, Soroban smart contract deployment, and real-time events.
*   **Key Implementations:**
    *   **StellarWalletsKit:** Connect Freighter, LOBSTR, xBull, Hana, and other Stellar wallets.
    *   **Smart Payroll Vault:** Escrow contract (`ProofPayVault`) written in Rust (Soroban SDK v25) deployed on Testnet.
    *   **Real-time Synchronization:** On-chain event streaming (`getEvents`) updating a live dashboard activity feed.
    *   **Robust UX:** Loading states, transaction confirmations, and 3 standard wallet error handler notifications.
*   👉 *Detailed documentation and submission screenshots are in the **[Yellow Belt README](./LEVEL2_YELLOW_BELT_README.md)**.*

### ⚪ [Level 1 — White Belt](./LEVEL1_WHITE_BELT_README.md)
*   **Focus:** Core Stellar integration and basic Horizon payments.
*   **Key Implementations:**
    *   Freighter wallet connection, account balance retrieval from Horizon, and direct native XLM payroll payments.
*   👉 *Detailed documentation and White Belt screenshots are in the **[White Belt README](./LEVEL1_WHITE_BELT_README.md)**.*

---

## 🛠️ Tech Stack & Architecture

ProofPay is engineered with modern web technologies and Stellar ecosystem tools:

*   **Frontend:** React 18, TypeScript, Vite, Vanilla CSS (Cream & Ink Premium Theme)
*   **Smart Contracts:** Rust, Soroban SDK v25.0.1, WASM
*   **Stellar Integration:** `@stellar/stellar-sdk` v16.0.1 (Protocol 22), `@creit.tech/stellar-wallets-kit` v2.3.0
*   **Analytics:** Vercel Web Analytics

---

## ⛓️ Smart Contract Interface

The `ProofPayVault` contract exposes the following core functions on-chain:

```rust
pub fn deposit(env: Env, from: Address, worker: Address, amount: i128);
pub fn claim(env: Env, worker: Address) -> Result<i128, ContractError>;
pub fn get_allocation(env: Env, worker: Address) -> i128;
pub fn get_total_deposited(env: Env) -> i128;
```

---

## 🔗 Submission Links

| Item | Value |
|---|---|
| **GitHub Repo** | [https://github.com/KrishnaChoubey20/ProofPay](https://github.com/KrishnaChoubey20/ProofPay) |
| **Live Demo (Vercel)** | [https://proofpay-brown.vercel.app/](https://proofpay-brown.vercel.app/) |
| **Vault Contract ID** | `CD35FOUT64RGU4UKZQHCQPPDSPB7XIJ6AVRLFYN2NDR3MFJG5HL4VSRD` |
| **Sample Deposit Tx** | [9b9039ca...17f195b97](https://stellar.expert/explorer/testnet/tx/9b9039ca0b8beeaa77c48bd3cb0694cbb386dbcd67f294afe7b06c117f195b97) |
| **Sample Claim Tx** | [40c6f628...040301b6](https://stellar.expert/explorer/testnet/tx/40c6f62842001d8c2029f0fa0e26045bf5395f673886c1ae9634d912040301b6) |

---

## 🚀 Running Locally

### 1. Clone the project and install packages:
```bash
git clone https://github.com/KrishnaChoubey20/ProofPay.git
cd ProofPay
npm install
```

### 2. Start the Vite development server:
```bash
npm run dev
```

---

## 🗺️ Roadmap to Black Belt

*   ✅ **White Belt:** Wallet connection, XLM balance display, testnet classic payment submission.
*   ✅ **Yellow Belt:** Multi-wallet client modal, Soroban Vault contract, on-chain deposits/claims, live event stream feed.
*   🔜 **Orange Belt:** Scheduled payouts, recurring automated vaults.
*   🔜 **Green Belt:** USDC payroll support, payout splitting rules, zero-knowledge income proof schema.
*   🔜 **Blue Belt:** 50-user pilot program for remote workers.
*   🔜 **Black Belt:** Mainnet launch, formal smart contract audits, corporate payroll dashboards.
