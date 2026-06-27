# ProofPay Level 3 — Orange Belt Implementation Plan

## Overview

ProofPay Level 3 (Orange Belt) upgrades our platform into a production-ready, advanced decentralized payroll app. We move from a single hardcoded vault into a **Factory-Instance dynamic architecture** with smart contract interop, add support for **Scheduled & Continuous Streaming Payroll**, integrate **automated CI/CD pipelines**, and introduce **frontend unit testing** and a **mobile-responsive UI**.

---

## Level 3 Requirements Mapping

| Requirement | ProofPay Orange Belt Proposal |
|---|---|
| **Advanced Contract Logic** | Support **Scheduled Payouts** (locked until timestamp) and **Streaming Payroll** (accrues per-second). |
| **Inter-Contract Communication** | Deploy a **Vault Factory Contract** (`ProofPayFactory`) that dynamically deploys new instances of `ProofPayVault` using contract hashes. |
| **CI/CD Pipeline** | GitHub Actions workflow (`ci.yml`) validating build, formatting, clippy lints, and unit tests on push. |
| **Testing Suite** | **Rust Contract Tests:** Validate factory deployment, lock times, and stream calculations. <br>**Frontend Tests:** Vitest suite testing SDK helpers and layout utilities. |
| **Mobile-Responsive UI** | Mobile-first CSS refactor ensuring dashboard, modals, and tables look premium on screens down to 320px width. |
| **Transaction Status & Event Streaming** | Maintain full status indicators and events subscription for dynamically deployed vaults. |

---

## Proposed Changes

### Component 1: Smart Contracts (Advanced Logic & Factory)

We will partition the Rust contract workspace into a Factory and a Vault template.

#### [NEW] [factory.rs](file:///d:/Krishna%20Work/Stellar%20Challenge/contracts/payroll-vault/src/factory.rs)
A deployment factory contract:
*   `__constructor(env, vault_wasm_hash)`: Initializes the factory with the WASM hash of the compiled `ProofPayVault`.
*   `deploy_vault(env, deployer: Address, admin: Address, native_token: Address) -> Address`: Uses `env.deployer().with_current_contract_address().deploy(...)` to instantiate a new `ProofPayVault` contract. Emits a `VaultCreated` event with the new contract address.

#### [MODIFY] [lib.rs](file:///d:/Krishna%20Work/Stellar%20Challenge/contracts/payroll-vault/src/lib.rs)
Upgrade `ProofPayVault` to support:
*   **Scheduled Payroll:**
    *   `deposit_scheduled(from, worker, amount, release_time: u64)`: Escrows funds for the worker until `release_time` (Unix timestamp).
    *   `claim_scheduled(worker)`: Checks `env.ledger().timestamp() >= release_time`.
*   **Continuous Streaming Payroll:**
    *   `create_stream(from, worker, amount, start_time: u64, end_time: u64)`: Transfers XLM to the contract and initializes a stream.
    *   `claim_stream(worker)`: Computes accrued amount pro-rata based on `current_time` relative to the stream duration:
        $$\text{accrued} = \text{total\_amount} \times \frac{\min(\text{now}, \text{end}) - \text{start}}{\text{end} - \text{start}} - \text{claimed\_so\_far}$$
    *   Transfers the accrued portion to the worker and updates the claimed balance.

#### Contract Verification Plan (Rust)
*   **Test 1:** Factory successfully deploys a vault instance on-chain.
*   **Test 2:** Scheduled deposit prevents claiming before `release_time` and allows full claim after it.
*   **Test 3:** Streaming deposit allows partial claims over time and checks correct arithmetic release.

---

### Component 2: Frontend & UI (Vite + Vitest)

#### [MODIFY] [package.json](file:///d:/Krishna%20Work/Stellar%20Challenge/package.json)
Install development dependencies for Vitest and testing setup:
```json
"devDependencies": {
  "vitest": "^2.1.8"
}
```
Add `"test": "vitest run"` script.

#### [NEW] [utils.test.ts](file:///d:/Krishna%20Work/Stellar%20Challenge/src/tests/utils.test.ts)
A unit test suite verifying utility function correctness:
*   `stroopsToXlm` and `xlmToStroopsArg` scaling.
*   `shortenAddress` truncation logic.
*   Formatting timestamp outputs.

#### [MODIFY] [stellar.ts](file:///d:/Krishna%20Work/Stellar%20Challenge/src/lib/stellar.ts)
*   Integrate Factory deployment calls.
*   Add functions to query active streams and release times via simulation.

#### [MODIFY] [App.tsx](file:///d:/Krishna%20Work/Stellar%20Challenge/src/App.tsx)
Update dashboard to show:
1.  **Vault Factory Panel:** Deploy your own dedicated vault.
2.  **Streaming Payroll Interface:** Shows real-time counters of streaming XLM accruing per second.
3.  **Scheduled Payments:** Shows lock timers until release.

#### [MODIFY] [styles.css](file:///d:/Krishna%20Work/Stellar%20Challenge/src/styles.css)
*   Add mobile breakpoints (`@media (max-width: 768px)` and `(max-width: 480px)`) to refactor the grid cards into a single column, scale down typography, and implement responsive navigation tabs.

---

### Component 3: CI/CD Pipeline

#### [NEW] [ci.yml](file:///d:/Krishna%20Work/Stellar%20Challenge/.github/workflows/ci.yml)
A GitHub Actions workflow configuration:
```yaml
name: CI

on:
  push:
    branches: [ main ]
  pull_request:
    branches: [ main ]

jobs:
  rust-checks:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Install Rust
        uses: dtolnay/rust-toolchain@stable
        with:
          targets: wasm32-unknown-unknown
      - name: Run Cargo Test
        run: cargo test --manifest-path contracts/payroll-vault/Cargo.toml
      - name: Cargo Clippy
        run: cargo clippy --manifest-path contracts/payroll-vault/Cargo.toml -- -D warnings

  node-checks:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: 'npm'
      - run: npm ci
      - run: npm run lint
      - run: npm run test
      - run: npm run build
```

---

## Verification & Deliverables Plan

### Automated
1. **Local:** `cargo test` and `npm run test` must pass locally.
2. **Remote:** Push a commit and verify that the GitHub Actions run executes successfully.

### Manual Responsive Check
Use browser devtools to test layouts at:
- **Desktop:** 1440px / 1200px
- **Tablet:** 768px
- **Mobile:** 375px / 320px (cards collapse cleanly, form fields expand to 100% width, buttons remain easily tappable).

---

## Open Questions

> [!NOTE]
> **Should we allow employers to cancel a stream before its end time?**
> A production streaming payroll protocol usually allows the employer to revoke/cancel the stream, retrieving the remaining un-accrued funds while paying out what the worker has already earned. Would you like this included?
