"use client";

import { useQuery } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { decodeEventLog, isAddress } from "viem";
import { useConnection } from "wagmi";
import { fill } from "@/i18n/dictionaries";
import { useI18n } from "@/i18n/context";
import { agent, INDEX_KEYS, type IndexKey, type IndexPreview, type Prepared } from "@/lib/agent";
import { declined, readable } from "@/lib/errors";
import { pct, plainMoney } from "@/lib/format";
import { Btn, BtnLink, Choice, CopyField, Label, Note, TextInput } from "@/ui/kit";
import { Wallet } from "@/ui/Wallet";
import { CURRENCIES, cuotaAbi, type Currency } from "@/web3/config";
import { useGasReady, useHydrated } from "@/web3/hooks";
import { useTaggedTx } from "@/web3/useTaggedTx";

type Locale = "es-AR" | "pt-BR" | "es-CO" | "es-MX";

interface Form {
  label: string;
  payer: string;
  currency: Currency;
  amount: string;
  firstDue: string;
  periodDays: 30 | 7 | 90;
  index: IndexKey;
  every: number;
  fixedStepPct: number;
  maxStepPct: number;
  ceilingMult: number;
  noticeDays: number;
  convertPct: number;
  locale: Locale;
  payeeContact: string;
  payerContact: string;
}

const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

