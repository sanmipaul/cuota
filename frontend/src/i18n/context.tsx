"use client";

import { createContext, useContext, type ReactNode } from "react";
import { DICTS, LOCALE, type Dict, type Lang } from "./dictionaries";

const I18n = createContext<{ lang: Lang; t: Dict; locale: string } | null>(null);

export function I18nProvider({ lang, children }: { lang: Lang; children: ReactNode }) {
  return <I18n.Provider value={{ lang, t: DICTS[lang], locale: LOCALE[lang] }}>{children}</I18n.Provider>;
}

export function useI18n() {
  const v = useContext(I18n);
  if (!v) throw new Error("useI18n outside I18nProvider");
  return v;
}
