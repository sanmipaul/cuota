import type { Address } from "viem";
import { cuotaAbi, type Celo } from "./celo.ts";
import { kvGet, kvSet, now, type Db } from "./db.ts";

/**
 * Mirror agreement state from the contract. Events tell us which agreements changed;
 * the authoritative struct is then read back with `get(id)`, so a missed or reordered
 * event can never leave the database disagreeing with the chain.
 *
 * This runs every tick, so it uses the free public node; paid Chainstack calls are kept
 * for the collection preflight where they matter.
 */

const CHUNK = 20_000n;
const STATUS = ["none", "proposed", "active", "cancelled"] as const;

export async function sync(db: Db, celo: Celo, contract: Address, fromBlock: bigint): Promise<number[]> {
  // cacheTime 0: viem otherwise reuses the head for a few seconds and back-to-back syncs miss events.
  const head = await celo.reader.getBlockNumber({ cacheTime: 0 });
  let cursor = BigInt(kvGet(db, "sync_block") ?? (fromBlock > 0n ? fromBlock - 1n : 0n).toString());
  const touched = new Set<number>();

  while (cursor < head) {
    const to = cursor + CHUNK < head ? cursor + CHUNK : head;
    const logs = await celo.reader.getContractEvents({ address: contract, abi: cuotaAbi, fromBlock: cursor + 1n, toBlock: to });
    for (const log of logs) {
      const id = (log.args as { id?: bigint }).id;
      if (id !== undefined) touched.add(Number(id));
    }
    cursor = to;
    kvSet(db, "sync_block", cursor.toString());
  }

  for (const id of touched) await refresh(db, celo, contract, id);
  return [...touched];
}

export async function refresh(db: Db, celo: Celo, contract: Address, id: number) {
  const a = await celo.reader.readContract({ address: contract, abi: cuotaAbi, functionName: "get", args: [BigInt(id)] });
  const t = a.terms;
  const existing = db.prepare("SELECT base_date FROM agreements WHERE id = ?").get(id) as { base_date: number } | undefined;

  db.prepare(
    `INSERT INTO agreements (id, payee, payer, token, amount, ceiling, max_step_bps, period, notice, first_due_at,
       next_due_at, cycle, convert_bps, index_id, terms_hash, status, pending_amount, pending_from, base_date, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       amount = excluded.amount, next_due_at = excluded.next_due_at, cycle = excluded.cycle,
       status = excluded.status, pending_amount = excluded.pending_amount,
       pending_from = excluded.pending_from, updated_at = excluded.updated_at`,
  ).run(
    id,
    a.payee.toLowerCase(),
    t.payer.toLowerCase(),
    t.token.toLowerCase(),
    a.amount.toString(),
    t.ceiling.toString(),
    t.maxStepBps,
    t.period,
    t.notice,
    Number(t.firstDueAt),
    Number(a.nextDueAt),
    a.cycle,
    t.convertBps,
    t.index,
    t.termsHash.toLowerCase(),
    STATUS[a.status] ?? "none",
    a.pendingAmount.toString(),
    Number(a.pendingFrom),
    // The price clock starts at the first due date; later adjustments move it forward.
    existing?.base_date ?? Number(t.firstDueAt),
    now(),
  );
}
