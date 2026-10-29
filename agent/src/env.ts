import { z } from "zod";

const Env = z.object({
  PORT: z.coerce.number().int().default(8787),
  BASE_URL: z.string().url().default("http://localhost:8787"),
  DB_PATH: z.string().default("./cuota.db"),
  /** Postgres to back the SQLite file up to, for hosts without a persistent disk. */
  DATABASE_URL: z.string().url().optional(),

  RPC_URL: z.string().url().default("https://forno.celo.org"),
  AGENT_KEY: z.string().regex(/^0x[0-9a-fA-F]{64}$/, "AGENT_KEY must be a 0x-prefixed private key"),
  CONTRACT: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
  CONTRACT_FROM_BLOCK: z.coerce.bigint().default(0n),

  /** ERC-8021 code from hackathon enrollment; appended to every agent transaction. */
  BUILDER_CODE: z.string().min(1),
  /** ERC-8004 agent id once registered. */
  AGENT_ID: z.coerce.number().int().optional(),

  X402_URL: z.string().url().default("https://api.x402.celo.org"),
  X402_KEY: z.string().min(1),

  TEXTILE_URL: z.string().url().default("https://api.textilecredit.com/v2"),
  TEXTILE_KEY: z.string().optional(),
  /** Refuse a wFIAT→USD₮ fill that is this much worse than the market. */
  FX_TOLERANCE_BPS: z.coerce.number().default(200),

  BUY_BUDGET_USD_PER_DAY: z.coerce.number().default(1.5),

  /** Where notices are POSTed for delivery (Telegram/WhatsApp bridge, email worker). */
  NOTIFY_WEBHOOK: z.string().url().optional(),
  ADMIN_TOKEN: z.string().min(16),
  TICK_SECONDS: z.coerce.number().int().default(300),
});

export type Env = z.infer<typeof Env>;

export function readEnv(): Env {
  // `KEY=` means "not set". Render publishes the service URL, used unless BASE_URL is given.
  const set: Record<string, string> = Object.fromEntries(
    Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined && e[1].trim() !== ""),
  );
  if (!set.BASE_URL && set.RENDER_EXTERNAL_URL) set.BASE_URL = set.RENDER_EXTERNAL_URL;
  const r = Env.safeParse(set);
  if (!r.success) {
    console.error("cuota: bad environment");
    for (const i of r.error.issues) console.error(`  ${i.path.join(".")}: ${i.message}`);
    process.exit(1);
  }
  return r.data;
}
