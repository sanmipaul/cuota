import { existsSync, readFileSync, writeFileSync } from "node:fs";
import pg from "pg";
import type { Db } from "./db.ts";

/**
 * Keeps the SQLite file safe on hosts without a persistent disk (Render's free tier wipes
 * it on every restart). Agreements and payments can be rebuilt from the chain, but the
 * off-chain plan of each agreement (adjustment schedule, label, notice language) can't,
 * so the whole database file is copied into one Postgres row and restored on boot.
 */
export class Backup {
  private readonly pool: pg.Pool;
  private chain: Promise<void> = Promise.resolve();

  constructor(
    url: string,
    private readonly path: string,
  ) {
    this.pool = new pg.Pool({ connectionString: url, max: 2 });
  }

  /** Before opening the database: bring back the last copy if the local file is gone. */
  async restore(): Promise<"restored" | "kept-local" | "empty"> {
    await this.pool.query("CREATE TABLE IF NOT EXISTS cuota_backup (id text PRIMARY KEY, data bytea NOT NULL, saved_at timestamptz NOT NULL DEFAULT now())");
    if (existsSync(this.path)) return "kept-local";
    const res = await this.pool.query<{ data: Buffer }>("SELECT data FROM cuota_backup WHERE id = 'main'");
    if (!res.rows[0]) return "empty";
    writeFileSync(this.path, res.rows[0].data);
    return "restored";
  }

  /** Copy the current database into Postgres. Calls queue up; one write runs at a time. */
  save(db: Db): Promise<void> {
    this.chain = this.chain.then(async () => {
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); // fold the WAL into the main file first
      await this.pool.query(
        "INSERT INTO cuota_backup (id, data) VALUES ('main', $1) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, saved_at = now()",
        [readFileSync(this.path)],
      );
    });
    return this.chain;
  }

  async close() {
    await this.chain.catch(() => undefined);
    await this.pool.end();
  }
}
