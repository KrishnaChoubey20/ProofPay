# ProofPay Level 2 — Yellow Belt Implementation Plan

## Overview

Building on the Level 1 White Belt foundation, we upgrade ProofPay into a **multi-wallet payroll platform with a deployed Soroban smart contract**. The contract acts as a **Payroll Vault** — employers deposit XLM and workers can claim their payroll on-chain. The frontend connects via **StellarWalletsKit** (multi-wallet), calls the contract, and streams real-time events.

---

## User Review Required

> [!IMPORTANT]
> **Smart Contract Language**: Soroban contracts are written in **Rust**. This requires the Rust toolchain + `wasm32` target installed locally. The plan includes the full CLI setup commands.

> [!IMPORTANT]
> **Separate Contract Workspace**: The Soroban contract will live in a new `contracts/` folder inside the project. The contract is deployed once to testnet via the Stellar CLI, and the frontend uses the returned Contract ID.

> [!NOTE]
> **Chosen Project**: **Payroll Vault Contract** — fits perfectly with ProofPay's brand. Employer deposits XLM into a vault contract. Workers call `claim()` to pull their allocation. All activity emits on-chain events that the frontend streams in real-time.

---

## Level 2 Requirements Mapping

| Requirement | ProofPay Yellow Belt Implementation |
|---|---|
| **StellarWalletsKit** | Replace `useFreighter` hook with `useStellarWallet` using `@creit.tech/stellar-wallets-kit` — shows Freighter, LOBSTR, xBull modal |
| **3 error types handled** | `WalletNotFound`, `UserRejected`, `InsufficientBalance` — all surfaced in UI with distinct messages |
| **Contract deployed on testnet** | `ProofPayVault` Soroban contract in Rust, deployed via Stellar CLI |
| **Contract called from frontend** | `deposit()` and `claim()` invoked from React via `invokeContract()` using Soroban RPC |
| **Transaction status visible** | Pending → Success / Failed states with spinner, hash, and StellarExpert link |
| **Real-time event integration** | RPC `getEvents()` polling every 5s, streams `PayrollDeposited` and `PayrollClaimed` events into Activity Feed |
| **2+ meaningful commits** | Contract deployment commit + frontend integration commit |

---

## Proposed Changes

### Phase 1 — Rust Toolchain & Contract Workspace

#### [NEW] `contracts/payroll-vault/` — Soroban Rust contract workspace

**Setup commands (run once):**
```bash
# Install Rust + wasm target
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
rustup target add wasm32-unknown-unknown

# Install Stellar CLI
cargo install --locked stellar-cli --features opt

# Init contract workspace
stellar contract init contracts/payroll-vault
```

#### [NEW] `contracts/payroll-vault/src/lib.rs`

The **ProofPayVault** contract:
```
Functions:
  - __constructor(env, admin)         → sets admin, initializes maps
  - deposit(env, from, worker, amount) → employer funds a worker allocation
  - claim(env, worker)                → worker pulls their allocation
  - get_allocation(env, worker)       → read a worker's claimable balance
  - get_total_deposited(env)          → total vault balance

Events emitted:
  - PayrollDeposited { from, worker, amount }
  - PayrollClaimed   { worker, amount }

Errors:
  - InsufficientBalance (3)
  - NotAuthorized (4)
  - NothingToClaim (5)

Storage:
  - Instance: Admin, TotalDeposited
  - Persistent: Allocation(Address) per worker
```

#### [NEW] `contracts/payroll-vault/Cargo.toml`
Standard Soroban contract Cargo config with `soroban-sdk = "25.0.1"`.

---

### Phase 2 — Multi-Wallet Integration

#### [MODIFY] `package.json`
Add `@creit.tech/stellar-wallets-kit` dependency:
```bash
npm install @creit.tech/stellar-wallets-kit
```

#### [NEW] `src/hooks/useStellarWallet.ts`
Replace the existing `useFreighter` hook with **StellarWalletsKit**:
- Opens native multi-wallet selection modal (Freighter, LOBSTR, xBull, etc.)
- Wraps `connect`, `disconnect`, `sign`, `getAddress`
- Handles 3 error types:
  - **WalletNotFound** — no wallet extension detected
  - **UserRejected** — user dismisses modal or rejects signing
  - **InsufficientBalance** — caught during contract simulation

#### [MODIFY] `src/hooks/useFreighter.ts`
Keep as-is for backward compatibility (classic XLM payments still use it). The new contract flow uses `useStellarWallet`.

---

### Phase 3 — Soroban Client Library

#### [MODIFY] `src/lib/stellar.ts`
Add Soroban RPC support alongside existing Horizon code:
```typescript
// NEW additions:
export const rpc = new StellarSdk.rpc.Server("https://soroban-testnet.stellar.org");
export const VAULT_CONTRACT_ID = "C..."; // filled after deployment

export async function invokeContract(sourceAddress, contractId, method, args)
export async function submitSorobanTx(signedXdr)   // polls RPC until confirmed
export async function getContractAllocation(worker) // reads persistent storage
export async function streamContractEvents(contractId, cursor, onEvent) // polls getEvents()
```

