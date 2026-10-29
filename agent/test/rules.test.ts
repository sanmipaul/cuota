import { describe, expect, test } from "vitest";
import { dailyRatio, monthlyCompound, monthlyLevelRatio, valueAt } from "../src/indices.ts";
import { coverable, receiptTx } from "../src/paid.ts";
import { addMonthsUnix, adjustedAmount, announceWindowOpen, dueOnOrAfter, effectiveFrom } from "../src/schedule.ts";
import { template } from "../src/notices.ts";

const ARS = (n: number) => BigInt(n) * 10n ** 18n;
const DAY = 86_400;
const unix = (s: string) => Math.floor(Date.parse(s) / 1000);

describe("adjustedAmount", () => {
  test("applies the index and rounds to whole pesos", () => {
    expect(adjustedAmount(ARS(650_000), 1.1203, ARS(2_000_000), 2500)).toBe(ARS(728_195));
  });

  test("never exceeds the per-step cap", () => {
    expect(adjustedAmount(ARS(650_000), 1.4, ARS(2_000_000), 2500)).toBe(ARS(812_500));
  });

  test("never exceeds the ceiling", () => {
    expect(adjustedAmount(ARS(650_000), 1.2, ARS(700_000), 2500)).toBe(ARS(700_000));
  });

  test("allows decreases (deflation months happen in Brazil)", () => {
    expect(adjustedAmount(ARS(3_000), 0.9968, ARS(9_000), 2500)).toBe(ARS(2_990));
  });

  test("keeps 6 decimals for tiny amounts so the index still moves them", () => {
    const tiny = 10n ** 15n; // 0.001 of a peso
    expect(adjustedAmount(tiny, 1.1203, tiny * 3n, 2500)).toBe(1_120_000_000_000_000n); // 0.00112
  });

  test("rejects nonsense factors", () => {
    expect(() => adjustedAmount(ARS(1), Number.NaN, ARS(2), 100)).toThrow();
  });
});

describe("dates", () => {
  test("month arithmetic clamps to the last day", () => {
    expect(new Date(addMonthsUnix(unix("2027-01-31T12:00:00Z"), 1) * 1000).toISOString().slice(0, 10)).toBe("2027-02-28");
    expect(new Date(addMonthsUnix(unix("2026-11-05T12:00:00Z"), 4) * 1000).toISOString().slice(0, 10)).toBe("2027-03-05");
  });

  test("due date on or after", () => {
    const first = unix("2026-11-05T12:00:00Z");
    expect(dueOnOrAfter(first, 30 * DAY, first - DAY)).toBe(first);
    expect(dueOnOrAfter(first, 30 * DAY, first + 31 * DAY)).toBe(first + 60 * DAY);
  });

  test("effectiveFrom matches the contract: first due date past the notice", () => {
    const next = 1_000_000;
    expect(effectiveFrom(next, 30 * DAY, 10 * DAY, next - 11 * DAY)).toBe(next);
    expect(effectiveFrom(next, 30 * DAY, 10 * DAY, next - 1 * DAY)).toBe(next + 30 * DAY);
  });

  test("announce window opens notice + slack before the adjusted due date", () => {
    const due = 10_000_000;
    expect(announceWindowOpen(due, 10 * DAY, due - 14 * DAY)).toBe(false);
    expect(announceWindowOpen(due, 10 * DAY, due - 13 * DAY)).toBe(true);
  });
});

describe("index math", () => {
  const icl = [
    { date: "2026-04-24", value: 33.08 },
    { date: "2026-04-27", value: 33.1 },
    { date: "2026-10-23", value: 37.02 },
    { date: "2026-10-26", value: 37.07 },
  ];

  test("value at a weekend date falls back to the last publication", () => {
    expect(valueAt(icl, "2026-04-25")?.value).toBe(33.08);
  });

  test("ICL is a ratio of the two dates", () => {
    const f = dailyRatio(icl, new Date("2026-04-25"), new Date("2026-10-25"), "ICL");
    expect(f.factor).toBeCloseTo(37.02 / 33.08, 8);
    expect(f.ref).toContain("ICL 2026-10-23=37.02");
  });

  test("IPC uses levels with a one-month lag", () => {
    const ipc = [
      { date: "2026-05-01", value: 11500 },
      { date: "2026-06-01", value: 11826.4103 },
      { date: "2026-07-01", value: 12076.3937 },
      { date: "2026-08-01", value: 12276.766 },
    ];
    // Base: month before June = May. Up to: month before November = October, latest published August.
    const f = monthlyLevelRatio(ipc, new Date("2026-06-05"), new Date("2026-11-05"), "IPC");
    expect(f.factor).toBeCloseTo(12276.766 / 11500, 8);
  });

  test("IGP-M compounds monthly variations, negatives included", () => {
    const igpm = [
      { date: "2026-06-01", value: 0.5 },
      { date: "2026-07-01", value: 1 },
      { date: "2026-08-01", value: -0.22 },
      { date: "2026-09-01", value: 1.57 },
    ];
    const f = monthlyCompound(igpm, new Date("2026-07-10"), new Date("2026-10-10"), "IGP-M");
    expect(f.factor).toBeCloseTo(1.01 * 0.9978 * 1.0157, 8);
  });
});

describe("paying for services", () => {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64");
  const tx = `0x${"12".repeat(32)}`;

  test("reads the settlement tx from v1 and v2 receipt headers", () => {
    expect(receiptTx(new Headers({ "X-PAYMENT-RESPONSE": b64({ success: true, transaction: tx }) }))).toBe(tx);
    expect(receiptTx(new Headers({ "PAYMENT-RESPONSE": b64({ success: true, transaction: tx }) }))).toBe(tx);
  });

  test("no receipt, or a failed one, means no settlement", () => {
    expect(receiptTx(new Headers())).toBeUndefined();
    expect(receiptTx(new Headers({ "PAYMENT-RESPONSE": b64({ success: false, transaction: tx }) }))).toBeUndefined();
  });

  test("pays with a token the wallet holds", () => {
    const usdc = "0xceba9300f2b948710d2653dd7b07f33a8b32118c";
    const usdt = "0x48065fbbe25f71c9282ddf5e1cd6d6a887483d5e";
    const offers = [
      { asset: usdc, maxAmountRequired: "10000" },
      { asset: usdt, maxAmountRequired: "10000" },
    ];
    expect(coverable(offers, new Map([[usdt, 50_000n]])).map((o) => o.asset)).toEqual([usdt]);
    expect(coverable(offers, undefined)).toHaveLength(2);
  });
});

test("notice template falls back per language", () => {
  const t = template({ kind: "receipt", audience: "payee", locale: "pt-BR", label: "Aluguel Rua Augusta", facts: { valor: "wBRL 3.000" } });
  expect(t).toMatch(/^Pagamento recebido — Aluguel Rua Augusta/);
});
