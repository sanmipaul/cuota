import { now, type Db, type DraftRow } from "./db.ts";
import { OverBudget, type Paid } from "./paid.ts";

/**
 * Plain-language notices in the parties' language, written by Cencori through buy.
 * The facts are computed by the agent and passed in; the model only phrases them, and
 * every notice falls back to a fixed template when the model is unavailable.
 */

const CENCORI = "https://gateway.usebuy.ai/cencori/v1/chat/completions";
const LANGUAGE: Record<DraftRow["locale"], string> = {
  "es-AR": "Spanish as spoken in Argentina (voseo, warm but precise)",
  "es-CO": "Spanish as spoken in Colombia",
  "es-MX": "Spanish as spoken in Mexico",
  "pt-BR": "Brazilian Portuguese",
};

export type NoticeKind = "adjustment" | "due_soon" | "failed" | "receipt";

export interface NoticeFacts {
  kind: NoticeKind;
  audience: "payer" | "payee";
  locale: DraftRow["locale"];
  label: string;
  facts: Record<string, string | number>;
}

export class Notices {
  constructor(
    private readonly db: Db,
    private readonly paid: Paid,
    private readonly webhook?: string,
  ) {}

  /** Write (once per dedupe key) and deliver a notice. */
  async send(agreementId: number, dedupe: string, n: NoticeFacts) {
    const exists = this.db.prepare("SELECT 1 FROM notices WHERE dedupe = ?").get(dedupe);
    if (exists) return;
    const body = await this.phrase(n);
    const info = this.db
      .prepare("INSERT INTO notices (agreement_id, audience, kind, dedupe, body, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(agreementId, n.audience, n.kind, dedupe, body, now());
    await this.deliver(Number(info.lastInsertRowid), agreementId, n, body);
  }

  private async phrase(n: NoticeFacts): Promise<string> {
    try {
      const res = await this.paid.post<{ choices?: { message?: { content?: string } }[] }>(
        "cencori/inference",
        CENCORI,
        {
          model: "maximo-atlas-1.3",
          max_tokens: 256,
          temperature: 0.3,
          messages: [
            {
              role: "system",
              content:
                `Write a short message (max 70 words) in ${LANGUAGE[n.locale]} to the ${n.audience === "payer" ? "person who pays" : "person who gets paid"} ` +
                `about their recurring payment "${n.label}". Use every fact given, exactly as given, and nothing else. ` +
                "No greeting placeholders, no sign-off, no markdown.",
            },
            { role: "user", content: JSON.stringify({ type: n.kind, ...n.facts }) },
          ],
        },
        0.01,
        `${n.kind} notice`,
      );
      const text = res.body?.choices?.[0]?.message?.content?.trim();
      if (text) return text;
    } catch (err) {
      if (!(err instanceof OverBudget)) console.warn(`notice phrasing failed: ${String(err)}`);
    }
    return template(n);
  }

  private async deliver(noticeId: number, agreementId: number, n: NoticeFacts, body: string) {
    if (!this.webhook) return;
    try {
      const res = await fetch(this.webhook, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ noticeId, agreementId, audience: n.audience, kind: n.kind, locale: n.locale, body }),
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) this.db.prepare("UPDATE notices SET delivered_at = ? WHERE id = ?").run(now(), noticeId);
    } catch {
      // left undelivered; the API lists it and the next delivery pass can retry
    }
  }
}

const FACT_LABELS: Record<"es" | "pt", Record<string, string>> = {
  es: {
    period: "Período",
    collected: "Cobrado",
    sent_to_you_now: "Te llegó",
    converting_to_usdt: "Pasando a USD₮",
    amount: "Monto",
    due_date: "Vence",
    keep_in_wallet: "Tené en tu billetera",
    reason: "Motivo",
    next_try: "Próximo intento",
    index: "Índice",
    reference: "Valores",
    change: "Variación",
    previous: "Antes",
    new_amount: "Nuevo monto",
    applies_from: "Desde",
    note: "Nota",
    tx: "Transacción",
  },
  pt: {
    period: "Período",
    collected: "Cobrado",
    sent_to_you_now: "Você recebeu",
    converting_to_usdt: "Convertendo em USD₮",
    amount: "Valor",
    due_date: "Vencimento",
    keep_in_wallet: "Mantenha na carteira",
    reason: "Motivo",
    next_try: "Próxima tentativa",
    index: "Índice",
    reference: "Valores",
    change: "Variação",
    previous: "Antes",
    new_amount: "Novo valor",
    applies_from: "A partir de",
    note: "Nota",
    tx: "Transação",
  },
};

export function template(n: NoticeFacts): string {
  const labels = FACT_LABELS[n.locale === "pt-BR" ? "pt" : "es"];
  const f = Object.entries(n.facts)
    .map(([k, v]) => {
      const value = typeof v === "string" && /^0x[0-9a-fA-F]{64}$/.test(v) ? `${v.slice(0, 10)}…${v.slice(-6)}` : v;
      return `${labels[k] ?? k}: ${value}`;
    })
    .join(" · ");
  const pt = n.locale === "pt-BR";
  const head: Record<NoticeKind, string> = pt
    ? { adjustment: "Reajuste", due_soon: "Vencimento próximo", failed: "Cobrança não realizada", receipt: "Pagamento recebido" }
    : { adjustment: "Actualización", due_soon: "Próximo vencimiento", failed: "No pudimos cobrar", receipt: "Pago recibido" };
  return `${head[n.kind]} — ${n.label}. ${f}`;
}
