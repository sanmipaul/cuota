"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useConnection } from "wagmi";
import { useI18n } from "@/i18n/context";
import { agent, type AgreementRow } from "@/lib/agent";
import { day, moneyFor } from "@/lib/format";
import { Header } from "@/ui/Header";
import { Badge, Skeleton } from "@/ui/kit";
import { Wallet } from "@/ui/Wallet";
import { useHydrated } from "@/web3/hooks";

export default function Mine() {
  const { t, lang, locale } = useI18n();
  const hydrated = useHydrated();
  const { address } = useConnection();
  const list = useQuery({
    queryKey: ["mine", address],
    queryFn: () => agent<AgreementRow[]>(`/v1/wallets/${address}/agreements`),
    enabled: !!address,
  });

  return (
    <div className="flex min-h-full flex-col">
      <Header />
      <main className="mx-auto w-full max-w-4xl flex-1 px-5 pb-20 pt-4 sm:px-8">
        <h1 className="display text-5xl font-medium">{t.mine.title}</h1>
        {!hydrated ? null : !address ? (
          <div className="mt-6">
            <p className="mb-4 text-muted">{t.common.noWallet}</p>
            <Wallet size="lg" />
          </div>
        ) : list.isPending ? (
          <div className="mt-8 space-y-3">
            <Skeleton className="h-24" />
            <Skeleton className="h-24" />
          </div>
        ) : !list.data?.length ? (
          <p className="mt-8 text-muted">{t.mine.empty}</p>
        ) : (
          <ul className="mt-8 space-y-3">
            {list.data.map((a) => {
              const asPayee = a.payee === address.toLowerCase();
              return (
                <li key={a.id}>
                  <Link href={`/${lang}/c/${a.id}`} className="receipt block p-5 pt-6 transition-colors hover:border-brick/50">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <span className="display text-xl font-semibold">{a.label ?? `#${a.id}`}</span>
                      <span className="flex gap-2">
                        <Badge kind="neutral">{asPayee ? t.mine.asPayee : t.mine.asPayer}</Badge>
                        <Badge kind={a.status}>{t.agreement.statuses[a.status]}</Badge>
                      </span>
                    </div>
                    <div className="num mt-3 flex items-baseline justify-between text-sm text-muted">
                      <span>{a.status === "active" ? `${t.agreement.nextDue}: ${day(a.next_due_at, locale)}` : `#${a.id}`}</span>
                      <span className="text-lg font-semibold text-fg">{moneyFor(a.amount, a.token, locale)}</span>
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </main>
    </div>
  );
}
