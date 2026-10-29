import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { encodeFunctionData, erc20Abi, isAddress, keccak256, parseUnits, toBytes, type Address } from "viem";
import { z } from "zod";
import { cuotaAbi, WFIAT, type Celo } from "./celo.ts";
import { now, type Db } from "./db.ts";
import type { Engine } from "./engine.ts";
import type { Env } from "./env.ts";
import type { Fx } from "./fx.ts";
import { factor, INDEX, INDEX_NAME } from "./indices.ts";
import { payable, usatPayments } from "./pay.ts";
import { refresh } from "./sync.ts";

const address = z.string().refine((v) => isAddress(v), "not an address");

const PrepareBody = z.object({
  payee: address,
  payer: address,
  token: z.enum(["wARS", "wBRL", "wCOP", "wMXN"]),
  /** Starting amount in whole currency units, e.g. 650000 for ARS 650,000. */
  amount: z.number().positive(),
  /** Hard ceiling per period the payer agrees to, in whole units. Defaults to 3× the start. */
  ceiling: z.number().positive().optional(),
  maxStepPct: z.number().min(0).max(100).default(25),
  periodDays: z.number().int().min(1).max(366).default(30),
  noticeDays: z.number().int().min(0).max(90).default(10),
  firstDueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  convertPct: z.number().min(0).max(100).default(0),
  index: z.enum(["ICL", "IPC_AR", "IPCA", "IGPM", "FIXED"]),
  adjustEveryMonths: z.number().int().min(1).max(24),
  fixedStepPct: z.number().min(0).max(100).default(0),
  label: z.string().min(1).max(80),
  locale: z.enum(["es-AR", "pt-BR", "es-CO", "es-MX"]).default("es-AR"),
  payeeContact: z.string().max(120).optional(),
  payerContact: z.string().max(120).optional(),
});

