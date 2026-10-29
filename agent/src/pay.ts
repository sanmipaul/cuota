import { HTTPFacilitatorClient, x402ResourceServer, type RoutesConfig } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { paymentMiddleware } from "@x402/hono";
import type { MiddlewareHandler } from "hono";
import type { Address, Hex } from "viem";
import { cuotaAbi, USAT, wfiatByAddress, type Celo } from "./celo.ts";
import { now, type AgreementRow, type Db } from "./db.ts";
import { refresh } from "./sync.ts";
import type { Env } from "./env.ts";
import type { Fx } from "./fx.ts";

/**
 * Foreign tenants (a US remote worker renting in Palermo, say) don't hold pesos. They
 * pay the upcoming period in USA₮ over x402, straight to the landlord's wallet, at the
 * market rate for that period's peso amount. The agent then marks the period paid on
 * the contract so the peso pull is skipped.
 */

const QUOTE_TTL_S = 600; // the price must not move between the 402 and the paid retry

interface Quote {
  cycle: number;
  usat: bigint;
  at: number;
}

const ID = /^\/pay\/(\d+)$/;

export function payable(db: Db, path: string): { a: AgreementRow; reason?: string } | undefined {
  const m = ID.exec(path);
  if (!m) return undefined;
  const a = db.prepare("SELECT * FROM agreements WHERE id = ?").get(Number(m[1])) as unknown as AgreementRow | undefined;
  if (!a) return undefined;
  if (a.status !== "active") return { a, reason: `agreement is ${a.status}` };
  // Same rule as CuotaAgreements.markPaidOffChain: only the upcoming period.
  if (now() + a.period < a.next_due_at) return { a, reason: "the next period isn't open for payment yet" };
  const paid = db.prepare("SELECT 1 FROM payments WHERE agreement_id = ? AND cycle = ?").get(a.id, a.cycle);
  if (paid) return { a, reason: "this period is already paid" };
  return { a };
}

export function usatPayments(env: Env, db: Db, celo: Celo, fx: Fx, contract: Address, log: (m: string, d?: object) => void): MiddlewareHandler {
  const quotes = new Map<number, Quote>();

  async function quote(a: AgreementRow): Promise<Quote> {
    const cached = quotes.get(a.id);
    if (cached && cached.cycle === a.cycle && now() - cached.at < QUOTE_TTL_S) return cached;
    const due = (await celo.reader.readContract({
      address: contract,
      abi: cuotaAbi,
      functionName: "amountDue",
      args: [BigInt(a.id)],
    })) as bigint;
    const usdt = await fx.previewUsdt(a.token as Address, due);
    if (!usdt) throw new Error(`no market price for ${wfiatByAddress(a.token)?.symbol ?? a.token} right now`);
    // USA₮ and USD₮ trade at par on Textile (USAT/USDT ≈ 0.9998); quote in USA₮ 1:1.
    const q = { cycle: a.cycle, usat: usdt, at: now() };
    quotes.set(a.id, q);
    return q;
  }

  const facilitator = new HTTPFacilitatorClient({
    url: env.X402_URL,
    createAuthHeaders: async () => {
      const h = { "X-API-Key": env.X402_KEY };
      return { verify: h, settle: h, supported: h };
    },
  });
  const server = new x402ResourceServer(facilitator).register("eip155:42220", new ExactEvmScheme());

  server.onAfterSettle(async (ctx) => {
    const path = (ctx.transportContext as { request?: { path?: string } } | undefined)?.request?.path ?? "";
    const target = payable(db, path);
    if (!target || target.reason || !ctx.result.success) return;
    const { a } = target;
    const tx = ctx.result.transaction as Hex;
    db.prepare("INSERT OR IGNORE INTO payments (agreement_id, cycle, kind, amount, asset, tx, at) VALUES (?, ?, 'x402', ?, ?, ?, ?)").run(
      a.id,
      a.cycle,
      ctx.requirements.amount,
      USAT,
      tx,
      now(),
    );
    setImmediate(async () => {
      try {
        const hash = await celo.signer.writeContract({
          address: contract,
          abi: cuotaAbi,
          functionName: "markPaidOffChain",
          args: [BigInt(a.id), tx],
        });
        await celo.reader.waitForTransactionReceipt({ hash });
        await refresh(db, celo, contract, a.id).catch(() => undefined);
        log("period paid in USA₮", { agreement: a.id, cycle: a.cycle, settlement: tx, marked: hash });
      } catch (err) {
        log("markPaidOffChain failed; collection will be skipped by the payments table", { agreement: a.id, error: String(err) });
      }
    });
  });

  const routes: RoutesConfig = {
    "GET /pay/:id": {
      accepts: {
        scheme: "exact",
        network: "eip155:42220",
        maxTimeoutSeconds: 300,
        payTo: (ctx) => payable(db, ctx.path)?.a.payee ?? "0x0000000000000000000000000000000000000000",
        price: async (ctx) => {
          const target = payable(db, ctx.path);
          if (!target || target.reason) throw new Error(target?.reason ?? "unknown agreement");
          const q = await quote(target.a);
          return { asset: USAT, amount: q.usat.toString(), extra: { name: "Tether America USD", version: "1" } };
        },
      },
      description: "Cuota: pay this period in USA₮",
      mimeType: "application/json",
      serviceName: "Cuota",
    },
  };

  return paymentMiddleware(routes, server);
}
