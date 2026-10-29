/**
 * Official inflation indices, straight from the publishers' public APIs:
 *
 *   ICL     Índice para Contratos de Locación — BCRA, variable 40, daily
 *   IPC     Índice de Precios al Consumidor — INDEC via datos.gob.ar, monthly level
 *   IPCA    Índice Nacional de Preços ao Consumidor Amplo — BCB SGS 433, monthly %
 *   IGP-M   Índice Geral de Preços do Mercado — BCB SGS 189, monthly %
 *
 * `factor(index, from, to)` answers "how much should a price set on `from` have moved by
 * `to`", using only data published by now, plus a human-readable reference that goes
 * onchain with the adjustment so the payer can check the arithmetic.
 */

export const INDEX = { ICL: 1, IPC_AR: 2, IPCA: 3, IGPM: 4, FIXED: 5 } as const;
export type IndexId = (typeof INDEX)[keyof typeof INDEX];

export const INDEX_NAME: Record<IndexId, string> = {
  1: "ICL (BCRA)",
  2: "IPC (INDEC)",
  3: "IPCA (IBGE)",
  4: "IGP-M (FGV)",
  5: "fixed step",
};

export interface Factor {
  factor: number;
  ref: string;
}

type Point = { date: string; value: number }; // date: YYYY-MM-DD

const ymd = (d: Date) => d.toISOString().slice(0, 10);
const monthKey = (d: Date) => d.toISOString().slice(0, 7);

function addMonths(d: Date, n: number): Date {
  const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
  return x;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000), headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`${new URL(url).host}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

// ------------------------------------------------------------------ fetchers

export async function fetchIcl(from: Date, to: Date): Promise<Point[]> {
  const start = new Date(from.getTime() - 10 * 86_400_000); // pad for weekends/holidays
  const url = `https://api.bcra.gob.ar/estadisticas/v4.0/monetarias/40?desde=${ymd(start)}&hasta=${ymd(to)}&limit=3000`;
  const body = await getJson<{ results?: { detalle?: { fecha: string; valor: number }[] }[] }>(url);
  const rows = body.results?.[0]?.detalle ?? [];
  return rows.map((r) => ({ date: r.fecha, value: r.valor })).sort((a, b) => a.date.localeCompare(b.date));
}

export async function fetchIpcAr(from: Date): Promise<Point[]> {
  const start = ymd(addMonths(from, -2));
  const url = `https://apis.datos.gob.ar/series/api/series/?ids=148.3_INIVELNAL_DICI_M_26&start_date=${start}&format=json&limit=500`;
  const body = await getJson<{ data?: [string, number | null][] }>(url);
  return (body.data ?? []).filter(([, v]) => v !== null).map(([date, value]) => ({ date, value: value as number }));
}

/** BCB SGS monthly variation series (percent per month). */
export async function fetchSgs(series: 433 | 189, from: Date, to: Date): Promise<Point[]> {
  const br = (d: Date) => `${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${d.getUTCFullYear()}`;
  const url = `https://api.bcb.gov.br/dados/serie/bcdata.sgs.${series}/dados?formato=json&dataInicial=${br(addMonths(from, -2))}&dataFinal=${br(to)}`;
  const rows = await getJson<{ data: string; valor: string }[]>(url);
  return rows.map((r) => {
    const [dd, mm, yyyy] = r.data.split("/");
    return { date: `${yyyy}-${mm}-${dd}`, value: Number(r.valor) };
  });
}

// ------------------------------------------------------------------ math (pure)

/** Last published value on or before `date`. */
export function valueAt(points: Point[], date: string): Point | undefined {
  let found: Point | undefined;
  for (const p of points) {
    if (p.date <= date) found = p;
    else break;
  }
  return found;
}

/** Daily index: plain ratio between the two dates. */
export function dailyRatio(points: Point[], from: Date, to: Date, name: string): Factor {
  const a = valueAt(points, ymd(from));
  const b = valueAt(points, ymd(to));
  if (!a || !b) throw new Error(`${name}: no data for ${ymd(from)}..${ymd(to)}`);
  return { factor: b.value / a.value, ref: `${name} ${b.date}=${b.value} / ${a.date}=${a.value}` };
}

/**
 * Monthly price level with the usual one-month publication lag: compare the level of
 * the month before `to` (or the latest published, if that's not out yet) with the level
 * of the month before `from`.
 */
export function monthlyLevelRatio(points: Point[], from: Date, to: Date, name: string): Factor {
  const baseMonth = monthKey(addMonths(from, -1));
  const lastAllowed = monthKey(addMonths(to, -1));
  const base = points.find((p) => p.date.startsWith(baseMonth));
  const latest = [...points].reverse().find((p) => p.date.slice(0, 7) <= lastAllowed);
  if (!base || !latest) throw new Error(`${name}: missing level for ${baseMonth} or later`);
  return {
    factor: latest.value / base.value,
    ref: `${name} ${latest.date.slice(0, 7)}=${latest.value} / ${baseMonth}=${base.value}`,
  };
}

/** Monthly % variations compounded over the months after the base month, same lag rule. */
export function monthlyCompound(points: Point[], from: Date, to: Date, name: string): Factor {
  const baseMonth = monthKey(addMonths(from, -1));
  const lastAllowed = monthKey(addMonths(to, -1));
  const months = points.filter((p) => p.date.slice(0, 7) > baseMonth && p.date.slice(0, 7) <= lastAllowed);
  if (months.length === 0) throw new Error(`${name}: no published months after ${baseMonth}`);
  const factor = months.reduce((f, p) => f * (1 + p.value / 100), 1);
  const span = `${months[0]!.date.slice(0, 7)}..${months.at(-1)!.date.slice(0, 7)}`;
  return { factor, ref: `${name} ${span} compounded ${((factor - 1) * 100).toFixed(2)}%` };
}

export async function factor(index: IndexId, from: Date, to: Date, fixedStepBps = 0): Promise<Factor> {
  switch (index) {
    case INDEX.ICL:
      return dailyRatio(await fetchIcl(from, to), from, to, "ICL");
    case INDEX.IPC_AR:
      return monthlyLevelRatio(await fetchIpcAr(from), from, to, "IPC");
    case INDEX.IPCA:
      return monthlyCompound(await fetchSgs(433, from, to), from, to, "IPCA");
    case INDEX.IGPM:
      return monthlyCompound(await fetchSgs(189, from, to), from, to, "IGP-M");
    case INDEX.FIXED:
      return { factor: 1 + fixedStepBps / 10_000, ref: `fixed +${(fixedStepBps / 100).toFixed(2)}%` };
  }
}
