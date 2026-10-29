import { parseAbi, type Address } from "viem";
import { createConfig, http } from "wagmi";
import { celo } from "wagmi/chains";
import { injected } from "wagmi/connectors";

export const config = createConfig({
  chains: [celo],
  connectors: [injected()],
  transports: { [celo.id]: http(process.env.NEXT_PUBLIC_CELO_RPC ?? "https://forno.celo.org") },
  ssr: true,
});

declare module "wagmi" {
  interface Register {
    config: typeof config;
  }
}

/** CuotaAgreements on Celo mainnet (set at deploy time). */
export const CONTRACT = (process.env.NEXT_PUBLIC_CUOTA_CONTRACT ?? "") as Address;

/** ERC-8021 builder code issued at hackathon enrollment; appended to every tx the web app sends. */
export const BUILDER_CODE = process.env.NEXT_PUBLIC_BUILDER_CODE ?? "";

export const USAT: Address = "0xD2ab3C9A02DBBAB236BfEC45D1d755DF4267F771";

export type Currency = "wARS" | "wBRL" | "wCOP" | "wMXN";

export const CURRENCIES: Record<Currency, { address: Address; symbol: string; iso: string; dollarizable: boolean }> = {
  wARS: { address: "0x0DC4F92879B7670e5f4e4e6e3c801D229129D90D", symbol: "$", iso: "ARS", dollarizable: true },
  wBRL: { address: "0xD76f5Faf6888e24D9F04Bf92a0c8B921FE4390e0", symbol: "R$", iso: "BRL", dollarizable: true },
  wCOP: { address: "0x8a1d45e102e886510e891d2ec656a708991e2d76", symbol: "$", iso: "COP", dollarizable: true },
  wMXN: { address: "0x337e7456b420bd3481e7fa61fa9850343d610d34", symbol: "$", iso: "MXN", dollarizable: false },
};

export function currencyByAddress(address: string): Currency | undefined {
  return (Object.keys(CURRENCIES) as Currency[]).find((c) => CURRENCIES[c].address.toLowerCase() === address.toLowerCase());
}

export const cuotaAbi = parseAbi([
  "event Proposed(uint256 indexed id, address indexed payee, address indexed payer, address token, uint256 amount)",
  "function cancel(uint256 id)",
]);

export const explorerTx = (h: string) => `https://celoscan.io/tx/${h}`;
