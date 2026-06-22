# ProofPay Alpha - Level 1 White Belt Submission

## Project Description

ProofPay Alpha is a Stellar Testnet dApp for the Stellar Journey to Mastery White Belt challenge.

It is the first build slice of ProofPay, a private payroll product for global remote teams. In this Level 1 version, the app proves the Stellar fundamentals required by the challenge: connecting a Freighter wallet, displaying the connected wallet's XLM balance, and sending a signed XLM transaction on Stellar Testnet.

## White Belt Requirement Coverage

| Requirement | ProofPay Alpha Implementation |
| --- | --- |
| Set up Freighter wallet | App detects Freighter and prompts users to connect it |
| Use Stellar Testnet | App labels the active wallet network and requires Testnet for sending |
| Wallet connect | `Connect Freighter` button requests wallet access |
| Wallet disconnect | `Disconnect wallet` clears the active wallet session in the app |
| Fetch XLM balance | App loads the connected account from Stellar Testnet Horizon |
| Display XLM balance | Balance panel clearly shows available XLM |
| Send XLM transaction | `Send Test Payroll` builds and submits a native XLM payment |
| Show feedback | App shows ready, pending, success, and failure states |
| Show transaction result | Success receipt includes the transaction hash and StellarExpert link |
| Error handling | App handles missing wallet, wrong network, invalid address, unfunded accounts, rejected signatures, and submit failures |

## Tech Stack

- React
- TypeScript
- Vite
- Freighter API
- Stellar JavaScript SDK
- Stellar Testnet Horizon

## Setup Instructions

Install dependencies:

```bash
npm install
```

Run locally:

```bash
npm run dev
```

Build:

```bash
npm run build
```

Lint:

```bash
npm run lint
```

## Testing Instructions

1. Install Freighter.
2. Switch Freighter to Stellar Testnet.
3. Fund your testnet wallet with Friendbot.
4. Open ProofPay Alpha locally.
5. Click `Connect Freighter`.
6. Confirm the wallet address and XLM balance are visible.
7. Paste a valid Stellar testnet recipient address.
8. Enter an XLM amount.
9. Click `Send Test Payroll`.
10. Sign the transaction in Freighter.
11. Confirm the app shows success, transaction hash, and explorer link.

Friendbot:

```text
https://friendbot.stellar.org
```

## Screenshots Required For Submission

Place screenshots in `public/screenshots/` before final submission:

- Wallet connected state
- Balance displayed
- Successful testnet transaction
- Transaction result shown to the user

## Repository

```text
https://github.com/KrishnaChoubey20/ProofPay
```

## ProofPay Roadmap

- White Belt: wallet connection, XLM balance, Stellar testnet transaction.
- Yellow Belt: employer and worker views with payroll history.
- Orange Belt: smart contract payroll vault.
- Green Belt: USDC payroll, splitting rules, private income proof design.
- Blue Belt: real freelancer pilot and user feedback.
- Black Belt: mainnet launch, audits, and real employer onboarding.
