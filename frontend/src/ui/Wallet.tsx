"use client";

import { useState } from "react";
import { celo } from "viem/chains";
import { useConnect, useConnection, useConnectors, useDisconnect, useSwitchChain } from "wagmi";
import { useI18n } from "@/i18n/context";
import { short } from "@/lib/format";
import { useHydrated } from "@/web3/hooks";
import { Btn } from "./kit";

/** Connect button / connected chip with the Celo network check built in. */
export function Wallet({ size = "sm" }: { size?: "sm" | "md" | "lg" }) {
  const { t } = useI18n();
  const hydrated = useHydrated();
  const { address, isConnected, chainId } = useConnection();
  const connectors = useConnectors();
  const { mutate: connect, isPending } = useConnect();
  const { mutate: disconnect } = useDisconnect();
  const { mutate: switchChain, isPending: switching } = useSwitchChain();
  const [open, setOpen] = useState(false);

  if (!hydrated) return <div className="h-9 w-36" aria-hidden />;

  if (isConnected && address) {
    if (chainId !== celo.id) {
      return (
        <Btn size={size} busy={switching} onClick={() => switchChain({ chainId: celo.id })}>
          {t.common.wrongChain}
        </Btn>
      );
    }
    return (
      <div className="relative">
        <Btn size={size} tone="outline" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          <span aria-hidden className="h-2 w-2 rounded-full bg-olive" />
          <span className="num">{short(address)}</span>
        </Btn>
        {open && (
          <div className="card absolute right-0 z-30 mt-2 w-44 p-1.5 text-sm">
            <button
              className="w-full rounded-xl px-3 py-2 text-left text-danger hover:bg-bg"
              onClick={() => {
                disconnect();
                setOpen(false);
              }}
            >
              {t.nav.disconnect}
            </button>
          </div>
        )}
      </div>
    );
  }

  const injected = connectors[0];
  if (!injected || typeof window === "undefined" || !("ethereum" in window)) {
    return (
      <a href="https://www.opera.com/products/minipay" target="_blank" rel="noreferrer" className="inline-flex h-9 items-center rounded-full border border-line-strong bg-card px-4 text-sm font-semibold hover:border-fg">
        {t.nav.getWallet}
      </a>
    );
  }
  return (
    <Btn size={size} busy={isPending} onClick={() => connect({ connector: injected })}>
      {t.nav.connect}
    </Btn>
  );
}
