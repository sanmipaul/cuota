<p align="center"><img src="frontend/public/brand/logo-light.png" alt="Cuota" width="320"></p>

# Cuota

**Rent and subscriptions in Ripio's peso and real stablecoins that keep up with inflation, run by an agent on Celo.** The agent adjusts each payment by the official index the parties chose (ICL, IPC, IPCA, IGP-M), with the notice they agreed. It collects every period, never early, and can convert the landlord's chosen share to dollars on Textile FX.

Built for the Celo **Agents on Open Rails** hackathon. Primary track: **Stable Agents: LatAm** (Ripio wFIAT). Also entered in **Open Corridors: USA₮ with x402** and **Build with buy**.

| | |
|---|---|
| Web app (es / pt / en) | https://cuota-new.vercel.app |
| Agent | https://cuota-agent.onrender.com (`/health`, `/agent.json`) |
| CuotaAgreements | [`0x76ffc3758e1a1982b008eebccc3eac29237ff904`](https://celoscan.io/address/0x76ffc3758e1a1982b008eebccc3eac29237ff904) |
| Agent wallet (x402 PayTo) | [`0x948DFa8F0F68573e77AaAE237cE655f3Fcf9D12F`](https://celoscan.io/address/0x948DFa8F0F68573e77AaAE237cE655f3Fcf9D12F) |
| ERC-8004 identity | agent **#10029** on the Celo IdentityRegistry `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` |
| ERC-8021 attribution code | `celo_44fa15bad4fc`, on every transaction the agent and the web app send |

## The problem

Martín rents out a flat in Buenos Aires. Like most Argentine leases, the rent is adjusted by an official index, here the ICL every four months. Every adjustment means looking up the BCRA index, doing the division in a spreadsheet, messaging the tenant who checks the maths, and chasing transfers that lose value every day they're late. Then he buys dollars with part of it, because pesos don't hold value. Tutors, gyms and Brazilian landlords on IGP-M do the same.

## What Cuota does

1. **The agreement lives onchain.** The landlord proposes the amount in wARS or wBRL, the period and first due date, the index and how often it adjusts, a cap per adjustment, an absolute ceiling, and the share to convert to dollars. The tenant accepts and approves wFIAT to the contract. The human-readable terms are hashed into the onchain terms.
2. **The agent adjusts with notice.** Before each adjustment date it fetches the index from its publisher (BCRA for ICL, INDEC via datos.gob.ar for IPC, BCB SGS for IPCA and IGP-M), computes the new amount, and announces it onchain with the index values as reference. The contract refuses anything above the agreed cap or ceiling and applies it only from the first due date at least `notice` days away. Both parties get a plain-language notice in their language.
3. **It collects each period, never early.** One paid Chainstack batch (through buy) checks every due agreement's amount, balance and allowance first, so problems become a notice instead of a failed transaction. Then it calls `collect`: the landlord's share goes straight to them, the conversion share to the agent.
4. **It dollarizes on request.** The agent sells the conversion share for USD₮ on Textile FX after checking the quote against the market rate, and forwards the dollars through `settleConversion`, whose destination the contract fixes to the payee. With no fair quote within 24 hours it hands back the pesos.
5. **Foreign tenants pay in USA₮.** A tenant without pesos opens the agreement and pays the upcoming period over x402 at the market USD value of the peso amount. The USA₮ settles to the agent wallet (the declared PayTo); the agent marks the period paid and forwards the USA₮ to the landlord through the contract.

### What the agent can't do

The contract enforces it: no charge above the per-adjustment cap or the ceiling the tenant signed, no increase without the agreed notice, no collecting the same period twice or before it's due, no sending converted funds anywhere but the payee. Either party can cancel at any time.

## Evidence for the judges

| Criterion | Where to check |
|---|---|
| Mainnet, real wFIAT | contract above; agreements use Ripio's wARS `0x0DC4F92879B7670e5f4e4e6e3c801D229129D90D` / wBRL `0xD76f5Faf6888e24D9F04Bf92a0c8B921FE4390e0` |
| Deployed and authorized from the agent wallet | deploy [`0xc62df2df…c35b`](https://celoscan.io/tx/0xc62df2df1d1690761d8304b7baa88fc9d3f59050e4192d53602e63aca107c35b), agent authorized [`0x5bdda592…32d5`](https://celoscan.io/tx/0x5bdda592b657ea663ae82ef9d9bc081ed72f14fbfd622ecd296ef83db86332d5) |
| ERC-8004 identity from the agent wallet | registration [`0x237a42ab…5747`](https://celoscan.io/tx/0x237a42ab1368eff5fcf635086d6f2de400afd5feb2394bb0f686038dc8b45747); registration file at https://cuota-agent.onrender.com/agent.json |
| Attribution tag everywhere | all agent transactions above end in the `celo_44fa15bad4fc` ERC-8021 suffix; the web app appends the same code to every transaction it asks a wallet to send (`frontend/src/web3/useTaggedTx.ts`) |
| Autonomous | the agent loop runs every 5 minutes: sync from events → adjust → remind → collect → convert (`agent/src/engine.ts`) |
| A real person can use it | Spanish, Portuguese and English, phone-friendly, wallet-native |

### Paid services (Build with buy)

| Service | Route | Price | Used for |
|---|---|---|---|
| Chainstack Celo RPC (via buy) | `gateway.usebuy.ai/chainstack/celo` | $0.01 per batch of up to 2,000 calls | amount, balance and allowance for every due agreement before collecting |
| Cencori LLM (via buy) | `gateway.usebuy.ai/cencori/v1/chat/completions` | $0.01 | adjustment, reminder and receipt notices in the parties' language |

The agent pays these 402s itself with an x402 client signing from its wallet, in a stablecoin it holds enough of, with a cap per call and a daily budget. Every payment is logged with its settlement tx: `GET /api/paid-calls` (operator token).

### Gas and relayers

- **USA₮ period payments:** the tenant signs one EIP-3009 authorization; Celo's x402 facilitator submits it and pays the gas. PayTo is the agent wallet.
- **Paid service calls:** settled the same way by buy's facilitator; the agent wallet signs.
- **Agreement transactions** (`propose`, `approve`, `accept`, `cancel`) are sent by the parties' own wallets from the web app and pay their own gas (MiniPay pays it in stablecoins).
- **Agent transactions** (adjust, collect, settle conversions, swaps, registration) are paid by the agent wallet in CELO.

## Architecture

```
contracts/   Foundry. CuotaAgreements.
agent/       TypeScript (Node ≥ 22.13), Hono, node:sqlite (backed up to Postgres).
  src/indices.ts   ICL / IPC / IPCA / IGP-M fetchers and factor maths
  src/schedule.ts  adjustment bounds and dates, mirrored from the contract
  src/engine.ts    the loop: sync → adjust → remind → collect → convert
  src/sync.ts      event-driven mirror of contract state
  src/rpc.ts       collection preflight in one paid Chainstack batch
  src/notices.ts   Cencori-written notices with a template fallback
  src/fx.ts        Textile RFQ v2 taker (wFIAT → USD₮) plus market reference
  src/pay.ts       x402 USA₮ payment of a period, forwarded to the payee
  src/paid.ts      x402 client for paid services: cap, budget, token choice, receipts
  src/backup.ts    SQLite → Postgres backup for hosts without a disk
frontend/    Next.js 16 + wagmi web app (es / pt / en).
```

**Index rules.** ICL is the ratio of the daily values at the two dates. IPC compares monthly levels with a one-month publication lag. IPCA and IGP-M compound the monthly variations after the base month. The reference string (values and dates used) is hashed into the `AdjustmentAnnounced` event and shown in the notice.

## Running it

```sh
cd contracts && forge build && forge test

cd ../agent && npm install
cp .env.example .env     # agent key, builder code, x402 key, admin token
npm run deploy           # CuotaAgreements from the agent wallet (tagged), agent authorized
npm run register         # ERC-8004 identity
npm start                # API + agent loop every TICK_SECONDS

cd ../frontend && npm install
cp .env.example .env.local   # CUOTA_AGENT_URL, NEXT_PUBLIC_BUILDER_CODE
npm run dev                  # http://localhost:3000 → /es, /pt or /en
```

Tests:

```sh
cd contracts && forge test     # 15 contract tests incl. a fuzz test on the ceiling
cd agent && npm test           # index maths, schedule rules, receipts, token choice
anvil --chain-id 42220 --port 18545 &
npm run e2e                    # propose/accept → collect with conversion share →
                               # 24 h fallback → fixed-step adjustment → USA₮ period
                               # forwarded to the landlord, with attribution checks
```

### Deployment

- **Agent and database:** Render blueprint (`render.yaml`) creates the agent from `agent/Dockerfile` and a free Postgres for its backup. `.github/workflows/keepalive.yml` pings `/health` every 10 minutes so the free instance doesn't sleep.
- **Web app:** Vercel with root directory `frontend`, `CUOTA_AGENT_URL` and `NEXT_PUBLIC_BUILDER_CODE`. The production build fails without the agent URL.

## API

Public routes (`/v1`) serve the web app; everything they return is onchain or committed by hash.

| Method | Path | |
|---|---|---|
| POST | `/v1/agreements/prepare` | terms → `propose` calldata for the payee; stores the off-chain plan by terms hash (rate-limited) |
| GET | `/v1/agreements/:id/payer-calls` | `approve` + `accept` calldata for the payer |
| GET | `/v1/agreements/:id` | terms, payments, conversions, notices, whether the period is payable in USA₮ |
| POST | `/v1/agreements/:id/refresh` | re-read one agreement from the chain after a user's transaction |
| GET | `/v1/wallets/:address/agreements` | agreements where the wallet is payee or payer |
| GET | `/v1/indices/:index/preview?months=N` | what an index did over the last N months |
| GET | `/pay/:id` | x402 USA₮ payment of the upcoming period |
| GET | `/agent.json`, `/logo.png` | ERC-8004 registration file and image |

Operator routes (`/api/*`, `Authorization: Bearer $ADMIN_TOKEN`): agreements, notices, paid calls, run the loop now.

## Notes

- **Textile depth decides what can be dollarized.** On Celo today wARS→USD₮ and wBRL→USD₮ are deep; wMXN has no market yet.
- **Funds the agent holds briefly:** the conversion share between `collect` and `settleConversion` (bounded by the 24-hour return rule), and a USA₮ period payment until it's forwarded. In both cases the contract fixes the destination to the payee.
- **Amounts accept up to 6 decimal places**, so tiny test agreements keep their value through adjustments.
