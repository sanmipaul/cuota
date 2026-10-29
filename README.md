# Cuota

Rent and subscriptions in local-currency stablecoins that keep up with inflation, run by an agent on Celo.

Built for the Celo **Agents on Open Rails** hackathon. Primary track: **Stable Agents: LatAm** (Ripio wFIAT). It also dollarizes on Textile FX, accepts USA₮ over x402 from foreign payers, and pays for Chainstack and Cencori through buy.

## The problem

Martín rents out a flat in Buenos Aires. Like most Argentine leases, the rent is adjusted by an official index, here the ICL every four months. Today, every adjustment means:

- looking up the BCRA index;
- doing the division in a spreadsheet;
- messaging the tenant, who checks the maths;
- chasing transfers that arrive late and lose value every day they're late.

Then Martín buys dollars with part of it, because pesos don't hold value. Tutors, gyms, coworkings and Brazilian landlords on IGP-M do the same dance.

## What Cuota does

1. **The agreement is onchain.** Martín proposes the terms:
   - amount in wARS, period and first due date;
   - index (ICL, IPC, IPCA, IGP-M or a fixed step) and how often it adjusts;
   - a per-adjustment cap and an absolute ceiling;
   - how much he wants converted to dollars.

   The tenant accepts and approves wARS to the contract. The human-readable terms are hashed into the onchain terms.
2. **The agent adjusts with notice.** Before each adjustment date it fetches the index from the publisher (BCRA, INDEC via datos.gob.ar, BCB SGS) and computes the new amount. It announces the amount onchain with the index values as reference. The contract refuses anything above the agreed cap or ceiling, and applies it only from the first due date at least `notice` days away. Both parties get a plain-language notice in their language (Cencori through buy).
3. **It collects each period, never early.**
   - One paid Chainstack batch through buy checks every due agreement's amount, balance and allowance first. Problems become a notice to the payer, not a failed transaction.
   - Then it calls `collect`: Martín's share goes straight to him, and the conversion share goes to the agent.
4. **It dollarizes.** The agent sells the conversion share for USD₮ on Textile FX, after checking the quote against the market USD₮/ARS rate. It forwards the dollars through `settleConversion`, whose destination the contract fixes to the payee. If no fair quote comes within 24 hours, it hands back the pesos themselves.
5. **Foreign tenants pay in USA₮.** A tenant with no pesos opens `GET /pay/:agreementId`:
   - it returns a `402` for the upcoming period priced at the market USD₮ value of the peso amount;
   - the price is held for 10 minutes so it can't move between the 402 and the paid retry;
   - the USA₮ settles straight to the landlord through Celo's x402 facilitator, and the agent marks the period paid onchain.

### Why the contract matters

The agent only does what the payer agreed to:

- `announceAdjustment` is bounded by `maxStepBps`, `ceiling` and `notice`;
- `collect` works once per period, only when due;
- `settleConversion` can only pay the payee;
- `markPaidOffChain` only covers the upcoming period.

Either party can `cancel` at any time.

## Architecture

```
contracts/   Foundry. CuotaAgreements.
agent/       TypeScript (Node ≥ 22.13), Hono, node:sqlite.
frontend/    Next.js 16 + wagmi web app in Spanish, Portuguese and English (see frontend/README.md).
  src/indices.ts   ICL / IPC / IPCA / IGP-M fetchers and factor math
  src/schedule.ts  adjustment bounds and dates, mirrored from the contract
  src/engine.ts    the loop: sync → adjust → remind → collect → convert
  src/sync.ts      event-driven mirror of contract state (free public node)
  src/rpc.ts       collection preflight in one paid Chainstack batch (buy)
  src/notices.ts   Cencori-written notices (buy), template fallback, webhook delivery
  src/fx.ts        Textile RFQ v2 taker (wFIAT → USD₮) + market reference
  src/pay.ts       x402 USA₮ pay link (@x402/hono, Celo facilitator)
  src/paid.ts      buy CLI driver: cap per call, daily budget, settlement receipt per call
```

