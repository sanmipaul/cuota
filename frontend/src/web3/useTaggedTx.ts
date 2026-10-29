"use client";

import { toDataSuffix } from "@celo/attribution-tags";
import { useState } from "react";
import { concat, type Hex, type TransactionReceipt } from "viem";
import { celo } from "viem/chains";
import { useConfig, useSendTransaction } from "wagmi";
import { waitForTransactionReceipt } from "wagmi/actions";
import { declined, readable } from "@/lib/errors";
import { BUILDER_CODE } from "./config";

export type TxPhase = "idle" | "signing" | "confirming" | "done" | "error";

const suffix = BUILDER_CODE ? toDataSuffix(BUILDER_CODE) : undefined;

/**
 * Send a prepared call from the connected wallet with Cuota's ERC-8021 builder code
 * appended to the calldata, and wait for it to land. Every transaction the web app
 * sends goes through here so none of them reach the chain untagged.
 */
export function useTaggedTx() {
  const wagmiConfig = useConfig();
  const { mutateAsync } = useSendTransaction();
  const [phase, setPhase] = useState<TxPhase>("idle");
  const [error, setError] = useState<string | null>(null);

  async function send(call: { to: Hex; data: Hex }): Promise<TransactionReceipt> {
    setError(null);
    setPhase("signing");
    try {
      const hash = await mutateAsync({ to: call.to, data: suffix ? concat([call.data, suffix]) : call.data, chainId: celo.id });
      setPhase("confirming");
      const receipt = await waitForTransactionReceipt(wagmiConfig, { hash, chainId: celo.id });
      if (receipt.status !== "success") throw new Error(`reverted: ${hash}`);
      setPhase("done");
      return receipt;
    } catch (e) {
      setPhase("error");
      console.error("transaction failed", e);
      setError(declined(e) ? "declined" : readable(e, "Transaction failed"));
      throw e;
    }
  }

  return { send, phase, error, reset: () => (setPhase("idle"), setError(null)) };
}
