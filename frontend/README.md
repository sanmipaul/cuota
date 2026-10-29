# Cuota web app

Next.js 16 (App Router), Tailwind 4, wagmi 3 and viem. Spanish first, with Portuguese and English: `/es`, `/pt`, `/en`. `src/proxy.ts` sends `/` to the visitor's language.

| Route | Who | What |
|---|---|---|
| `/[lang]` | everyone | what Cuota does, the "escalera" chart, what the agent can't do |
| `/[lang]/new` | landlord, tutor, gym | four steps: agreement → index (with a live preview from the official source) → dollarize share and notices → review and sign `propose` |
| `/[lang]/c/[id]` | both parties | terms, announced adjustment, period receipts, notices, cancel. The payer allows and accepts here. Anyone can settle the upcoming period in USA₮ over x402. |
| `/[lang]/mine` | both parties | agreements for the connected wallet |

## Transactions from the browser

`propose`, `approve`, `accept` and `cancel` go through `src/web3/useTaggedTx.ts`. It appends the ERC-8021 suffix for `NEXT_PUBLIC_BUILDER_CODE` to the calldata before the wallet signs. No other code path sends transactions.

Gas works differently by wallet:

- **MiniPay** pays gas in the stablecoin the user holds.
- **Other wallets** need a little CELO. The app warns when the balance is zero.

## Run

```sh
cp .env.example .env.local
npm install
npm run dev          # http://localhost:3000, agent on CUOTA_AGENT_URL
npm run build && npm start
```
