import { formatUnits } from "viem";
import { CURRENCIES, currencyByAddress, type Currency } from "@/web3/config";

/** 18-decimal wFIAT atomic → "$ 650.000" in the UI locale. */
export function money(atomic: string | bigint, currency: Currency | undefined, locale: string) {
  const n = Number(formatUnits(BigInt(atomic), 18));
  const sym = currency ? CURRENCIES[currency].symbol : "";
  return `${sym}\u00a0${n.toLocaleString(locale, { maximumFractionDigits: 6 })}`.trim();
}

export function moneyFor(atomic: string | bigint, tokenAddress: string, locale: string) {
  return money(atomic, currencyByAddress(tokenAddress), locale);
}

export function plainMoney(n: number, currency: Currency, locale: string) {
  return `${CURRENCIES[currency].symbol}\u00a0${n.toLocaleString(locale, { maximumFractionDigits: 6 })}`;
}

/** USA₮/USD₮ atomic (6 decimals) → "0.001", "396.59": every digit the token carries, at least cents. */
export function dollars(atomic: string | bigint, locale: string) {
  return Number(formatUnits(BigInt(atomic), 6)).toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 6 });
}

export function day(unix: number, locale: string) {
  return new Date(unix * 1000).toLocaleDateString(locale, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

export function pct(n: number, locale: string, digits = 1) {
  return `${n >= 0 ? "+" : ""}${n.toLocaleString(locale, { maximumFractionDigits: digits, minimumFractionDigits: digits })}%`;
}

export const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
