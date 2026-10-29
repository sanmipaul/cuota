"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { WagmiProvider } from "wagmi";
import type { Lang } from "@/i18n/dictionaries";
import { I18nProvider } from "@/i18n/context";
import { config } from "@/web3/config";

export function Providers({ lang, children }: { lang: Lang; children: ReactNode }) {
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: 1, staleTime: 8_000 } } }));
  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={client}>
        <I18nProvider lang={lang}>{children}</I18nProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
