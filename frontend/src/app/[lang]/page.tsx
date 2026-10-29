import { notFound } from "next/navigation";
import { DICTS, isLang } from "@/i18n/dictionaries";
import { Header } from "@/ui/Header";
import { BtnLink } from "@/ui/kit";
import { StairChart } from "@/ui/StairChart";

export default async function Home({ params }: PageProps<"/[lang]">) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  const t = DICTS[lang].home;

  return (
    <div className="flex min-h-full flex-col">
      <Header />
      <main className="flex-1">
        <section className="mx-auto grid w-full max-w-6xl items-center gap-10 px-5 pb-16 pt-6 sm:px-8 lg:grid-cols-[1.1fr_1fr] lg:gap-14 lg:pb-24 lg:pt-12">
          <div className="fade-up">
            <p className="text-sm font-semibold text-brick">{t.kicker}</p>
            <h1 className="display mt-4 text-[44px] font-medium leading-[1.02] sm:text-6xl lg:text-[72px]">
              {t.title} <span className="italic text-muted">{t.titleTail}</span>
            </h1>
            <p className="mt-6 max-w-xl text-lg leading-relaxed text-muted">{t.lead}</p>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <BtnLink href={`/${lang}/new`} size="lg">
                {t.ctaOwner}
              </BtnLink>
              <a href="#tenant" className="inline-flex h-13 items-center rounded-full px-5 text-[15px] font-semibold text-fg underline decoration-line-strong decoration-2 underline-offset-4 hover:decoration-brick">
                {t.ctaTenant}
              </a>
            </div>
          </div>
          <div className="fade-up [animation-delay:120ms]">
            <StairChart />
          </div>
        </section>

        <section className="mx-auto w-full max-w-6xl px-5 pb-16 sm:px-8 lg:pb-24">
          <h2 className="display text-4xl font-medium sm:text-5xl">{t.stepsTitle}</h2>
          <ol className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {t.steps.map((s, i) => (
              <li key={s.title} className="receipt p-6 pt-7">
                <span className="display num text-3xl font-semibold text-brick">{i + 1}</span>
                <h3 className="mt-3 text-lg font-bold leading-snug">{s.title}</h3>
                <p className="mt-2 text-[15px] leading-relaxed text-muted">{s.body}</p>
              </li>
            ))}
          </ol>
        </section>

        <section className="bg-brick-soft/60">
          <div className="mx-auto grid w-full max-w-6xl gap-10 px-5 py-16 sm:px-8 lg:grid-cols-[1fr_1.2fr] lg:py-20">
            <div>
              <h2 className="display text-4xl font-medium sm:text-5xl">{t.trustTitle}</h2>
              <p className="mt-4 max-w-md text-[15px] leading-relaxed text-muted">{t.trustFoot}</p>
            </div>
            <ul className="grid gap-3">
              {t.trust.map((line) => (
                <li key={line} className="card flex items-start gap-3 px-5 py-4 text-[15px]">
                  <span aria-hidden className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brick text-brick-ink">
                    <svg width="12" height="12" viewBox="0 0 12 12">
                      <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                    </svg>
                  </span>
                  {line}
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section id="tenant" className="mx-auto grid w-full max-w-6xl gap-6 px-5 py-16 sm:px-8 md:grid-cols-2 lg:py-20">
          <div className="card p-7">
            <h2 className="display text-3xl font-medium">{t.ctaTenant}</h2>
            <p className="mt-3 text-[15px] leading-relaxed text-muted">{t.tenantHint}</p>
          </div>
          <div className="card p-7">
            <h2 className="display text-3xl font-medium">{t.foreignTitle}</h2>
            <p className="mt-3 text-[15px] leading-relaxed text-muted">{t.foreignBody}</p>
          </div>
        </section>
      </main>
      <footer className="border-t border-line">
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-3 px-5 py-6 text-sm text-faint sm:px-8">
          <span>Cuota · Celo · wARS / wBRL by Ripio · FX by Textile</span>
          <a href="/agent/agent.json" className="hover:text-fg">
            ERC-8004
          </a>
        </div>
      </footer>
    </div>
  );
}
