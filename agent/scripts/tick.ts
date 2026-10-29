/** Run one agent pass and exit (cron-friendly alternative to the long-running server loop). */
import type { Address } from "viem";
import { connect } from "../src/celo.ts";
import { openDb } from "../src/db.ts";
import { Engine } from "../src/engine.ts";
import { readEnv } from "../src/env.ts";
import { Fx } from "../src/fx.ts";
import { Notices } from "../src/notices.ts";
import { Paid } from "../src/paid.ts";

const env = readEnv();
if (!env.CONTRACT) throw new Error("CONTRACT not set");
const db = openDb(env.DB_PATH);
const celo = connect(env);
const paid = new Paid(db, env.BUY_BUDGET_USD_PER_DAY, celo);
const engine = new Engine({
  db,
  celo,
  contract: env.CONTRACT as Address,
  fromBlock: env.CONTRACT_FROM_BLOCK,
  paid,
  fx: new Fx(celo, { url: env.TEXTILE_URL, key: env.TEXTILE_KEY, toleranceBps: env.FX_TOLERANCE_BPS }),
  notices: new Notices(db, paid, env.NOTIFY_WEBHOOK),
  log: (msg, data) => console.log(JSON.stringify({ msg, ...data })),
});
await engine.tick();
