import { decodeFunctionResult, encodeFunctionData, erc20Abi, type Address, type Hex } from "viem";
import { cuotaAbi } from "./celo.ts";
import type { Paid } from "./paid.ts";

/**
 * Pre-collection checks for every agreement due this tick, in ONE paid JSON-RPC batch to
 * Chainstack's archive-capable Celo node via buy ($0.01 for up to 2,000 calls). Per
 * agreement: the exact amount the contract will charge, the payer's balance, and the
 * payer's allowance to the contract. Anything that would revert is caught here and
 * turned into a notice instead of a failed transaction.
 */

const CHAINSTACK = "https://gateway.usebuy.ai/chainstack/celo";
const CAP_USD = 0.01;

export interface Preflight {
  id: number;
  due: bigint;
  balance: bigint;
  allowance: bigint;
  ok: boolean;
}

interface Due {
  id: number;
  payer: Address;
  token: Address;
}

export async function preflight(paid: Paid, contract: Address, due: Due[]): Promise<Preflight[]> {
  if (due.length === 0) return [];
  if (due.length * 3 > 2_000) throw new Error("preflight batch over Chainstack's 2,000-call cap; split it");

  const call = (to: Address, data: Hex, id: number) => ({ jsonrpc: "2.0", id, method: "eth_call", params: [{ to, data }, "latest"] });
  const batch = due.flatMap((d, i) => [
    call(contract, encodeFunctionData({ abi: cuotaAbi, functionName: "amountDue", args: [BigInt(d.id)] }), i * 3),
    call(d.token, encodeFunctionData({ abi: erc20Abi, functionName: "balanceOf", args: [d.payer] }), i * 3 + 1),
    call(d.token, encodeFunctionData({ abi: erc20Abi, functionName: "allowance", args: [d.payer, contract] }), i * 3 + 2),
  ]);

  const res = await paid.post<{ id: number; result?: Hex; error?: unknown }[]>(
    "chainstack/celo-rpc",
    CHAINSTACK,
    batch,
    CAP_USD,
    `collection preflight for ${due.length} agreement(s)`,
  );
  if (!Array.isArray(res.body)) throw new Error(`chainstack: unexpected response (HTTP ${res.status})`);
  const byId = new Map(res.body.map((r) => [r.id, r.result]));

  return due.map((d, i) => {
    const read = (k: number, fn: "amountDue" | "balanceOf" | "allowance") => {
      const raw = byId.get(i * 3 + k);
      if (!raw || raw === "0x") return 0n;
      return fn === "amountDue"
        ? (decodeFunctionResult({ abi: cuotaAbi, functionName: "amountDue", data: raw }) as bigint)
        : (decodeFunctionResult({ abi: erc20Abi, functionName: fn, data: raw }) as bigint);
    };
    const dueAmt = read(0, "amountDue");
    const balance = read(1, "balanceOf");
    const allowance = read(2, "allowance");
    return { id: d.id, due: dueAmt, balance, allowance, ok: dueAmt > 0n && balance >= dueAmt && allowance >= dueAmt };
  });
}
