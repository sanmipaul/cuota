"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Suspense } from "react";
import { LANGS } from "@/i18n/dictionaries";
import { useI18n } from "@/i18n/context";
import { Wallet } from "./Wallet";

export function Logo() {
  const { lang } = useI18n();
  return (
    <Link href={`/${lang}`} className="flex items-center gap-2" aria-label="Cuota">
      <svg aria-hidden width="26" height="26" viewBox="0 0 26 26" className="text-brick">
        <path d="M3 22h5v-5h5v-5h5V7h5" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span className="display text-[26px] font-semibold leading-none">Cuota</span>
    </Link>
  );
}

function LangSwitch() {
  const { lang } = useI18n();
  const path = usePathname();
  const rest = path.replace(/^\/(es|pt|en)/, "");
  return (
    <div className="flex rounded-full border border-line p-0.5 text-xs font-semibold" role="group" aria-label="Idioma / Language">
      {LANGS.map((l) => (
        <Link
          key={l}
          href={`/${l}${rest}`}
          hrefLang={l}
          className={`rounded-full px-2.5 py-1 uppercase ${l === lang ? "bg-fg text-bg" : "text-muted hover:text-fg"}`}
        >
          {l}
        </Link>
      ))}
    </div>
  );
}

export function Header() {
  const { lang, t } = useI18n();
  return (
    <header className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-3 px-5 py-4 sm:px-8">
      <Logo />
      <div className="flex items-center gap-2 sm:gap-4">
        <nav className="hidden items-center gap-1 text-sm font-medium md:flex">
          <Link href={`/${lang}/new`} className="rounded-full px-3 py-1.5 text-muted hover:text-fg">
            {t.nav.new}
          </Link>
          <Link href={`/${lang}/mine`} className="rounded-full px-3 py-1.5 text-muted hover:text-fg">
            {t.nav.mine}
          </Link>
        </nav>
        <Suspense fallback={<div className="h-7 w-[108px]" />}>
          <LangSwitch />
        </Suspense>
        <Wallet />
      </div>
    </header>
  );
}
