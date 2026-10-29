/**
 * Pure scheduling rules, mirrored from CuotaAgreements so the agent never sends a
 * transaction the contract would reject.
 */

const WHOLE = 10n ** 18n; // wFIAT have 18 decimals
const MICRO = 10n ** 12n; // 0.000001 of a unit

/**
 * Index-adjusted amount, bounded the same way the contract bounds it: no more than
 * `maxStepBps` above the current amount and never above the agreed ceiling. Rounded to
 * a whole unit of currency, because nobody's rent is ARS 812,345.678.
 */
export function adjustedAmount(current: bigint, factor: number, ceiling: bigint, maxStepBps: number): bigint {
  if (!Number.isFinite(factor) || factor <= 0) throw new Error(`bad factor ${factor}`);
  const ppm = BigInt(Math.round(factor * 1_000_000));
  let next = (current * ppm) / 1_000_000n;
  // Real rents round to whole pesos/reais; tiny amounts keep 6 decimals so the index still moves them.
  const unit = current >= 100n * WHOLE ? WHOLE : MICRO;
  next = ((next + unit / 2n) / unit) * unit;
  const stepCap = current + (current * BigInt(maxStepBps)) / 10_000n;
  if (next > stepCap) next = stepCap;
  if (next > ceiling) next = ceiling;
  if (next <= 0n) next = current;
  return next;
}

/** Same month arithmetic as a rental contract: the adjustment date is `months` after the base date. */
export function addMonthsUnix(unix: number, months: number): number {
  const d = new Date(unix * 1000);
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, d.getUTCDate(), d.getUTCHours()));
  // 31 Jan + 1 month → 28/29 Feb, not 3 Mar
  if (target.getUTCDate() !== d.getUTCDate()) target.setUTCDate(0);
  return Math.floor(target.getTime() / 1000);
}

/** First due date on or after `at`. */
export function dueOnOrAfter(firstDueAt: number, period: number, at: number): number {
  if (at <= firstDueAt) return firstDueAt;
  const k = Math.ceil((at - firstDueAt) / period);
  return firstDueAt + k * period;
}

/** The contract's effective-from rule for an announcement sent at `now`. */
export function effectiveFrom(nextDueAt: number, period: number, notice: number, now: number): number {
  let from = nextDueAt;
  while (from < now + notice) from += period;
  return from;
}

/**
 * Announce when the adjusted due date is within notice + a few days' slack. Earlier
 * would use stale index data; later would push the adjustment a whole period out.
 */
export function announceWindowOpen(adjustDue: number, notice: number, now: number, slack = 3 * 86_400): boolean {
  return now >= adjustDue - notice - slack;
}
