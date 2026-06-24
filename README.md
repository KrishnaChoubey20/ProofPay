# ProofPay

ProofPay is a Stellar Testnet payroll platform built for the Stellar Journey to Mastery challenge.

The full ProofPay vision is private payroll for global remote teams: workers receive payroll on Stellar and later generate selective income proofs for rent, loans, visas, and taxes without exposing their full wallet history.

## Challenge Levels

This repository houses the implementations for each level of the Stellar Journey to Mastery:

*   **🟡 [Level 2 — Yellow Belt Submission](./LEVEL2_YELLOW_BELT_README.md) (Current Level)**
    *   **Focus:** Multi-wallet integration, smart contract vault deployment, and real-time event synchronization.
    *   **Features:** StellarWalletsKit integration, customized Soroban smart contract, live event streaming feed, transaction loading and receipt indicators, and robust error handlers for 3 standard wallet error types.
    *   *Includes all screenshots and transaction logs in the [Level 2 README](./LEVEL2_YELLOW_BELT_README.md).*

*   **⚪ [Level 1 — White Belt Submission](./LEVEL1_WHITE_BELT_README.md)**
    *   **Focus:** Core Stellar wallets connection, balance fetching, and basic direct payroll payments.
    *   **Features:** Connect and disconnect Freighter wallet, fetch XLM balances from Horizon Testnet, and submit direct classic payroll payments on Stellar Testnet.
    *   *Includes all screenshots and setup guides in the [Level 1 README](./LEVEL1_WHITE_BELT_README.md).*

---

## Tech Stack

- React + TypeScript
- Vite
- StellarWalletsKit (`@creit.tech/stellar-wallets-kit` v2.3.0)
- Stellar JavaScript SDK v13
- Soroban RPC (`soroban-testnet.stellar.org`)
- Stellar Testnet Horizon
- Rust + Soroban SDK v25.0.1 (smart contract)

---

## Requirements

- Node.js 20 or newer
- A Stellar wallet extension (Freighter, LOBSTR, xBull, etc.)
- A funded Stellar Testnet account

Fund your testnet wallet with Friendbot:

```text
https://friendbot.stellar.org
```

---

## Run Locally

Install dependencies:

```bash
npm install
```

Start the development server:

```bash
npm run dev
```

Build for production:

```bash
npm run build
```

---

## Vault Contract Deployment (Optional — for full Soroban features)

> Requires: Rust toolchain + `wasm32-unknown-unknown` target + Stellar CLI

```bash
# Build the Rust contract
cd contracts/payroll-vault
stellar contract build

# Fund a deploy key and deploy to testnet
stellar keys generate --global deployer --network testnet --fund

stellar contract deploy \
  --wasm target/wasm32-unknown-unknown/release/payroll_vault.wasm \
  --source deployer \
  --network testnet \
  -- \
  --admin deployer \
  --native_token CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC

# Copy the returned Contract ID into:
# src/lib/stellar.ts → VAULT_CONTRACT_ID constant
```

See [LEVEL2_YELLOW_BELT_README.md](./LEVEL2_YELLOW_BELT_README.md) for the complete deployment guide.

---

## Submission Links

| Item | Value |
|---|---|
| **GitHub Repo** | https://github.com/KrishnaChoubey20/ProofPay |
| **Live Demo (Vercel)** | *(Add after deploy)* |
| **Vault Contract ID** | `CD35FOUT64RGU4UKZQHCQPPDSPB7XIJ6AVRLFYN2NDR3MFJG5HL4VSRD` |

---

## Belt Roadmap

- ✅ **White Belt:** Freighter connection, XLM balance, testnet payroll transaction.
- ✅ **Yellow Belt:** StellarWalletsKit multi-wallet, Soroban Vault contract, Deposit/Claim, real-time events.
- 🔜 **Orange Belt:** Scheduled payouts, recurring payroll, multi-employer vaults.
- 🔜 **Green Belt:** USDC payroll, splitting rules, and selective income proof design.
- 🔜 **Blue Belt:** 50-user pilot with freelancers and remote workers.
- 🔜 **Black Belt:** Mainnet launch, privacy proof layer, audits, and real employer onboarding.


