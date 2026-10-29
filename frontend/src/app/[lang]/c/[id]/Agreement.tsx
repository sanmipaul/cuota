"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "next/navigation";
import { decodeFunctionData, encodeFunctionData, erc20Abi, type Address, type Hex } from "viem";
import { useConnection, useReadContract } from "wagmi";
import { fill } from "@/i18n/dictionaries";
import { useI18n } from "@/i18n/context";
import { agent, AgentError, INDEX_BY_ID, type AgreementView } from "@/lib/agent";
import { day, dollars, moneyFor, short } from "@/lib/format";
import { Badge, Btn, CopyField, Note, Skeleton } from "@/ui/kit";
import { Wallet } from "@/ui/Wallet";
import { currencyByAddress, cuotaAbi, explorerTx } from "@/web3/config";
import { useGasReady, useHydrated } from "@/web3/hooks";
import { useTaggedTx } from "@/web3/useTaggedTx";
import { PayInUsat } from "./PayInUsat";

export function Agreement() {
  const { id } = useParams<{ id: string }>();
  const { t, lang, locale } = useI18n();
  const a = t.agreement;
  const hydrated = useHydrated();
  const { address } = useConnection();
  const qc = useQueryClient();

  const view = useQuery({
    queryKey: ["agreement", id],
    queryFn: () => agent<AgreementView>(`/v1/agreements/${id}`),
    refetchInterval: 15_000,
    retry: (n, e) => !(e instanceof AgentError && e.status === 404) && n < 2,
  });
  // A freshly proposed agreement may not be mirrored yet; ask the agent to read it from the chain.
  const synced = useQuery({
    queryKey: ["agreement-refresh", id],
    queryFn: () => agent<AgreementView>(`/v1/agreements/${id}/refresh`, { method: "POST" }),
    enabled: view.isError && view.error instanceof AgentError && view.error.status === 404,
    retry: false,
  });

  const data = view.data ?? synced.data;
  const refresh = async () => {
    const fresh = await agent<AgreementView>(`/v1/agreements/${id}/refresh`, { method: "POST" });
    qc.setQueryData(["agreement", id], fresh);
  };

  if (!data) {
    if (view.isPending || synced.isFetching) return <Skeleton className="h-[560px]" />;
    return (
      <div className="pt-12 text-center">
        <h1 className="display text-4xl font-medium">{a.notFound}</h1>
      </div>
    );
  }

  const ag = data.agreement;
  const cur = currencyByAddress(ag.token);
  const m = (v: string | bigint) => moneyFor(v, ag.token, locale);
  const me = hydrated ? address?.toLowerCase() : undefined;
  const role = me === ag.payee ? "payee" : me === ag.payer ? "payer" : "viewer";
  const indexKey = INDEX_BY_ID[ag.index_id] ?? "FIXED";
  const every = data.draft?.adjust_every_months;
  const pendingApplies = ag.pending_amount !== "0" && ag.next_due_at >= ag.pending_from;
  const dueNext = pendingApplies ? ag.pending_amount : ag.amount;
  const doc = data.draft ? (JSON.parse(data.draft.document) as { adjustment?: { fixedStepPct?: number } }) : undefined;

  return (
    <div className="fade-up">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="num text-sm text-faint">#{ag.id}</p>
          <h1 className="display text-4xl font-medium sm:text-5xl">{data.draft?.label ?? `#${ag.id}`}</h1>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Badge kind={ag.status}>{a.statuses[ag.status]}</Badge>
            {hydrated && <Badge kind="neutral">{role === "payee" ? a.youCollect : role === "payer" ? a.youPay : a.viewer}</Badge>}
          </div>
        </div>
        {hydrated && !address && <Wallet size="md" />}
      </div>

      {pendingApplies && ag.status === "active" && (
        <div className="mt-6">
          <Note tone="sun">{fill(a.pending, { date: day(ag.pending_from, locale), amount: m(ag.pending_amount) })}</Note>
        </div>
      )}

      <div className="mt-8 grid gap-6 lg:grid-cols-[1.15fr_1fr]">
        <div className="min-w-0 space-y-6">
          {role === "payee" && ag.status === "proposed" && (
            <section className="card p-6">
              <h2 className="text-lg font-bold">{a.shareTitle}</h2>
              <div className="mt-3">
                <CopyField value={`${window.location.origin}/${lang}/c/${ag.id}`} />
              </div>
            </section>
          )}

          {role === "payer" && ag.status === "proposed" && <AcceptCard id={ag.id} onDone={refresh} />}

          <section className="card p-6">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-faint">{a.terms}</h2>
            <div className="mt-4 grid grid-cols-2 gap-5">
              <Stat label={a.amountNow} value={m(ag.amount)} big />
              <Stat label={a.nextDue} value={ag.status === "cancelled" ? "—" : day(ag.next_due_at, locale)} big />
            </div>
            <ul className="mt-6 flex flex-wrap gap-2 text-[13px]">
              <Chip>{`${a.index}: ${t.wizard.indices[indexKey].name}${indexKey === "FIXED" && doc?.adjustment?.fixedStepPct ? ` +${doc.adjustment.fixedStepPct}%` : ""}`}</Chip>
              {every && <Chip>{fill(a.every, { n: every })}</Chip>}
              <Chip>{fill(a.maxStep, { pct: `+${ag.max_step_bps / 100}%` })}</Chip>
              <Chip>{fill(a.ceiling, { amount: m(ag.ceiling) })}</Chip>
              <Chip>{fill(a.notice, { n: Math.round(ag.notice / 86_400) })}</Chip>
              {ag.convert_bps > 0 && <Chip>{fill(a.convert, { pct: `${ag.convert_bps / 100}%` })}</Chip>}
            </ul>
            <p className="num mt-5 text-[12px] text-faint">
              {short(ag.payee)} → {short(ag.payer)} · terms {short(ag.terms_hash)}
            </p>
          </section>

          {ag.status === "active" && data.payable && cur && <PayInUsat id={ag.id} currency={cur} onPaid={refresh} />}

          {(role === "payee" || role === "payer") && ag.status !== "cancelled" && <CancelButton id={ag.id} onDone={refresh} />}
        </div>

        <div className="min-w-0 space-y-6">
          <section>
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-faint">{a.timeline}</h2>
            <ol className="space-y-3">
              {ag.status === "active" && (
                <li className="receipt border-brick/40 p-4 pt-5">
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-semibold">{fill(a.period, { n: ag.cycle })}</span>
                    <Badge kind="upcoming">{a.upcoming}</Badge>
                  </div>
                  <div className="num mt-2 flex items-baseline justify-between text-sm text-muted">
                    <span>{day(ag.next_due_at, locale)}</span>
                    <span className="display text-xl font-semibold text-fg">{m(dueNext)}</span>
                  </div>
                </li>
              )}
              {[...data.payments].reverse().map((p) => {
                const conv = data.conversions.find((c) => c.cycle === p.cycle);
                return (
                  <li key={p.cycle} className="receipt p-4 pt-5">
                    <div className="flex items-center justify-between gap-3">
                      <span className="font-semibold">{fill(a.period, { n: p.cycle })}</span>
                      <Badge kind="paid">{p.kind === "x402" ? a.paidX402 : a.paidCollect}</Badge>
                    </div>
                    <div className="num mt-2 flex items-baseline justify-between text-sm text-muted">
                      <a href={explorerTx(p.tx)} target="_blank" rel="noreferrer" className="hover:text-brick">
                        {day(p.at, locale)} ↗
                      </a>
                      <span className="text-base font-semibold text-fg">{p.kind === "x402" ? `${dollars(p.amount, locale)} USA₮` : m(p.amount)}</span>
                    </div>
                    {conv && role !== "payer" && (
                      <p className="mt-2 text-[13px] text-muted">
                        {conv.state === "settled" && conv.usdt_amount
                          ? fill(a.converted, { amount: `${dollars(conv.usdt_amount, locale)} USD₮` })
                          : conv.state === "returned"
                            ? fill(a.returned, { cur: cur ?? "" })
                            : a.converting}
                      </p>
                    )}
                  </li>
                );
              })}
            </ol>
          </section>

          <section>
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-faint">{a.notices}</h2>
            {data.notices.filter((n) => role === "viewer" || n.audience === role).length === 0 ? (
              <p className="text-sm text-muted">{a.noNotices}</p>
            ) : (
              <ul className="space-y-2.5">
                {data.notices
                  .filter((n) => role === "viewer" || n.audience === role)
                  .map((n) => (
                    <li key={n.id} className="card px-4 py-3.5 text-[15px] leading-relaxed [overflow-wrap:anywhere]">
                      <p className="num mb-1 text-[12px] text-faint">{day(n.created_at, locale)}</p>
                      {n.body}
                    </li>
                  ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, big }: { label: string; value: string; big?: boolean }) {
  return (
    <div>
      <p className="text-[13px] text-muted">{label}</p>
      <p className={`num mt-0.5 font-semibold ${big ? "display text-2xl sm:text-3xl" : ""}`}>{value}</p>
    </div>
  );
}

function Chip({ children }: { children: string }) {
  return <li className="rounded-full bg-bg px-3 py-1.5 font-medium">{children}</li>;
}

function AcceptCard({ id, onDone }: { id: number; onDone: () => Promise<void> }) {
  const { t, locale } = useI18n();
  const a = t.agreement;
  const { address } = useConnection();
  const gasReady = useGasReady();
  const approveTx = useTaggedTx();
  const acceptTx = useTaggedTx();
  const calls = useQuery({
    queryKey: ["payer-calls", id],
    queryFn: () => agent<{ to: Address; data: Hex }[]>(`/v1/agreements/${id}/payer-calls`),
  });
  const approve = calls.data?.[0];
  const accept = calls.data?.[1];
  const needed = approve ? (decodeFunctionData({ abi: erc20Abi, data: approve.data }).args?.[1] as bigint) : undefined;
  const allowance = useReadContract({
    address: approve?.to,
    abi: erc20Abi,
    functionName: "allowance",
    args: address && accept ? [address, accept.to] : undefined,
    query: { enabled: !!approve && !!address },
  });
  const approved = needed !== undefined && allowance.data !== undefined && allowance.data >= needed;
  const err = approveTx.error ?? acceptTx.error;

  if (!calls.data || !approve || !accept) return <Skeleton className="h-44" />;

  return (
    <section className="card border-brick/50 p-6">
      <h2 className="display text-2xl font-semibold">{a.acceptTitle}</h2>
      <p className="mt-2 text-[15px] leading-relaxed text-muted">{fill(a.acceptBody, { allowance: moneyFor(needed ?? 0n, approve.to, locale) })}</p>
      {!gasReady && (
        <div className="mt-4">
          <Note tone="sun">{a.gasWarn}</Note>
        </div>
      )}
      {err && (
        <div className="mt-4">
          <Note tone="danger">{err === "declined" ? t.common.declined : err}</Note>
        </div>
      )}
      <div className="mt-5 flex flex-wrap gap-3">
        <Btn
          tone={approved ? "outline" : "brick"}
          disabled={approved}
          busy={approveTx.phase === "signing" || approveTx.phase === "confirming"}
          onClick={async () => {
            await approveTx.send(approve).catch(() => undefined);
            await allowance.refetch();
          }}
        >
          {approved ? `✓ ${a.approved}` : a.approve}
        </Btn>
        <Btn
          disabled={!approved}
          busy={acceptTx.phase === "signing" || acceptTx.phase === "confirming"}
          onClick={async () => {
            const ok = await acceptTx.send(accept).then(
              () => true,
              () => false,
            );
            if (ok) await onDone();
          }}
        >
          {a.accept}
        </Btn>
      </div>
    </section>
  );
}

function CancelButton({ id, onDone }: { id: number; onDone: () => Promise<void> }) {
  const { t } = useI18n();
  const tx = useTaggedTx();
  const health = useQuery({ queryKey: ["agent-health"], queryFn: () => agent<{ contract?: Address }>("/health"), staleTime: Infinity });
  const contract = health.data?.contract;
  return (
    <div>
      <Btn
        tone="danger"
        size="sm"
        disabled={!contract}
        busy={tx.phase === "signing" || tx.phase === "confirming"}
        onClick={async () => {
          if (!contract || !window.confirm(t.agreement.cancelConfirm)) return;
          const ok = await tx.send({ to: contract, data: encodeFunctionData({ abi: cuotaAbi, functionName: "cancel", args: [BigInt(id)] }) }).then(
            () => true,
            () => false,
          );
          if (ok) await onDone();
        }}
      >
        {t.agreement.cancel}
      </Btn>
      {tx.error && <p className="mt-2 text-sm text-danger">{tx.error === "declined" ? t.common.declined : tx.error}</p>}
    </div>
  );
}
