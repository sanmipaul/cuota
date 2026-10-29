import type { Metadata, Viewport } from "next";
import { Figtree, Fraunces } from "next/font/google";
import { notFound } from "next/navigation";
import { DICTS, isLang, LANGS } from "@/i18n/dictionaries";
import { Providers } from "./providers";
import "../globals.css";

const serif = Fraunces({ variable: "--font-fraunces", subsets: ["latin"], axes: ["SOFT", "opsz"] });
const sans = Figtree({ variable: "--font-figtree", subsets: ["latin"] });

export function generateStaticParams() {
  return LANGS.map((lang) => ({ lang }));
}

export async function generateMetadata({ params }: LayoutProps<"/[lang]">): Promise<Metadata> {
  const { lang } = await params;
  const t = DICTS[isLang(lang) ? lang : "es"];
  return {
    title: { default: t.meta.title, template: "%s · Cuota" },
    description: t.meta.description,
    alternates: { languages: { es: "/es", pt: "/pt", en: "/en" } },
  };
}

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f6efe3" },
    { media: "(prefers-color-scheme: dark)", color: "#18130f" },
  ],
};

export default async function RootLayout({ children, params }: LayoutProps<"/[lang]">) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  return (
    <html lang={lang === "pt" ? "pt-BR" : lang === "es" ? "es-AR" : "en"} className={`${serif.variable} ${sans.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col">
        <Providers lang={lang}>{children}</Providers>
      </body>
    </html>
  );
}
