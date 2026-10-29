import { decodeEventLog, formatUnits, keccak256, toBytes, zeroHash, type Address, type Hex } from "viem";
import { cuotaAbi, USDT, wfiatByAddress, type Celo } from "./celo.ts";
import { now, type AgreementRow, type Db, type DraftRow } from "./db.ts";
import { marketUsdtPer, type Fx } from "./fx.ts";
import { factor, INDEX_NAME, type IndexId } from "./indices.ts";
import type { Notices } from "./notices.ts";
import type { Paid } from "./paid.ts";
import { preflight } from "./rpc.ts";
import { addMonthsUnix, adjustedAmount, announceWindowOpen, dueOnOrAfter, effectiveFrom } from "./schedule.ts";
import { refresh, sync } from "./sync.ts";

/** Conversions that can't be filled at a fair price for this long are returned in wFIAT. */
const CONVERSION_PATIENCE_S = 24 * 3600;

export interface EngineDeps {
  db: Db;
  celo: Celo;
  contract: Address;
  fromBlock: bigint;
  paid: Paid;
  fx: Fx;
  notices: Notices;
  log: (msg: string, data?: Record<string, unknown>) => void;
}

type Joined = AgreementRow & Partial<DraftRow>;

const money = (v: bigint | string, symbol: string) =>
  `${symbol} ${Number(formatUnits(BigInt(v), 18)).toLocaleString("es-AR", { maximumFractionDigits: 6 })}`;
const day = (unix: number) => new Date(unix * 1000).toISOString().slice(0, 10);

export class Engine {
  private running = false;
  /** Chain time for this tick. The contract judges "due" by block.timestamp, so the agent does too. */
  private t = 0;

  constructor(private readonly d: EngineDeps) {}

  private active(): Joined[] {
    return this.d.db
      .prepare(
        `SELECT a.*, d.label, d.adjust_every_months, d.fixed_step_bps, d.locale, d.payee_contact, d.payer_contact
         FROM agreements a LEFT JOIN drafts d ON d.terms_hash = a.terms_hash
         WHERE a.status = 'active'`,
      )
      .all() as unknown as Joined[];
  }