#### [NEW] `src/lib/contractArgs.ts`
Helper to build `ScVal` arguments for the vault contract:
```typescript
export function addressArg(addr: string): ScVal
export function i128Arg(amount: string): ScVal
```

---

### Phase 4 — UI Upgrades

#### [MODIFY] `src/App.tsx`
Major structural upgrades:

**Nav:** Replace single "Connect Freighter" button with **"Connect Wallet"** that opens the StellarWalletsKit modal, showing all available wallets.

**New Dashboard Tab: "Vault"** — alongside the existing "Send Payroll" panel:
```
┌─────────────────────────────┐
│  Payroll Vault              │
│  Contract: C…abc  [copy]    │
│                             │
│  [Deposit Tab] [Claim Tab]  │
│                             │
│  Deposit:                   │
│    Worker address:  [____]  │
│    Amount XLM:      [____]  │
│    [Deposit to Vault]       │
│                             │
│  Claim:                     │
│    Your allocation: 250 XLM │
│    [Claim Payroll]          │
└─────────────────────────────┘
```

**New Panel: "Live Activity Feed"** — real-time contract events:
```
┌────────────────────────────────┐
│  Live Activity  ● streaming    │
│                                │
│  ↓ 250 XLM deposited for      │
│    GDXB...M2N4 · Ledger 4231  │
│                                │
│  ✓ GDXB...M2N4 claimed 250 XLM│
│    · Ledger 4238               │
└────────────────────────────────┘
```

**Error Toast System:** Three distinct error states rendered at the top of affected panels:
1. 🔌 **Wallet Not Found** — "No Stellar wallet extension detected. Install Freighter or LOBSTR."
2. ❌ **Transaction Rejected** — "You rejected the transaction in your wallet."
3. 💸 **Insufficient Balance** — "Your XLM balance is too low to cover this transaction + fees."

---

### Phase 5 — Documentation & Submission

#### [MODIFY] `README.md`
Add:
- Live Vercel demo link
- Deployed contract address (after deployment)
- Screenshot: wallet selection modal open
- Transaction hash of a contract call

#### [MODIFY] `LEVEL1_WHITE_BELT_README.md` → rename/copy to `LEVEL2_YELLOW_BELT_README.md`
Full Yellow Belt submission checklist doc.

---

## File Structure After Level 2

```
ProofPay/
├── contracts/
│   └── payroll-vault/
│       ├── Cargo.toml
│       └── src/
│           └── lib.rs          ← Soroban Vault contract (Rust)
├── src/
│   ├── App.tsx                 ← Updated UI (vault + activity feed)
│   ├── styles.css              ← Minor additions for new panels
│   ├── hooks/
│   │   ├── useFreighter.ts     ← Kept for classic payments
│   │   └── useStellarWallet.ts ← NEW: multi-wallet via StellarWalletsKit
│   └── lib/
│       ├── stellar.ts          ← Add RPC + contract helpers
│       └── contractArgs.ts     ← NEW: ScVal argument builders
├── LEVEL2_YELLOW_BELT_README.md
└── public/screenshots/         ← new Level 2 screenshots
```

---

## Deployment Workflow

```bash
# 1. Build the Soroban contract
cd contracts/payroll-vault
stellar contract build

# 2. Generate a funded deploy key
stellar keys generate --global deployer --network testnet --fund

# 3. Deploy to testnet → get CONTRACT_ID
stellar contract deploy \
  --wasm target/wasm32-unknown-unknown/release/payroll_vault.wasm \
  --source deployer \
  --network testnet \
  -- --admin deployer

# 4. Copy CONTRACT_ID into src/lib/stellar.ts

# 5. Test contract call
stellar contract invoke \
  --id CONTRACT_ID \
  --source deployer \
  --network testnet \
  -- get_total_deposited
```

---

## Verification Plan

### Automated
- `npm run build` — TypeScript must compile cleanly
- Contract Rust tests: `cargo test` inside `contracts/payroll-vault/`

### Manual
1. Open app → click "Connect Wallet" → see multi-wallet modal with at least Freighter + xBull
2. Connect Freighter → Dashboard loads with balance
3. Deposit 10 XLM to vault for a worker address → sign in Freighter → see success + hash
4. Switch to worker wallet → Claim payroll → sign → see 10 XLM arrive
5. Activity Feed shows both `PayrollDeposited` and `PayrollClaimed` events live
6. Disconnect wallet → reconnect with a wallet that has no extension → see **WalletNotFound** error
7. Reject a transaction signing → see **UserRejected** error
8. Enter amount > balance → see **InsufficientBalance** error during simulation

### Submission Deliverables
- ✅ Public GitHub repo
- ✅ README with setup instructions
- ✅ Deployed contract address (filled post-deploy)
- ✅ Transaction hash of contract call (filled post-deploy)
- ✅ Screenshot: wallet modal open
- ✅ Live Vercel URL

---

## Open Questions

> [!NOTE]
> **Do you want to deploy using your own Freighter wallet address as admin, or a separate CLI-generated key?** Using CLI-generated is simpler for testnet.

> [!NOTE]
> **Should the Vault support multiple employers, or just the connected wallet?** Current plan: any connected wallet can deposit for any worker address (open vault model).
