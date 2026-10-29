import { withAttribution } from "@celo/attribution-tags";
import { createPublicClient, createWalletClient, http, parseAbi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { celo } from "viem/chains";
import type { Env } from "./env.ts";

export const USDT: Address = "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e";
export const USAT: Address = "0xD2ab3C9A02DBBAB236BfEC45D1d755DF4267F771";

/** Ripio wFIAT on Celo (18 decimals). Only the ones Textile quotes against USD₮ can be dollarized. */
export const WFIAT = {
  wARS: { address: "0x0DC4F92879B7670e5f4e4e6e3c801D229129D90D", currency: "ars", country: "AR", dollarizable: true },
  wBRL: { address: "0xD76f5Faf6888e24D9F04Bf92a0c8B921FE4390e0", currency: "brl", country: "BR", dollarizable: true },
  wCOP: { address: "0x8a1d45e102e886510e891d2ec656a708991e2d76", currency: "cop", country: "CO", dollarizable: true },
  wMXN: { address: "0x337e7456b420bd3481e7fa61fa9850343d610d34", currency: "mxn", country: "MX", dollarizable: false },
} as const satisfies Record<string, { address: Address; currency: string; country: string; dollarizable: boolean }>;

export type WfiatSymbol = keyof typeof WFIAT;

export function wfiatByAddress(address: string) {
  const entry = Object.entries(WFIAT).find(([, t]) => t.address.toLowerCase() === address.toLowerCase());
  return entry ? { symbol: entry[0] as WfiatSymbol, ...entry[1] } : undefined;
}

export const cuotaAbi = parseAbi([
  "struct Terms { address payer; address token; uint256 amount; uint256 ceiling; uint16 maxStepBps; uint32 period; uint32 notice; uint64 firstDueAt; uint16 convertBps; uint8 index; bytes32 termsHash; }",
  "struct Agreement { Terms terms; address payee; uint8 status; uint256 amount; uint64 nextDueAt; uint32 cycle; uint256 pendingAmount; uint64 pendingFrom; }",
  "function propose(Terms t) returns (uint256)",
  "function accept(uint256 id)",
  "function cancel(uint256 id)",
  "function announceAdjustment(uint256 id, uint256 newAmount, bytes32 indexRef)",
  "function collect(uint256 id) returns (uint256)",
  "function markPaidOffChain(uint256 id, bytes32 ref)",
  "function settleConversion(uint256 id, uint32 cycle, address token, uint256 amount, bytes32 swapTx)",
  "function setAgent(address agent, bool allowed)",
  "function get(uint256 id) view returns (Agreement)",
  "function amountDue(uint256 id) view returns (uint256)",
  "function nextId() view returns (uint256)",
  "event Proposed(uint256 indexed id, address indexed payee, address indexed payer, address token, uint256 amount)",
  "event Accepted(uint256 indexed id)",
  "event Cancelled(uint256 indexed id, address by)",
  "event AdjustmentAnnounced(uint256 indexed id, uint256 oldAmount, uint256 newAmount, uint64 effectiveFrom, bytes32 indexRef)",
  "event Collected(uint256 indexed id, uint32 indexed cycle, uint256 amount, uint256 toPayee, uint256 toConvert)",
  "event PaidOffChain(uint256 indexed id, uint32 indexed cycle, bytes32 ref)",
  "event ConversionSettled(uint256 indexed id, uint32 indexed cycle, address token, uint256 amount, bytes32 swapTx)",
]);

export function connect(env: Env) {
  const account = privateKeyToAccount(env.AGENT_KEY as Hex);
  const transport = http(env.RPC_URL);
  const reader = createPublicClient({ chain: celo, transport });
  // The one signer in the agent. Wrapping it here means no Cuota transaction can leave
  // without the ERC-8021 builder code on its calldata.
  const signer = createWalletClient({ chain: celo, transport, account }).extend(withAttribution(env.BUILDER_CODE));
  return { account, reader, signer };
}

export type Celo = ReturnType<typeof connect>;