  /** One pass of the agent: sync, adjust, remind, collect, convert. Never overlaps itself. */
  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      this.t = Number((await this.d.celo.reader.getBlock({ blockTag: "latest" })).timestamp);
      await sync(this.d.db, this.d.celo, this.d.contract, this.d.fromBlock);
      const agreements = this.active();
      for (const a of agreements) await this.step("adjust", a, () => this.adjust(a));
      for (const a of agreements) await this.step("remind", a, () => this.remindDueSoon(a));
      await this.collectDue();
      await this.convertQueued();
    } finally {
      this.running = false;
    }
  }

  private async step(name: string, a: AgreementRow, fn: () => Promise<void>) {
    try {
      await fn();
    } catch (err) {
      this.d.log(`${name} failed`, { agreement: a.id, error: String(err).slice(0, 300) });
    }
  }

  // ------------------------------------------------------------- adjustments

  private async adjust(a: Joined) {
    if (!a.adjust_every_months || a.pending_amount !== "0") return;
    const t = this.t;
    const adjustAt = addMonthsUnix(a.base_date, a.adjust_every_months);
    const adjustDue = dueOnOrAfter(a.first_due_at, a.period, adjustAt);
    if (!announceWindowOpen(adjustDue, a.notice, t)) return;

    const to = new Date(Math.min(adjustAt, t) * 1000);
    const f = await factor(a.index_id as IndexId, new Date(a.base_date * 1000), to, a.fixed_step_bps ?? 0);
    const current = BigInt(a.amount);
    const next = adjustedAmount(current, f.factor, BigInt(a.ceiling), a.max_step_bps);
    const symbol = wfiatByAddress(a.token)?.symbol ?? "wFIAT";

    if (next !== current) {
      const hash = await this.d.celo.signer.writeContract({
        address: this.d.contract,
        abi: cuotaAbi,
        functionName: "announceAdjustment",
        args: [BigInt(a.id), next, keccak256(toBytes(f.ref))],
      });
      await this.d.celo.reader.waitForTransactionReceipt({ hash });
      const from = effectiveFrom(a.next_due_at, a.period, a.notice, t);
      const capped = next < (current * BigInt(Math.round(f.factor * 1e6))) / 1_000_000n - 10n ** 18n;
      this.d.log("adjustment announced", { agreement: a.id, from: day(from), old: current.toString(), next: next.toString(), ref: f.ref, tx: hash });

      const facts = {
        index: INDEX_NAME[a.index_id as IndexId],
        reference: f.ref,
        change: `${((Number(next) / Number(current) - 1) * 100).toFixed(2)}%`,
        previous: money(current, symbol),
        new_amount: money(next, symbol),
        applies_from: day(from),
        ...(capped ? { note: `limited by the agreed cap of +${a.max_step_bps / 100}% per adjustment or the ceiling` } : {}),
        tx: hash,
      };
      for (const audience of ["payer", "payee"] as const) {
        await this.d.notices.send(a.id, `adj:${a.id}:${a.adjustments_done + 1}:${audience}`, {
          kind: "adjustment",
          audience,
          locale: a.locale ?? "es-AR",
          label: a.label ?? `#${a.id}`,
          facts,
        });
      }
    } else {
      this.d.log("index unchanged, no adjustment", { agreement: a.id, ref: f.ref });
    }
    this.d.db.prepare("UPDATE agreements SET base_date = ?, adjustments_done = adjustments_done + 1 WHERE id = ?").run(adjustAt, a.id);
  }

  // ------------------------------------------------------------- reminders

  private async remindDueSoon(a: Joined) {
    const t = this.t;
    if (a.next_due_at - t > 3 * 86_400 || a.next_due_at < t) return;
    const due = a.pending_amount !== "0" && a.next_due_at >= a.pending_from ? a.pending_amount : a.amount;
    const symbol = wfiatByAddress(a.token)?.symbol ?? "wFIAT";
    await this.d.notices.send(a.id, `due:${a.id}:${a.cycle}`, {
      kind: "due_soon",
      audience: "payer",
      locale: a.locale ?? "es-AR",
      label: a.label ?? `#${a.id}`,
      facts: { amount: money(due, symbol), due_date: day(a.next_due_at), keep_in_wallet: `${symbol} on Celo` },
    });
  }

  // ------------------------------------------------------------- collections

  private async collectDue() {
    const t = this.t;
    const paidAlready = this.d.db.prepare("SELECT 1 FROM payments WHERE agreement_id = ? AND cycle = ?");
    // A period paid in USA₮ over x402 is skipped even before markPaidOffChain lands.
    const due = this.active().filter((a) => a.next_due_at <= t && !paidAlready.get(a.id, a.cycle));
    if (due.length === 0) return;

    let checks: Map<number, { ok: boolean; due: bigint; balance: bigint; allowance: bigint }>;
    try {
      const results = await preflight(
        this.d.paid,
        this.d.contract,
        due.map((a) => ({ id: a.id, payer: a.payer as Address, token: a.token as Address })),
      );
      checks = new Map(results.map((r) => [r.id, r]));
    } catch (err) {
      // Without the paid preflight we still collect; a simulation on the public node
      // catches anything that would revert.
      this.d.log("preflight unavailable, simulating instead", { error: String(err).slice(0, 200) });
      checks = new Map();
    }

    for (const a of due) {
      const c = checks.get(a.id);
      const symbol = wfiatByAddress(a.token)?.symbol ?? "wFIAT";
      if (c && !c.ok) {
        const why = c.balance < c.due ? "insufficient_balance" : "allowance_too_low";
        await this.d.notices.send(a.id, `fail:${a.id}:${a.cycle}:${day(t)}`, {
          kind: "failed",
          audience: "payer",
          locale: a.locale ?? "es-AR",
          label: a.label ?? `#${a.id}`,
          facts: {
            amount: money(c.due, symbol),
            reason: why === "insufficient_balance" ? `balance ${money(c.balance, symbol)}` : "the approval for Cuota is below the amount due",
            next_try: "in a few hours",
          },
        });
        continue;
      }
      await this.step("collect", a, () => this.collectOne(a));
    }
  }

  private async collectOne(a: Joined) {
    const { signer, reader, account } = this.d.celo;
    const { request } = await reader.simulateContract({
      account,
      address: this.d.contract,
      abi: cuotaAbi,
      functionName: "collect",
      args: [BigInt(a.id)],
    });
    const hash = await signer.writeContract(request);
    const receipt = await reader.waitForTransactionReceipt({ hash });
    // Mirror the new cycle and due date now, so the web app doesn't show the period still due.
    await refresh(this.d.db, this.d.celo, this.d.contract, a.id).catch(() => undefined);

    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== this.d.contract.toLowerCase()) continue;
      let ev;
      try {
        ev = decodeEventLog({ abi: cuotaAbi, data: log.data, topics: log.topics });
      } catch {
        continue;
      }
      if (ev.eventName !== "Collected") continue;
      const { cycle, amount, toPayee, toConvert } = ev.args;
      this.d.db
        .prepare("INSERT OR IGNORE INTO payments (agreement_id, cycle, kind, amount, asset, tx, at) VALUES (?, ?, 'collect', ?, ?, ?, ?)")
        .run(a.id, cycle, amount.toString(), a.token, hash, now());
      if (toConvert > 0n) {
        this.d.db
          .prepare("INSERT OR IGNORE INTO conversions (agreement_id, cycle, token, sell_amount, state, queued_at) VALUES (?, ?, ?, ?, 'queued', ?)")
          .run(a.id, cycle, a.token, toConvert.toString(), this.t);
      }
      const symbol = wfiatByAddress(a.token)?.symbol ?? "wFIAT";
      this.d.log("collected", { agreement: a.id, cycle, amount: amount.toString(), tx: hash });
      await this.d.notices.send(a.id, `rcpt:${a.id}:${cycle}:payee`, {
        kind: "receipt",
        audience: "payee",
        locale: a.locale ?? "es-AR",
        label: a.label ?? `#${a.id}`,
        facts: {
          period: cycle,
          collected: money(amount, symbol),
          sent_to_you_now: money(toPayee, symbol),
          ...(toConvert > 0n ? { converting_to_usdt: money(toConvert, symbol) } : {}),
          tx: hash,
        },
      });
    }
  }

  // ------------------------------------------------------------- conversions

  private async convertQueued() {
    const queued = this.d.db.prepare("SELECT * FROM conversions WHERE state = 'queued'").all() as unknown as {
      agreement_id: number;
      cycle: number;
      token: string;
      sell_amount: string;
      attempts: number;
      queued_at: number;
    }[];

    for (const c of queued) {
      const token = wfiatByAddress(c.token);
      const amount = BigInt(c.sell_amount);
      try {
        let result: Awaited<ReturnType<Fx["sell"]>> = { filled: false, why: "not dollarizable" };
        if (token?.dollarizable) {
          result = await this.d.fx.sell(c.token as Address, amount, await marketUsdtPer(token.currency));
        }

        if (result.filled) {
          const settle = await this.settle(c.agreement_id, c.cycle, USDT, result.usdt, result.tx);
          this.d.db
            .prepare("UPDATE conversions SET state = 'settled', usdt_amount = ?, swap_tx = ?, settle_tx = ? WHERE agreement_id = ? AND cycle = ?")
            .run(result.usdt.toString(), result.tx, settle, c.agreement_id, c.cycle);
          this.d.log("conversion settled", { agreement: c.agreement_id, cycle: c.cycle, usdt: result.usdt.toString(), swap: result.tx });
          continue;
        }

        this.d.db.prepare("UPDATE conversions SET attempts = attempts + 1 WHERE agreement_id = ? AND cycle = ?").run(c.agreement_id, c.cycle);
        this.d.log("conversion deferred", { agreement: c.agreement_id, cycle: c.cycle, why: result.why });

        if (this.t - c.queued_at > CONVERSION_PATIENCE_S) {
          // Never sit on a landlord's money: hand back the pesos themselves.
          const settle = await this.settle(c.agreement_id, c.cycle, c.token as Address, amount, zeroHash);
          this.d.db
            .prepare("UPDATE conversions SET state = 'returned', settle_tx = ? WHERE agreement_id = ? AND cycle = ?")
            .run(settle, c.agreement_id, c.cycle);
          this.d.log("conversion returned in wFIAT", { agreement: c.agreement_id, cycle: c.cycle, why: result.why });
        }
      } catch (err) {
        this.d.log("conversion error", { agreement: c.agreement_id, cycle: c.cycle, error: String(err).slice(0, 300) });
      }
    }
  }

  private async settle(id: number, cycle: number, token: Address, amount: bigint, swapTx: Hex): Promise<Hex> {
    const { signer, reader } = this.d.celo;
    await ensureAllowance(this.d.celo, token, this.d.contract, amount);
    const hash = await signer.writeContract({
      address: this.d.contract,
      abi: cuotaAbi,
      functionName: "settleConversion",
      args: [BigInt(id), cycle, token, amount, swapTx],
    });
    await reader.waitForTransactionReceipt({ hash });
    return hash;
  }
}

async function ensureAllowance(celo: Celo, token: Address, spender: Address, amount: bigint) {
  const { reader, signer, account } = celo;
  const abi = [
    { type: "function", name: "allowance", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "uint256" }] },
    { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
  ] as const;
  const current = await reader.readContract({ address: token, abi, functionName: "allowance", args: [account.address, spender] });
  if (current >= amount) return;
  const hash = await signer.writeContract({ address: token, abi, functionName: "approve", args: [spender, 2n ** 255n] });
  await reader.waitForTransactionReceipt({ hash });
}