| Requirement | How |
|---|---|
| Mainnet wFIAT | wARS `0x0DC4…D90D`, wBRL `0xD76f…90e0`, wCOP `0x8a1d…2d76` (wMXN accepted, not dollarizable: no Textile market yet) |
| ERC-8021 | One viem wallet client, extended with `withAttribution(BUILDER_CODE)`; deploy, adjust, collect, convert, approvals all go through it |
| ERC-8004 | `npm run register` from the agent wallet; registration file at `/agent.json` |
| x402 | `GET /pay/:id`, USA₮ `0xD2ab…F771`, `api.x402.celo.org` with `X-API-Key` |
| buy | Chainstack `gateway.usebuy.ai/chainstack/celo` ($0.01 per batch of up to 2,000 calls), Cencori `gateway.usebuy.ai/cencori/v1/chat/completions` ($0.01) |
| Textile | `/v2/rfq/request` (TakerControl EIP-712 proof), approve, swap, `/submit` |

`GET /api/paid-calls` lists every buy call with its HTTP status and settlement tx.

## Running it

```sh
cd contracts && forge build && forge test

cd ../agent && npm install
cp .env.example .env
npm run deploy        # CuotaAgreements from the agent wallet (tagged), agent authorized
npm run register      # ERC-8004 identity
npm run buy:import    # agent key into buy's keychain
npm start             # API + agent loop every TICK_SECONDS

# web app
cd ../frontend && npm install
cp .env.example .env.local   # CUOTA_AGENT_URL, NEXT_PUBLIC_BUILDER_CODE
npm run dev                  # http://localhost:3000 → /es, /pt or /en
```

Tests:

```sh
npm test                                   # rules, index maths, receipt parsing
anvil --chain-id 42220 --port 18545 &
npm run e2e                                # full flow on a local chain with time travel
```

The local run deploys the contract and a mock peso. A landlord proposes and a tenant accepts using the calldata the API returns. It then travels through:

- a collection with a 40% conversion share;
- the 24-hour fallback that returns the pesos;
- a fixed +3% adjustment that lands on the right due date.

Finally it verifies the ERC-8021 tag on the agent's transactions.

## API

Public routes (`/v1`) serve the web app. Everything they return is onchain or committed by hash.

| Method | Path | |
|---|---|---|
| POST | `/v1/agreements/prepare` | terms → `propose` calldata for the payee; stores the off-chain plan by terms hash (rate-limited) |
| GET | `/v1/agreements/:id/payer-calls` | `approve` + `accept` calldata for the payer |
| GET | `/v1/agreements/:id` | terms, payments, conversions, notices, whether the period is payable in USA₮ |
| POST | `/v1/agreements/:id/refresh` | re-read one agreement from the chain right after a user's tx |
| GET | `/v1/wallets/:address/agreements` | agreements where the wallet is payee or payer |
| GET | `/v1/indices/:index/preview?months=N` | what ICL / IPC_AR / IPCA / IGPM did over the last N months |
| GET | `/pay/:id` | x402 USA₮ payment of the upcoming period |
| GET | `/agent.json` | ERC-8004 registration file |

Operator routes need `Authorization: Bearer $ADMIN_TOKEN`:

| Method | Path | |
|---|---|---|
| GET | `/api/agreements` | all agreements |
| GET | `/api/notices[?undelivered=1]` | notices |
| GET | `/api/paid-calls` | buy calls with settlement txs |
| POST | `/api/tick` | run the agent loop now |

Example proposal:

```json
{
  "payee": "0xLandlord", "payer": "0xTenant", "token": "wARS",
  "amount": 650000, "ceiling": 1950000, "maxStepPct": 25,
  "periodDays": 30, "noticeDays": 10, "firstDueDate": "2026-11-05",
  "index": "ICL", "adjustEveryMonths": 4, "convertPct": 40,
  "label": "Depto Palermo 3B", "locale": "es-AR"
}
```

## Notes

- **Index rules:**
  - ICL is the ratio of the daily values at the two dates.
  - IPC compares monthly levels with a one-month publication lag.
  - IPCA and IGP-M compound the monthly variations after the base month.

  The reference string (values and dates used) is hashed into the `AdjustmentAnnounced` event and shown in the notice.
- **Textile depth decides what can be dollarized.** On Celo today wARS→USD₮ and wBRL→USD₮ are deep. wMXN has no market.
- **The conversion share is custodial for one swap.** It sits with the agent between `collect` and `settleConversion`, bounded by the 24-hour return rule. Payees who don't want that set `convertPct` to 0.
