import { ExactEvmScheme } from "@x402/evm/exact/client";
import { ExactEvmSchemeV1 } from "@x402/evm/exact/v1/client";
import { decodePaymentResponseHeader, wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { erc20Abi, type Address } from "viem";
import type { Celo } from "./celo.ts";
import { now, type Db } from "./db.ts";

/**
 * Cuota buys Chainstack RPC batches and Cencori completions through buy's gateway
 * (gateway.usebuy.ai, x402 v1 on "celo"). The agent answers each 402 itself, signing an
 * EIP-3009 authorization from its own wallet, so it runs on any server: the `buy` CLI's
 * keystore needs an OS keychain for mainnet keys, which hosts don't have.
 *
 * Guards: a cap per call (refused before signing above it), a daily budget, and a token
 * the wallet can actually cover. Every payment is logged with its settlement tx.
 */

const STABLES: Address[] = [
  "0xcebA9300f2b948710d2653dD7B07f33A8B32118C", // USDC
  "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e", // USD₮
  "0xD2ab3C9A02DBBAB236BfEC45D1d755DF4267F771", // USA₮
];

export interface PaidResponse<T> {
  status: number;
  body: T | undefined;
  text: string;
  settlementTx?: string;
}

export class OverBudget extends Error {}

type Offer = { asset: string; amount?: string; maxAmountRequired?: string };

/** Offers the wallet holds enough of; all of them when balances are unknown or none fit. */
export function coverable<T extends Offer>(offers: T[], holdings: Map<string, bigint> | undefined): T[] {
  if (!holdings) return offers;
  const fits = offers.filter((o) => (holdings.get(o.asset.toLowerCase()) ?? 0n) >= BigInt(o.amount ?? o.maxAmountRequired ?? "0"));
  return fits.length > 0 ? fits : offers;
}

/** The settlement tx from an x402 receipt header (`PAYMENT-RESPONSE` in v2, `X-PAYMENT-RESPONSE` in v1). */
export function receiptTx(headers: Headers): string | undefined {
  const header = headers.get("PAYMENT-RESPONSE") ?? headers.get("X-PAYMENT-RESPONSE");
  if (!header) return undefined;
  try {
    const r = decodePaymentResponseHeader(header) as { success?: boolean; transaction?: string };
    return r.success !== false ? r.transaction : undefined;
  } catch {
    return undefined;
  }
}

export class Paid {
  private holdings: { at: number; map: Map<string, bigint> } | undefined;

  constructor(
    private readonly db: Db,
    private readonly budgetUsdPerDay: number,
    private readonly celo: Celo,
  ) {}

  spentToday(): number {
    const midnight = Math.floor(new Date().setUTCHours(0, 0, 0, 0) / 1000);
    const row = this.db.prepare("SELECT COALESCE(SUM(cap_usd), 0) AS s FROM paid_calls WHERE at >= ?").get(midnight) as { s: number };
    return row.s;
  }

  private async balances(): Promise<Map<string, bigint> | undefined> {
    if (this.holdings && Date.now() - this.holdings.at < 30_000) return this.holdings.map;
    try {
      const { reader, account } = this.celo;
      const values = await Promise.all(STABLES.map((t) => reader.readContract({ address: t, abi: erc20Abi, functionName: "balanceOf", args: [account.address] })));
      const map = new Map(STABLES.map((t, i) => [t.toLowerCase(), values[i]!] as const));
      this.holdings = { at: Date.now(), map };
      return map;
    } catch {
      return undefined;
    }
  }

  async post<T>(service: string, url: string, payload: unknown, capUsd: number, purpose: string): Promise<PaidResponse<T>> {
    if (this.spentToday() + capUsd > this.budgetUsdPerDay) {
      throw new OverBudget(`${service}: daily budget of $${this.budgetUsdPerDay} reached`);
    }
    const holdings = await this.balances();
    const signer = this.celo.account;
    const client = new x402Client()
      .registerV1("celo", new ExactEvmSchemeV1(signer))
      .register("eip155:42220", new ExactEvmScheme(signer))
      .setSpendControls({ maxAmountPerPayment: `$${capUsd}` })
      .registerPolicy((_v, offers) => coverable(offers as unknown as Offer[], holdings) as unknown as typeof offers);

    const res = await wrapFetchWithPayment(fetch, client)(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(90_000),
    });
    const settlementTx = receiptTx(res.headers);
    if (settlementTx) this.holdings = undefined;
    const text = await res.text();

    if (settlementTx || res.ok) {
      this.db
        .prepare("INSERT INTO paid_calls (at, service, url, cap_usd, settlement_tx, http_status, purpose) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(now(), service, url, capUsd, settlementTx ?? null, res.status, purpose);
    }
    if (!res.ok) throw new Error(`${service}: HTTP ${res.status} ${text.slice(0, 160)}`);

    let body: T | undefined;
    try {
      body = JSON.parse(text) as T;
    } catch {
      body = undefined;
    }
    return { status: res.status, body, text, settlementTx };
  }
}
