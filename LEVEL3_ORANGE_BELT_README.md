# 🟠 Level 3 - Orange Belt Submission

[![CI/CD Pipeline](https://github.com/KrishnaChoubey20/ProofPay/actions/workflows/ci.yml/badge.svg)](https://github.com/KrishnaChoubey20/ProofPay/actions)

Welcome to the **Orange Belt (Level 3)** milestone of **ProofPay**! 
Building on the wallet adapters and on-chain escrow of Level 2, we have upgraded ProofPay into a production-grade multi-contract architecture using the **Factory Pattern** for dynamic user vault deployments, added advanced **Time-Locked (Scheduled)** and **Linear Streaming** payroll flows, implemented automated CI/CD validation, and wrote comprehensive unit/integration test suites.

* **Production Live Demo**: [https://proofpay-brown.vercel.app/](https://proofpay-brown.vercel.app/)
* **GitHub Repository**: [KrishnaChoubey20/ProofPay](https://github.com/KrishnaChoubey20/ProofPay)

---

## 🚀 Key Achievements

### 1. Dynamic Vault Factory Pattern (`payroll-factory`)
We designed and deployed a dynamic **Factory Contract** on Stellar Testnet. Instead of relying on a single hardcoded vault contract:
* Employers can dynamically spin up their own personal **Payroll Vault** directly from the UI.
* The factory deploys child contracts using `env.deployer().with_current_contract(salt).deploy_v2(wasm_hash, constructor_args)` atomically, registering the new instance and mapping the administrator to their deployed contract.
* Toggles are available in the dashboard to route payments dynamically through either the default global vault or the user's custom dynamically deployed vault.

### 2. Time-Locked (Scheduled) Payroll
Allows employers to deposit funds that are mathematically locked in the contract until a specified `release_time` timestamp:
* **Deposit**: Vault tracks individual payments in a vector `ScheduledPayment { amount, release_time }`.
* **Claim**: Workers claim all of their unlocked scheduled allocations in a single atomic transaction. Any allocations whose release time is still in the future remain locked in the contract.

### 3. Linear Continuous Streaming Payroll
Allows employers to fund a real-time continuous payout stream for a worker over a set time range (`start_time` to `end_time`):
* **Linear Accrual**: The claimable amount accumulates second-by-second based on elapsed time:
  $$\text{Accrued} = \frac{\text{Total Amount} \times (\text{Current Time} - \text{Start Time})}{\text{End Time} - \text{Start Time}}$$
* **Real-time Ticking Counter**: The React frontend calculates and displays the claimable amount ticking upwards second-by-second in real-time, accompanied by a visual progress bar.
* **Continuous Claims**: Workers can claim accrued stream balances as they accumulate without stopping the stream.

### 4. CI/CD GitHub Actions Pipeline
A fully automated GitHub Actions workflow is configured in `.github/workflows/ci.yml` that runs on every code push/PR:
* **Rust Contracts CI**: Sets up the Rust toolchain, targets `wasm32v1-none`, runs `cargo test`, and builds the optimized contract WASM files.
* **Frontend React CI**: Sets up Node.js, installs dependencies, checks code formatting/linting via `npm run lint`, runs frontend unit tests, and verifies the production bundler output.

---

## 📦 Stellar Testnet Deployment Registry

All contracts have been successfully compiled and deployed on-chain to **Stellar Testnet**:

| Contract / Action | Address / Tx Hash | Network Explorer Log |
| :--- | :--- | :--- |
| **Vault WASM Upload** | Wasm Hash: `429805be6f3003ce2dd6cfa2bc366847a2f4c514c1187b33c35ce82fb5ff48a3` | [StellarExpert Transaction](https://stellar.expert/explorer/testnet/tx/bdb16cfa3ed2ad68721dd96d6657f68e1880d92439ea788281b02a2966f445f4) |
| **Factory Deploy** | Contract ID: `CB4APYC7KJRCXO2AH6SLYNB3FSUZYBIYW2J47S4JXI6ILNQ7TX6X4RFX` | [StellarExpert Transaction](https://stellar.expert/explorer/testnet/tx/2dac599abfbc0a4301c58d53fea5cf0fed6bba0631b3a304141094b576afc942) |
| **On-Chain Dynamic Vault Launch** | Deployed Vault: `CDHJGGDSEOTXHNYV7Y2CQYU5CX3CV4ZOB5EDWDO4QPYHAKNWUPNYNPJQ` | [StellarExpert Transaction](https://stellar.expert/explorer/testnet/tx/feba52c1469928760800bf023a6ebf54f98a097a9d05f10e7b93216bcffbd500) |

---

## 🧪 Testing Report

We have implemented rigorous unit and integration tests across both the Rust smart contracts and the TypeScript frontend SDK.

### 1. Soroban Contract Tests (`cargo test`)
We verified correct constructor initialization, normal payroll claims, multi-payment time locks, and continuous streaming allocations:

```bash
$ cargo test
   Compiling payroll-factory v0.1.0 (contracts/payroll-factory)
   Compiling payroll-vault v0.1.0 (contracts/payroll-vault)
    Finished `test` profile [unoptimized + debuginfo] target(s) in 3.74s

running 1 test
test tests::test_factory_deploy_vault ... ok

test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.16s

running 7 tests
test tests::test_get_allocation_starts_zero ... ok
test tests::test_get_total_deposited_starts_zero ... ok
test tests::test_claim_nothing_errors ... ok
test tests::test_constructor_sets_admin ... ok
test tests::test_deposit_and_claim ... ok
test tests::test_streaming_deposit_and_claim ... ok
test tests::test_scheduled_deposit_and_claim ... ok

test result: ok. 7 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.05s
```

### 2. Frontend React Tests (`npm run test`)
We verified address shortening, inputs validation, XLM-to-Stroops mathematical scaling, and ScVal type conversions:

```bash
$ npm run test

 RUN  v2.1.9 D:/Krishna Work/Stellar Challenge

 ✓ src/tests/utils.test.ts (8 tests) 6ms

 Test Files  1 passed (1)
      Tests  8 passed (8)
   Start at  18:11:26
   Duration  1.60s (transform 116ms, setup 0ms, collect 824ms, tests 6ms)
```

---

## 📱 Premium Design & Mobile Responsiveness
* **Typography**: Clean, custom fonts (`DM Sans` and `DM Serif Display`) imported from Google Fonts.
* **Modern Gradients**: Glassmorphic headers and borders utilizing modern HSL tailored colors.
* **Micro-Animations**: Real-time ticking stream counter, smooth fading transition states, pulsing indicators, and interactive hover feedback.
* **Mobile Responsiveness**: Upgraded `src/styles.css` with adaptive media queries for devices under `960px` and `600px` (hiding desktop-specific headers and auto-wrapping the dashboard panels into a single-column layout for mobile convenience).
