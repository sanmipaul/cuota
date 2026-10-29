// Client for the Cuota agent's public API (/v1), reached through the /agent rewrite.
import { readable } from "./errors";

export interface AgreementRow {
  id: number;
  payee: string;
  payer: string;
  token: string;
  amount: string;
  ceiling: string;
  max_step_bps: number;
  period: number;
  notice: number;
  first_due_at: number;
  next_due_at: number;
  cycle: number;
  convert_bps: number;
  index_id: number;
  terms_hash: string;
  status: "proposed" | "active" | "cancelled";
  pending_amount: string;
  pending_from: number;
  label?: string | null;
  locale?: string | null;
}

export interface AgreementView {
  agreement: AgreementRow;
  draft?: { label: string; adjust_every_months: number; locale: string; document: string };
  payments: { cycle: number; kind: "collect" | "x402"; amount: string; asset: string; tx: string; at: number }[];
  conversions: { cycle: number; token: string; sell_amount: string; usdt_amount: string | null; swap_tx: string | null; settle_tx: string | null; state: "queued" | "settled" | "returned" }[];
  notices: { id: number; audience: "payer" | "payee"; kind: string; body: string; created_at: number }[];
  payable: boolean;
}

export interface Prepared {
  termsHash: `0x${string}`;
  document: Record<string, unknown>;
  payeeSigns: { to: `0x${string}`; data: `0x${string}` };
}

export interface IndexPreview {
  index: string;
  months: number;
  factor: number;
  changePct: number;
  reference: string;
}

export class AgentError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export async function agent<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/agent${path}`, {
    ...init,
    headers: { accept: "application/json", ...(init?.body ? { "content-type": "application/json" } : {}), ...init?.headers },
  });
  const body = (await res.json().catch(() => ({}))) as { error?: unknown };
  // The host's own 404 means /agent isn't wired to a running agent (CUOTA_AGENT_URL).
  if (res.status === 404 && (body.error as { code?: string } | undefined)?.code === "NOT_FOUND") {
    throw new AgentError("Cuota's agent isn't connected to this site yet (CUOTA_AGENT_URL).", 404);
  }
  if (!res.ok) throw new AgentError(body.error !== undefined ? readable(body.error) : res.status >= 500 ? "Cuota's agent isn't reachable right now" : `HTTP ${res.status}`, res.status);
  return body as T;
}

export const INDEX_KEYS = ["ICL", "IPC_AR", "IPCA", "IGPM", "FIXED"] as const;
export type IndexKey = (typeof INDEX_KEYS)[number];
export const INDEX_BY_ID: Record<number, IndexKey> = { 1: "ICL", 2: "IPC_AR", 3: "IPCA", 4: "IGPM", 5: "FIXED" };
