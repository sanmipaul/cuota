"use client";

import { useI18n } from "@/i18n/context";

/**
 * "La escalera": a payment stepping up at each adjustment while the index climbs
 * smoothly underneath. Illustrative data: 2.5% monthly inflation, adjusted every 4 months.
 */
export function StairChart() {
  const { t, locale } = useI18n();
  const W = 520;
  const H = 300;
  const pad = { l: 16, r: 16, t: 40, b: 36 };
  const months = 12;
  const base = 650_000;
  const index = Array.from({ length: months + 1 }, (_, m) => base * 1.025 ** m);
  const rentAt = (m: number) => index[Math.floor(m / 4) * 4]!;
  const max = index[months]! * 1.04;
  const min = base * 0.92;
  const x = (m: number) => pad.l + (m / months) * (W - pad.l - pad.r);
  const y = (v: number) => pad.t + (1 - (v - min) / (max - min)) * (H - pad.t - pad.b);

  let stairs = `M${x(0)},${y(rentAt(0))}`;
  for (let m = 1; m <= months; m++) {
    stairs += ` H${x(m)}`;
    if (m % 4 === 0 && m < months) stairs += ` V${y(rentAt(m))}`;
  }
  const area = `${stairs} V${H - pad.b} H${x(0)} Z`;
  const indexPath = index.map((v, m) => `${m === 0 ? "M" : "L"}${x(m)},${y(v)}`).join(" ");
  const steps = [0, 4, 8];

  return (
    <figure className="card overflow-hidden p-5 sm:p-6">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label={t.home.chartCaption}>
        <defs>
          <linearGradient id="rentfill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor="var(--brick)" stopOpacity="0.22" />
            <stop offset="1" stopColor="var(--brick)" stopOpacity="0.02" />
          </linearGradient>
        </defs>
        {[0.25, 0.5, 0.75].map((f) => (
          <line key={f} x1={pad.l} x2={W - pad.r} y1={pad.t + f * (H - pad.t - pad.b)} y2={pad.t + f * (H - pad.t - pad.b)} stroke="var(--line)" strokeDasharray="2 4" />
        ))}
        <path d={area} fill="url(#rentfill)" />
        <path d={indexPath} fill="none" stroke="var(--muted)" strokeWidth="1.6" strokeDasharray="1 5" strokeLinecap="round" />
        <path d={stairs} pathLength={1} className="draw" fill="none" stroke="var(--brick)" strokeWidth="3" strokeLinejoin="round" strokeLinecap="round" />
        {steps.map((m) => (
          <g key={m}>
            <circle cx={x(m)} cy={y(rentAt(m))} r="4.5" fill="var(--card)" stroke="var(--brick)" strokeWidth="2.5" />
            <text x={x(m) + 8} y={y(rentAt(m)) - 10} fontSize="13" fontWeight="600" fill="var(--fg)" className="num">
              $ {Math.round(rentAt(m) / 1000).toLocaleString(locale)}k
            </text>
          </g>
        ))}
        {[0, 4, 8, 12].map((m) => (
          <text key={m} x={x(m)} y={H - 12} fontSize="11" fill="var(--faint)" textAnchor={m === 0 ? "start" : m === 12 ? "end" : "middle"}>
            {m === 0 ? "0" : `${m}m`}
          </text>
        ))}
      </svg>
      <figcaption className="mt-3 flex flex-wrap items-center justify-between gap-3 text-[13px] text-muted">
        <span>{t.home.chartCaption}</span>
        <span className="flex items-center gap-4">
          <span className="flex items-center gap-1.5">
            <span className="h-0.5 w-4 rounded bg-brick" />
            {t.home.chartRent}
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-0 w-4 border-t-2 border-dotted border-muted" />
            {t.home.chartIndex}
          </span>
        </span>
      </figcaption>
    </figure>
  );
}