export function Wizard() {
  const { t, lang, locale } = useI18n();
  const w = t.wizard;
  const hydrated = useHydrated();
  const { address, isConnected } = useConnection();
  const gasReady = useGasReady();
  const tx = useTaggedTx();
  const [step, setStep] = useState(0);
  const [created, setCreated] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [f, setF] = useState<Form>({
    label: "",
    payer: "",
    currency: lang === "pt" ? "wBRL" : "wARS",
    amount: "",
    firstDue: "", // filled on the client: the default depends on today
    periodDays: 30,
    index: lang === "pt" ? "IGPM" : "ICL",
    every: lang === "pt" ? 12 : 4,
    fixedStepPct: 3,
    maxStepPct: 25,
    ceilingMult: 3,
    noticeDays: 10,
    convertPct: 0,
    locale: lang === "pt" ? "pt-BR" : "es-AR",
    payeeContact: "",
    payerContact: "",
  });
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((p) => ({ ...p, [k]: v }));
  const amount = Number(f.amount) || 0;
  const cur = CURRENCIES[f.currency];

  const preview = useQuery({
    queryKey: ["preview", f.index, f.every],
    queryFn: () => agent<IndexPreview>(`/v1/indices/${f.index}/preview?months=${f.every}`),
    enabled: f.index !== "FIXED" && step === 1,
    staleTime: 3_600_000,
  });

  if (!hydrated) return null;

  const firstDue = f.firstDue || inDays(7);
  const payerOk = isAddress(f.payer) && f.payer.toLowerCase() !== address?.toLowerCase();
  const stepValid = [f.label.trim().length > 0 && payerOk && amount > 0 && firstDue >= inDays(1), f.every >= 1, true, true][step];

  if (created !== null) {
    const link = `${window.location.origin}/${lang}/c/${created}`;
    return (
      <div className="fade-up pt-8 text-center">
        <p className="text-sm font-semibold text-olive">#{created}</p>
        <h1 className="display mt-2 text-5xl font-medium">{w.createdTitle}</h1>
        <p className="mx-auto mt-3 max-w-md text-muted">{w.createdBody}</p>
        <div className="mx-auto mt-8 max-w-lg">
          <CopyField value={link} />
        </div>
        <div className="mt-6 flex flex-wrap justify-center gap-3">
          <BtnLink href={`/${lang}/c/${created}`}>{w.open}</BtnLink>
          <Btn tone="outline" onClick={() => (setCreated(null), setStep(0), tx.reset())}>
            {w.another}
          </Btn>
        </div>
      </div>
    );
  }

  if (!isConnected) {
    return (
      <div className="fade-up pt-8">
        <h1 className="display text-5xl font-medium">{w.title}</h1>
        <p className="mt-4 max-w-lg text-lg text-muted">{w.connectFirst}</p>
        <div className="mt-6">
          <Wallet size="lg" />
        </div>
      </div>
    );
  }

  async function sign() {
    setError(null);
    setPreparing(true);
    try {
      const prepared = await agent<Prepared>("/v1/agreements/prepare", {
        method: "POST",
        body: JSON.stringify({
          payee: address,
          payer: f.payer,
          token: f.currency,
          amount,
          ceiling: amount * f.ceilingMult,
          maxStepPct: f.maxStepPct,
          periodDays: f.periodDays,
          noticeDays: f.noticeDays,
          firstDueDate: firstDue,
          convertPct: cur.dollarizable ? f.convertPct : 0,
          index: f.index,
          adjustEveryMonths: f.every,
          fixedStepPct: f.index === "FIXED" ? f.fixedStepPct : 0,
          label: f.label.trim(),
          locale: f.locale,
          payeeContact: f.payeeContact.trim() || undefined,
          payerContact: f.payerContact.trim() || undefined,
        }),
      });
      setPreparing(false);
      const receipt = await tx.send(prepared.payeeSigns);
      const proposed = receipt.logs
        .filter((l) => l.address.toLowerCase() === prepared.payeeSigns.to.toLowerCase())
        .map((l) => {
          try {
            return decodeEventLog({ abi: cuotaAbi, data: l.data, topics: l.topics });
          } catch {
            return undefined;
          }
        })
        .find((e) => e?.eventName === "Proposed");
      if (!proposed || proposed.eventName !== "Proposed") throw new Error("no Proposed event in receipt");
      const id = Number(proposed.args.id);
      await agent(`/v1/agreements/${id}/refresh`, { method: "POST" }).catch(() => undefined);
      setCreated(id);
    } catch (e) {
      setPreparing(false);
      console.error("create agreement failed", e);
      setError(declined(e) ? t.common.declined : readable(e, t.common.error));
    }
  }

  const projected = (factor: number) => plainMoney(Math.min(amount * factor, amount * (1 + f.maxStepPct / 100), amount * f.ceilingMult), f.currency, locale);
  const monthsLabel = f.every === 1 ? w.month1 : fill(w.months, { n: f.every });

  return (
    <div className="fade-up">
      <h1 className="display text-5xl font-medium">{w.title}</h1>
      <ol className="mt-6 flex gap-2 overflow-x-auto pb-1">
        {w.steps.map((s, i) => (
          <li
            key={s}
            className={`flex items-center gap-2 whitespace-nowrap rounded-full px-3.5 py-1.5 text-sm font-semibold ${i === step ? "bg-fg text-bg" : i < step ? "bg-olive-soft text-olive" : "bg-card text-faint"}`}
          >
            <span className="num">{i + 1}</span> {s}
          </li>
        ))}
      </ol>

      <div className="card mt-6 p-5 sm:p-7">
        {step === 0 && (
          <div className="grid gap-5 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <Label text={w.label}>
                <TextInput value={f.label} onChange={(e) => set("label", e.target.value)} maxLength={80} />
              </Label>
            </div>
            <div className="sm:col-span-2">
              <Label text={w.payer} hint={w.payerHint}>
                <TextInput value={f.payer} onChange={(e) => set("payer", e.target.value.trim())} className="num" spellCheck={false} />
              </Label>
            </div>
            <Label text={w.currency}>
              <Choice value={f.currency} onChange={(e) => set("currency", e.target.value as Currency)}>
                {(Object.keys(CURRENCIES) as Currency[]).map((c) => (
                  <option key={c} value={c}>
                    {c} · {CURRENCIES[c].iso}
                  </option>
                ))}
              </Choice>
            </Label>
            <Label text={w.amount}>
              <TextInput inputMode="decimal" value={f.amount} onChange={(e) => set("amount", e.target.value.replace(/[^0-9.]/g, ""))} className="num" />
            </Label>
            <Label text={w.firstDue}>
              <TextInput type="date" value={firstDue} min={inDays(1)} onChange={(e) => set("firstDue", e.target.value)} />
            </Label>
            <Label text={w.period}>
              <Choice value={f.periodDays} onChange={(e) => set("periodDays", Number(e.target.value) as Form["periodDays"])}>
                {(["30", "7", "90"] as const).map((p) => (
                  <option key={p} value={p}>
                    {w.periods[p]}
                  </option>
                ))}
              </Choice>
            </Label>
          </div>
        )}

        {step === 1 && (
          <div className="space-y-7">
            <fieldset>
              <legend className="mb-3 text-sm font-semibold">{w.indexTitle}</legend>
              <div className="grid gap-2.5 sm:grid-cols-2">
                {INDEX_KEYS.map((k) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => set("index", k)}
                    aria-pressed={f.index === k}
                    className={`rounded-2xl border p-4 text-left transition-colors ${f.index === k ? "border-brick bg-brick-soft/60" : "border-line bg-card hover:border-line-strong"}`}
                  >
                    <span className="display text-xl font-semibold">{w.indices[k].name}</span>
                    <span className="mt-1 block text-[13px] leading-snug text-muted">{w.indices[k].body}</span>
                  </button>
                ))}
              </div>
            </fieldset>

            <div className="grid gap-5 sm:grid-cols-2">
              <Label text={w.every}>
                <Choice value={f.every} onChange={(e) => set("every", Number(e.target.value))}>
                  {[1, 3, 4, 6, 12].map((n) => (
                    <option key={n} value={n}>
                      {n === 1 ? w.month1 : fill(w.months, { n })}
                    </option>
                  ))}
                </Choice>
              </Label>
              {f.index === "FIXED" && (
                <Label text={w.fixedStep}>
                  <TextInput type="number" min={0} max={100} step={0.5} value={f.fixedStepPct} onChange={(e) => set("fixedStepPct", Number(e.target.value))} className="num" />
                </Label>
              )}
            </div>

            <div className="rounded-2xl bg-bg px-4 py-3.5 text-[15px] leading-relaxed">
              {f.index === "FIXED" ? (
                fill(w.preview, { months: monthsLabel, index: w.indices.FIXED.name, pct: pct(f.fixedStepPct, locale), from: plainMoney(amount, f.currency, locale), to: projected(1 + f.fixedStepPct / 100) })
              ) : preview.isPending ? (
                <span className="text-muted">{w.previewLoading}</span>
              ) : preview.isError ? (
                <span className="text-muted">{w.previewError}</span>
              ) : (
                <>
                  {fill(w.preview, {
                    months: monthsLabel,
                    index: w.indices[f.index].name,
                    pct: pct(preview.data.changePct, locale),
                    from: plainMoney(amount, f.currency, locale),
                    to: projected(preview.data.factor),
                  })}
                  <span className="mt-1 block text-[12px] text-faint">{preview.data.reference}</span>
                </>
              )}
            </div>

            <details className="rounded-2xl border border-line px-4 py-3" open>
              <summary className="cursor-pointer select-none text-sm font-semibold">{w.limits}</summary>
              <div className="mt-4 grid gap-5 sm:grid-cols-3">
                <Label text={w.maxStep}>
                  <Choice value={f.maxStepPct} onChange={(e) => set("maxStepPct", Number(e.target.value))}>
                    {[10, 15, 20, 25, 35, 50].map((n) => (
                      <option key={n} value={n}>
                        +{n}%
                      </option>
                    ))}
                  </Choice>
                </Label>
                <Label text={w.ceiling}>
                  <Choice value={f.ceilingMult} onChange={(e) => set("ceilingMult", Number(e.target.value))}>
                    {[1.5, 2, 3, 5].map((m) => (
                      <option key={m} value={m}>
                        {plainMoney(amount * m, f.currency, locale)}
                      </option>
                    ))}
                  </Choice>
                </Label>
                <Label text={w.notice}>
                  <Choice value={f.noticeDays} onChange={(e) => set("noticeDays", Number(e.target.value))}>
                    {[7, 10, 15, 30].map((n) => (
                      <option key={n} value={n}>
                        {fill(w.days, { n })}
                      </option>
                    ))}
                  </Choice>
                </Label>
              </div>
            </details>
          </div>
        )}

        {step === 2 && (
          <div className="space-y-7">
            <div>
              <h2 className="text-lg font-bold">{w.convertTitle}</h2>
              <p className="mt-1.5 text-[15px] leading-relaxed text-muted">{w.convertBody}</p>
              {cur.dollarizable ? (
                <div className="mt-5">
                  <input
                    type="range"
                    min={0}
                    max={100}
                    step={10}
                    value={f.convertPct}
                    onChange={(e) => set("convertPct", Number(e.target.value))}
                    className="w-full accent-[var(--brick)]"
                    aria-label={w.convertTitle}
                  />
                  <p className="num mt-2 font-semibold">
                    {f.convertPct === 0 ? fill(w.convertNone, { cur: f.currency }) : fill(w.convertSome, { pct: `${f.convertPct}%`, cur: f.currency })}
                  </p>
                </div>
              ) : (
                <div className="mt-4">
                  <Note tone="sun">{fill(w.convertUnavailable, { cur: f.currency })}</Note>
                </div>
              )}
            </div>
            <div className="grid gap-5 sm:grid-cols-2">
              <Label text={w.noticeLang}>
                <Choice value={f.locale} onChange={(e) => set("locale", e.target.value as Locale)}>
                  <option value="es-AR">Español (Argentina)</option>
                  <option value="pt-BR">Português (Brasil)</option>
                  <option value="es-CO">Español (Colombia)</option>
                  <option value="es-MX">Español (México)</option>
                </Choice>
              </Label>
              <div />
              <Label text={w.contactPayee} hint={w.contactHint}>
                <TextInput value={f.payeeContact} onChange={(e) => set("payeeContact", e.target.value)} maxLength={120} />
              </Label>
              <Label text={w.contactPayer}>
                <TextInput value={f.payerContact} onChange={(e) => set("payerContact", e.target.value)} maxLength={120} />
              </Label>
            </div>
          </div>
        )}

        {step === 3 && (
          <div>
            <h2 className="display text-3xl font-medium">{w.reviewTitle}</h2>
            <p className="mt-2 text-[15px] text-muted">{w.reviewLead}</p>
            <dl className="mt-6 grid gap-x-6 gap-y-4 text-[15px] sm:grid-cols-2">
              <Row k={w.label} v={f.label} />
              <Row k={w.payer} v={<span className="num break-all">{f.payer}</span>} />
              <Row k={w.amount} v={<span className="num">{plainMoney(amount, f.currency, locale)}</span>} />
              <Row k={w.firstDue} v={new Date(`${firstDue}T12:00:00Z`).toLocaleDateString(locale, { dateStyle: "long", timeZone: "UTC" })} />
              <Row k={w.period} v={w.periods[String(f.periodDays) as "30"]} />
              <Row k={w.indexTitle} v={`${w.indices[f.index].name} · ${monthsLabel}${f.index === "FIXED" ? ` · +${f.fixedStepPct}%` : ""}`} />
              <Row k={w.maxStep} v={`+${f.maxStepPct}%`} />
              <Row k={w.ceiling} v={<span className="num">{plainMoney(amount * f.ceilingMult, f.currency, locale)}</span>} />
              <Row k={w.notice} v={fill(w.days, { n: f.noticeDays })} />
              <Row k={w.convertTitle} v={cur.dollarizable && f.convertPct ? `${f.convertPct}% → USD₮` : "—"} />
            </dl>
            {!gasReady && (
              <div className="mt-6">
                <Note tone="sun">{t.agreement.gasWarn}</Note>
              </div>
            )}
            {(error || tx.error) && (
              <div className="mt-6">
                <Note tone="danger">{error ?? (tx.error === "declined" ? t.common.declined : tx.error)}</Note>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="mt-6 flex items-center justify-between gap-3">
        <Btn tone="ghost" onClick={() => setStep((s) => Math.max(0, s - 1))} disabled={step === 0 || tx.phase === "signing" || tx.phase === "confirming"}>
          ← {w.back}
        </Btn>
        {step < 3 ? (
          <Btn onClick={() => setStep((s) => s + 1)} disabled={!stepValid}>
            {w.next} →
          </Btn>
        ) : (
          <Btn size="lg" onClick={sign} busy={preparing || tx.phase === "signing" || tx.phase === "confirming"}>
            {tx.phase === "signing" ? w.signing : tx.phase === "confirming" ? w.confirming : w.sign}
          </Btn>
        )}
      </div>
    </div>
  );
}

function Row({ k, v }: { k: string; v: ReactNode }) {
  return (
    <div className="border-b border-line pb-3">
      <dt className="text-[13px] text-muted">{k}</dt>
      <dd className="mt-0.5 font-semibold">{v}</dd>
    </div>
  );
}
