/**
 * One readable line from whatever was thrown: viem errors (`shortMessage`), plain
 * `{ code, message }` objects from wallets, nested `{ error: { message } }` bodies.
 */
export function readable(e: unknown, fallback = "Error"): string {
  if (typeof e === "string") return e.split("\n")[0]!.trim() || fallback;
  if (e && typeof e === "object") {
    const o = e as Record<string, unknown>;
    for (const k of ["shortMessage", "message", "reason", "details"]) {
      const v = o[k];
      if (typeof v === "string" && v.trim()) return v.split("\n")[0]!.trim();
    }
    if (o.error !== undefined) return readable(o.error, fallback);
  }
  return fallback;
}

/** The person said no in their wallet (EIP-1193 code 4001, or the usual wording). */
export function declined(e: unknown): boolean {
  const o = e as { code?: unknown; cause?: { code?: unknown } } | null;
  return o?.code === 4001 || o?.cause?.code === 4001 || /reject|denied|declined|cancel/i.test(readable(e, ""));
}