export function app(deps: { env: Env; db: Db; celo: Celo; fx: Fx; engine: Engine; contract?: Address; log: (m: string, d?: object) => void }) {
  const { env, db, celo, fx, engine, contract, log } = deps;
  const api = new Hono();

  api.onError((err, c) => {
    if (err instanceof z.ZodError) return c.json({ error: "invalid request", issues: err.issues }, 400);
    if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
    log("request failed", { error: String(err) });
    return c.json({ error: "internal error" }, 500);
  });

  api.get("/health", (c) => c.json({ ok: true, agent: celo.account.address, contract }));

  api.get("/agent.json", (c) =>
    c.json({
      type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
      name: "Cuota",
      description:
        "Recurring payments in wARS/wBRL that follow official inflation indices (ICL, IPC, IPCA, IGP-M). " +
        "Announces adjustments onchain with notice, collects each period, dollarizes the payee's chosen share on " +
        "Textile FX, and lets foreign payers settle a period in USA₮ over x402.",
      image: `${env.BASE_URL}/logo.png`,
      services: [
        { name: "web", endpoint: env.BASE_URL },
        { name: "x402-pay-period", endpoint: `${env.BASE_URL}/pay/{agreementId}` },
      ],
      x402Support: true,
      active: true,
      supportedTrust: ["reputation"],
      registrations: env.AGENT_ID
        ? [{ agentId: env.AGENT_ID, agentRegistry: "eip155:42220:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432" }]
        : [],
    }),
  );

  // ---- public: pay a period in USA₮ (x402) ----
  if (contract) {
    api.use("/pay/*", async (c, next) => {
      const target = payable(db, c.req.path);
      if (!target) return c.json({ error: "unknown agreement" }, 404);
      const hasPayment = c.req.header("payment-signature") || c.req.header("x-payment");
      if (target.reason && !hasPayment) return c.json({ error: target.reason }, 409);
      await next();
    });
    api.use("/pay/*", usatPayments(env, db, celo, fx, contract, log));
    api.get("/pay/:id", (c) => c.json({ accepted: true, agreement: Number(c.req.param("id")) }));
  }

  // ---- public API for the web app (everything it shows is onchain or committed by hash) ----
  const pub = new Hono();
  const agreementView = (id: number) => {
    const a = db.prepare("SELECT * FROM agreements WHERE id = ?").get(id);
    if (!a) return undefined;
    return {
      agreement: a,
      draft: db
        .prepare("SELECT label, adjust_every_months, locale, document FROM drafts WHERE terms_hash = (SELECT terms_hash FROM agreements WHERE id = ?)")
        .get(id),
      payments: db.prepare("SELECT * FROM payments WHERE agreement_id = ? ORDER BY cycle").all(id),
      conversions: db.prepare("SELECT * FROM conversions WHERE agreement_id = ? ORDER BY cycle").all(id),
      notices: db.prepare("SELECT id, audience, kind, body, created_at FROM notices WHERE agreement_id = ? ORDER BY id DESC LIMIT 50").all(id),
      payable: contract ? !payable(db, `/pay/${id}`)?.reason : false,
    };
  };

  pub.get("/agreements/:id", (c) => {
    const view = agreementView(Number(c.req.param("id")));
    if (!view) throw new HTTPException(404, { message: "unknown agreement" });
    return c.json(view);
  });

  /** Re-read one agreement from the chain right away (after the user's own tx), instead of waiting for the next tick. */
  pub.post("/agreements/:id/refresh", async (c) => {
    if (!contract) throw new HTTPException(503, { message: "CONTRACT not configured" });
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id) || id < 1) throw new HTTPException(400, { message: "bad id" });
    const nextId = (await celo.reader.readContract({ address: contract, abi: cuotaAbi, functionName: "nextId" })) as bigint;
    if (BigInt(id) >= nextId) throw new HTTPException(404, { message: "unknown agreement" });
    await refresh(db, celo, contract, id);
    return c.json(agreementView(id));
  });

  pub.get("/wallets/:address/agreements", (c) => {
    const address = c.req.param("address").toLowerCase();
    if (!isAddress(address)) throw new HTTPException(400, { message: "not an address" });
    const rows = db
      .prepare(
        `SELECT a.*, d.label, d.locale FROM agreements a LEFT JOIN drafts d ON d.terms_hash = a.terms_hash
         WHERE a.payee = ? OR a.payer = ? ORDER BY a.id DESC`,
      )
      .all(address, address);
    return c.json(rows);
  });

  /** What the index did over the last N months: lets a landlord see what an adjustment would look like before choosing. */
  const previews = new Map<string, { at: number; body: unknown }>();
  pub.get("/indices/:index/preview", async (c) => {
    const key = c.req.param("index") as keyof typeof INDEX;
    if (!(key in INDEX)) throw new HTTPException(400, { message: "unknown index" });
    const months = Math.min(24, Math.max(1, Number(c.req.query("months") ?? 4)));
    const cacheKey = `${key}:${months}`;
    const hit = previews.get(cacheKey);
    if (hit && now() - hit.at < 3_600) return c.json(hit.body);
    const to = new Date();
    const from = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth() - months, to.getUTCDate()));
    try {
      const f = await factor(INDEX[key], from, to, 0);
      const body = { index: key, months, factor: f.factor, changePct: (f.factor - 1) * 100, reference: f.ref };
      previews.set(cacheKey, { at: now(), body });
      return c.json(body);
    } catch (err) {
      throw new HTTPException(502, { message: `index source unavailable: ${String(err).slice(0, 120)}` });
    }
  });

  // Building a proposal stores a small draft; cap it per client so it can't be used to fill the disk.
  const prepareHits = new Map<string, number[]>();
  pub.use("/agreements/prepare", async (c, next) => {
    const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
    const recent = (prepareHits.get(ip) ?? []).filter((t) => now() - t < 3_600);
    if (recent.length >= 30) return c.json({ error: "too many proposals from this address, try again later" }, 429);
    prepareHits.set(ip, [...recent, now()]);
    await next();
  });

  // ---- operator API ----
  const admin = new Hono();
  admin.use("*", async (c, next) => {
    if (c.req.header("authorization") !== `Bearer ${env.ADMIN_TOKEN}`) return c.json({ error: "unauthorized" }, 401);
    await next();
  });

  /**
   * Build a proposal. Returns the transaction the payee signs (`propose`) and stores the
   * off-chain plan under the terms hash, which is committed onchain inside the terms.
   */
  pub.post("/agreements/prepare", async (c) => {
    if (!contract) throw new HTTPException(503, { message: "CONTRACT not configured" });
    const b = PrepareBody.parse(await c.req.json());
    if (b.payee.toLowerCase() === b.payer.toLowerCase()) throw new HTTPException(400, { message: "payee and payer must differ" });
    const token = WFIAT[b.token];
    // Up to 6 decimal places, so very small agreements (tests, micro-subscriptions) keep their value.
    const amount = parseUnits(b.amount.toFixed(6), 18);
    const ceiling = parseUnits((b.ceiling ?? b.amount * 3).toFixed(6), 18);
    if (amount <= 0n) throw new HTTPException(400, { message: "amount must be at least 0.000001" });
    if (ceiling < amount) throw new HTTPException(400, { message: "ceiling below starting amount" });
    if (b.convertPct > 0 && !token.dollarizable) {
      throw new HTTPException(400, { message: `${b.token} has no USD₮ market on Textile yet; set convertPct to 0` });
    }
    const firstDueAt = Math.floor(Date.parse(`${b.firstDueDate}T12:00:00Z`) / 1000);
    if (firstDueAt <= now()) throw new HTTPException(400, { message: "first due date must be in the future" });

    const document = {
      label: b.label,
      payee: b.payee,
      payer: b.payer,
      currency: b.token,
      startingAmount: b.amount,
      ceilingPerPeriod: b.ceiling ?? b.amount * 3,
      periodDays: b.periodDays,
      firstDueDate: b.firstDueDate,
      adjustment: {
        index: INDEX_NAME[INDEX[b.index]],
        everyMonths: b.adjustEveryMonths,
        maxStepPct: b.maxStepPct,
        noticeDays: b.noticeDays,
        ...(b.index === "FIXED" ? { fixedStepPct: b.fixedStepPct } : {}),
      },
      payeeConvertsToUsdPct: b.convertPct,
    };
    const termsHash = keccak256(toBytes(JSON.stringify(document)));

    const terms = {
      payer: b.payer as Address,
      token: token.address,
      amount,
      ceiling,
      maxStepBps: Math.round(b.maxStepPct * 100),
      period: b.periodDays * 86_400,
      notice: b.noticeDays * 86_400,
      firstDueAt: BigInt(firstDueAt),
      convertBps: Math.round(b.convertPct * 100),
      index: INDEX[b.index],
      termsHash,
    };

    db.prepare(
      `INSERT OR REPLACE INTO drafts (terms_hash, label, adjust_every_months, fixed_step_bps, locale, payee_contact, payer_contact, document, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      termsHash.toLowerCase(),
      b.label,
      b.adjustEveryMonths,
      Math.round(b.fixedStepPct * 100),
      b.locale,
      b.payeeContact ?? null,
      b.payerContact ?? null,
      JSON.stringify(document),
      now(),
    );

    return c.json({
      termsHash,
      document,
      payeeSigns: { to: contract, data: encodeFunctionData({ abi: cuotaAbi, functionName: "propose", args: [terms] }) },
    });
  });

  /** After the proposal lands: what the payer signs. Approval covers a year at the ceiling; revocable any time. */
  pub.get("/agreements/:id/payer-calls", (c) => {
    if (!contract) throw new HTTPException(503, { message: "CONTRACT not configured" });
    const id = Number(c.req.param("id"));
    const a = db.prepare("SELECT token, ceiling, period FROM agreements WHERE id = ?").get(id) as
      | { token: Address; ceiling: string; period: number }
      | undefined;
    if (!a) throw new HTTPException(404, { message: "unknown agreement (not synced yet?)" });
    const periodsPerYear = BigInt(Math.ceil((365 * 86_400) / a.period));
    return c.json([
      { to: a.token, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [contract, BigInt(a.ceiling) * periodsPerYear] }) },
      { to: contract, data: encodeFunctionData({ abi: cuotaAbi, functionName: "accept", args: [BigInt(id)] }) },
    ]);
  });

  admin.get("/agreements", (c) => c.json(db.prepare("SELECT * FROM agreements ORDER BY id DESC").all()));
  admin.get("/notices", (c) =>
    c.json(
      c.req.query("undelivered")
        ? db.prepare("SELECT * FROM notices WHERE delivered_at IS NULL ORDER BY id").all()
        : db.prepare("SELECT * FROM notices ORDER BY id DESC LIMIT 200").all(),
    ),
  );
  admin.get("/paid-calls", (c) => {
    const calls = db.prepare("SELECT * FROM paid_calls ORDER BY id DESC").all() as { cap_usd: number }[];
    return c.json({ count: calls.length, capUsdTotal: calls.reduce((s, r) => s + r.cap_usd, 0), calls });
  });
  admin.post("/tick", async (c) => {
    await engine.tick();
    return c.json({ ok: true });
  });

  api.route("/v1", pub);
  api.route("/api", admin);
  return api;
}
