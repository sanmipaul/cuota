"use client";

import { ExactEvmScheme } from "@x402/evm";
import { wrapFetchWithPaymentFromConfig } from "@x402/fetch";
import { useState } from "react";
import { useConnection, useWalletClient } from "wagmi";
import { fill } from "@/i18n/dictionaries";
import { useI18n } from "@/i18n/context";
import { declined, readable } from "@/lib/errors";
import { dollars } from "@/lib/format";
import { Btn, Note } from "@/ui/kit";
import { Wallet } from "@/ui/Wallet";
import type { Currency } from "@/web3/config";

/**
 * A payer without pesos settles the upcoming period in USA₮ over x402. We read the 402
 * first so the person sees the exact amount, then let the x402 client sign and retry.
 * The agent holds the quote for ten minutes, so the price can't move in between.
 */
export function PayInUsat({ id, currency, onPaid }: { id: number; currency: Currency; onPaid: () => Promise<void> }) {
  const { t, locale } = useI18n();
  const a = t.agreement;
  const { address, isConnected } = useConnection();
  const { data: wallet } = useWalletClient();
  const [quote, setQuote] = useState<string | null>(null);
  const [state, setState] = useState<"idle" | "quoting" | "paying" | "paid">("idle");
  const [error, setError] = useState<string | null>(null);

  async function getQuote() {
    setError(null);
    setState("quoting");
    try {
      const res = await fetch(`/agent/pay/${id}`, { headers: { accept: "application/json" } });
      const header = res.headers.get("PAYMENT-REQUIRED");
      if (res.status !== 402 || !header) throw new Error(readable(await res.json().catch(() => ({})), `HTTP ${res.status}`));
      const required = JSON.parse(atob(header)) as { accepts: { amount: string }[] };
      setQuote(dollars(required.accepts[0]!.amount, locale));
      setState("idle");
    } catch (e) {
      setState("idle");
      setError(readable(e, t.common.error));
    }
  }

  async function pay() {
    if (!wallet || !address) return;
    setError(null);
    setState("paying");
    try {
      const signer = {
        address,
        signTypedData: (msg: { domain: Record<string, unknown>; types: Record<string, unknown>; primaryType: string; message: Record<string, unknown> }) =>
          wallet.signTypedData({ account: address, ...(msg as unknown as Parameters<typeof wallet.signTypedData>[0]) }),
      };
      const paidFetch = wrapFetchWithPaymentFromConfig(fetch, { schemes: [{ network: "eip155:42220", client: new ExactEvmScheme(signer) }] });
      const res = await paidFetch(`/agent/pay/${id}`, { headers: { accept: "application/json" } });
      if (!res.ok) throw new Error(readable(await res.json().catch(() => ({})), `HTTP ${res.status}`));
      setState("paid");
      await onPaid();
    } catch (e) {
      setState("idle");
      console.error("USA₮ payment failed", e);
      setError(declined(e) ? t.common.declined : readable(e, t.common.error));
    }
  }

  return (
    <section className="card p-6">
      <h2 className="text-lg font-bold">{a.payUsatTitle}</h2>
      <p className="mt-1.5 text-[15px] leading-relaxed text-muted">{fill(a.payUsatBody, { cur: currency })}</p>
      {state === "paid" ? (
        <div className="mt-4">
          <Note tone="olive">{a.paidOk}</Note>
        </div>
      ) : (
        <>
          {quote && <p className="num mt-4 text-lg font-semibold">{fill(a.quote, { amount: quote })}</p>}
          {error && (
            <div className="mt-4">
              <Note tone="danger">{error}</Note>
            </div>
          )}
          <div className="mt-4 flex flex-wrap gap-3">
            {!quote ? (
              <Btn tone="outline" busy={state === "quoting"} onClick={getQuote}>
                {a.getQuote}
              </Btn>
            ) : !isConnected ? (
              <Wallet size="md" />
            ) : (
              <Btn busy={state === "paying"} onClick={pay} disabled={!wallet}>
                {fill(a.pay, { amount: quote })}
              </Btn>
            )}
          </div>
        </>
      )}
    </section>
  );
}
