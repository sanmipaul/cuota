import { DatabaseSync } from "node:sqlite";

/**
 * SQLite through node:sqlite (Node ≥ 22.13), so the agent has no native dependencies.
 * Amounts are stored as decimal strings of atomic units; timestamps as unix seconds.
 */
export type Db = DatabaseSync;

export function openDb(path: string): Db {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;

    -- Off-chain plan attached to a proposal before it is signed, matched by terms_hash.
    CREATE TABLE IF NOT EXISTS drafts (
      terms_hash TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      adjust_every_months INTEGER NOT NULL,
      fixed_step_bps INTEGER NOT NULL DEFAULT 0,
      locale TEXT NOT NULL,
      payee_contact TEXT,
      payer_contact TEXT,
      document TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS agreements (
      id INTEGER PRIMARY KEY,
      payee TEXT NOT NULL,
      payer TEXT NOT NULL,
      token TEXT NOT NULL,
      amount TEXT NOT NULL,
      ceiling TEXT NOT NULL,
      max_step_bps INTEGER NOT NULL,
      period INTEGER NOT NULL,
      notice INTEGER NOT NULL,
      first_due_at INTEGER NOT NULL,
      next_due_at INTEGER NOT NULL,
      cycle INTEGER NOT NULL,
      convert_bps INTEGER NOT NULL,
      index_id INTEGER NOT NULL,
      terms_hash TEXT NOT NULL,
      status TEXT NOT NULL,
      pending_amount TEXT NOT NULL DEFAULT '0',
      pending_from INTEGER NOT NULL DEFAULT 0,
      base_date INTEGER NOT NULL,
      adjustments_done INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS payments (
      agreement_id INTEGER NOT NULL,
      cycle INTEGER NOT NULL,
      kind TEXT NOT NULL,          -- collect | x402
      amount TEXT NOT NULL,
      asset TEXT NOT NULL,
      tx TEXT NOT NULL,
      at INTEGER NOT NULL,
      PRIMARY KEY (agreement_id, cycle)
    );

    CREATE TABLE IF NOT EXISTS conversions (
      agreement_id INTEGER NOT NULL,
      cycle INTEGER NOT NULL,
      token TEXT NOT NULL,
      sell_amount TEXT NOT NULL,
      usdt_amount TEXT,
      swap_tx TEXT,
      settle_tx TEXT,
      state TEXT NOT NULL,         -- queued | settled | returned
      attempts INTEGER NOT NULL DEFAULT 0,
      queued_at INTEGER NOT NULL,
      PRIMARY KEY (agreement_id, cycle)
    );

    CREATE TABLE IF NOT EXISTS notices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agreement_id INTEGER NOT NULL,
      audience TEXT NOT NULL,      -- payer | payee
      kind TEXT NOT NULL,          -- adjustment | due_soon | failed | receipt
      dedupe TEXT UNIQUE,
      body TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      delivered_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS paid_calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at INTEGER NOT NULL,
      service TEXT NOT NULL,
      url TEXT NOT NULL,
      cap_usd REAL NOT NULL,
      settlement_tx TEXT,
      http_status INTEGER,
      purpose TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
  `);
  return db;
}

export const now = () => Math.floor(Date.now() / 1000);

export function kvGet(db: Db, k: string): string | undefined {
  const row = db.prepare("SELECT v FROM kv WHERE k = ?").get(k) as { v: string } | undefined;
  return row?.v;
}

export function kvSet(db: Db, k: string, v: string) {
  db.prepare("INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(k, v);
}

export interface AgreementRow {
  id: number;
  payee: string;
  payer: string;
  token: string;
  amount: string;
  ceiling: string;
  max_step_bps: number;
  period: number;
  notice: number;
  first_due_at: number;
  next_due_at: number;
  cycle: number;
  convert_bps: number;
  index_id: number;
  terms_hash: string;
  status: "proposed" | "active" | "cancelled";
  pending_amount: string;
  pending_from: number;
  base_date: number;
  adjustments_done: number;
}

export interface DraftRow {
  terms_hash: string;
  label: string;
  adjust_every_months: number;
  fixed_step_bps: number;
  locale: "es-AR" | "pt-BR" | "es-CO" | "es-MX";
  payee_contact: string | null;
  payer_contact: string | null;
  document: string;
}
