"use client";

import { useSyncExternalStore } from "react";
import { useBalance, useConnection } from "wagmi";

const subscribe = () => () => {};

/** True only in the browser after hydration: wallet state doesn't exist on the server. */
export function useHydrated() {
  return useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
}

function isMiniPay() {
  return typeof window !== "undefined" && !!(window as unknown as { ethereum?: { isMiniPay?: boolean } }).ethereum?.isMiniPay;
}

/**
 * Whether the connected wallet can pay gas. MiniPay pays gas in the stablecoin the user
 * holds, so it's always fine; other wallets need a little CELO.
 */
export function useGasReady() {
  const { address } = useConnection();
  const { data } = useBalance({ address, query: { enabled: !!address } });
  if (!address || isMiniPay()) return true;
  return data === undefined ? true : data.value > 0n;
}
