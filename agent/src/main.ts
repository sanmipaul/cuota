import { serve } from "@hono/node-server";
import type { Address } from "viem";
import { connect } from "./celo.ts";
import { Backup } from "./backup.ts";
import { openDb } from "./db.ts";
import { Engine } from "./engine.ts";
import { readEnv } from "./env.ts";
import { Fx } from "./fx.ts";
import { app } from "./http.ts";
import { Notices } from "./notices.ts";
import { Paid } from "./paid.ts";

const env = readEnv();
const log = (msg: string, data?: object) => console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...data }));

const backup = env.DATABASE_URL ? new Backup(env.DATABASE_URL, env.DB_PATH) : undefined;
if (backup) log("database backup", { state: await backup.restore() });
const db = openDb(env.DB_PATH);
const celo = connect(env);
const paid = new Paid(db, env.BUY_BUDGET_USD_PER_DAY, celo);
const fx = new Fx(celo, { url: env.TEXTILE_URL, key: env.TEXTILE_KEY, toleranceBps: env.FX_TOLERANCE_BPS });
const notices = new Notices(db, paid, env.NOTIFY_WEBHOOK);
const contract = env.CONTRACT as Address | undefined;

const engine = new Engine({
  db,
  celo,
  contract: contract ?? "0x0000000000000000000000000000000000000000",
  fromBlock: env.CONTRACT_FROM_BLOCK,
  paid,
  fx,
  notices,
  log,
});

const server = serve({ fetch: app({ env, db, celo, fx, engine, contract, log }).fetch, port: env.PORT }, () =>
  log("cuota agent up", { port: env.PORT, agent: celo.account.address, contract: contract ?? "not deployed" }),
);

if (contract) {
  const run = () =>
    engine
      .tick()
      .catch((err) => log("tick failed", { error: String(err).slice(0, 300) }))
      .then(() => backup?.save(db))
      .catch((err) => log("backup failed", { error: String(err).slice(0, 200) }));
  void run();
  setInterval(run, env.TICK_SECONDS * 1000);
} else {
  log("CONTRACT not set: deploy with `npm run deploy`, then restart");
}
if (!env.AGENT_ID) log("AGENT_ID not set: register the ERC-8004 identity with `npm run register`");

// Drafts are written by the API between ticks: copy the database out every minute too.
if (backup) setInterval(() => void backup.save(db).catch((err) => log("backup failed", { error: String(err).slice(0, 200) })), 60_000).unref();

// Hosts send SIGTERM before replacing the instance: take a last copy, then exit.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    log("shutting down", { signal });
    server.close();
    (backup ? backup.save(db).then(() => backup.close()) : Promise.resolve())
      .catch((err) => log("final backup failed", { error: String(err).slice(0, 200) }))
      .finally(() => process.exit(0));
  });
}
