import { randomBytes } from "node:crypto";
import { erc20Abi, type Address, type Hex } from "viem";
import { USDT } from "./celo.ts";
import type { Celo } from "./celo.ts";

/**
 * Dollarizing a landlord's share: sell wFIAT for USD₮ on Textile FX (RFQ v2).
 *
 * Textile answers a firm, maker-signed, all-or-nothing quote with the approval and swap
 * calldata; the agent checks the price against the market USD₮ rate, then signs and
 * sends both from its own (attributed) wallet.
 */

const API = "https://api.textilecredit.com/v2";

interface Tx {
  to: Address;
  data: Hex;
}

interface RfqResponse {
  data?: {
    rfqId: string;
    claimToken: string;
    status: "quoted" | "no_quote";
    reason?: string;
    quote?: { buyAmount: string; takerPays: string; spender: Address; expiresAt: string };
    transactions?: { approval: Tx; swap: Tx };
  };
  error?: { code?: string; message?: string; details?: { reason?: string } };
}

export type SellResult =
  | { filled: true; usdt: bigint; sold: bigint; tx: Hex; rfqId: string }
  | { filled: false; why: string };

export class Fx {
  constructor(
    private readonly celo: Celo,
    private readonly opts: { url?: string; key?: string; toleranceBps: number },
  ) {}

  private headers(claim?: string) {
    const h: Record<string, string> = { "content-type": "application/json" };
    if (this.opts.key) h.authorization = `Bearer ${this.opts.key}`;
    if (claim) h["x-rfq-claim"] = claim;
    return h;
  }

  private async proof() {
    const nonce = `0x${randomBytes(32).toString("hex")}` as Hex;
    const issuedAt = Date.now();
    const signature = await this.celo.account.signTypedData({
      domain: { name: "Textile Taker Control", version: "1", chainId: 42220 },
      types: {
        TakerControl: [
          { name: "taker", type: "address" },
          { name: "chainId", type: "uint256" },
          { name: "nonce", type: "bytes32" },
          { name: "issuedAt", type: "uint256" },
        ],
      },
      primaryType: "TakerControl",
      message: { taker: this.celo.account.address, chainId: 42220n, nonce, issuedAt: BigInt(issuedAt) },
    });
    return { nonce, issuedAt, signature };
  }

  /** Indicative USD₮ for `amount` of `token`, no commitment. Used to price x402 pay links. */
  async previewUsdt(token: Address, amount: bigint): Promise<bigint | undefined> {
    const res = await fetch(`${this.opts.url ?? API}/rfq/preview`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ chainId: 42220, sellToken: token, buyToken: USDT, sellAmount: amount.toString() }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json()) as { data?: { status: string; buyAmount?: string } };
    return body.data?.status === "preview" && body.data.buyAmount ? BigInt(body.data.buyAmount) : undefined;
  }

  async sell(token: Address, amount: bigint, marketUsdtPerUnit?: number): Promise<SellResult> {
    const { account, reader, signer } = this.celo;
    const request: Record<string, unknown> = {
      chainId: 42220,
      sellToken: token,
      buyToken: USDT,
      sellAmount: amount.toString(),
      taker: account.address,
    };
    if (!this.opts.key) request.takerProof = await this.proof();

    const res = await fetch(`${this.opts.url ?? API}/rfq/request`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(75_000),
    });
    const body = (await res.json()) as RfqResponse;
    if (body.error) return { filled: false, why: body.error.details?.reason ?? body.error.code ?? body.error.message ?? "error" };
    const d = body.data;
    if (!d || d.status !== "quoted" || !d.quote || !d.transactions) return { filled: false, why: d?.reason ?? "no_quote" };

    const usdt = BigInt(d.quote.buyAmount);
    const paying = BigInt(d.quote.takerPays);
    if (marketUsdtPerUnit) {
      const got = Number(usdt) / 1e6 / (Number(paying) / 1e18);
      const worseBps = ((marketUsdtPerUnit - got) / marketUsdtPerUnit) * 10_000;
      if (worseBps > this.opts.toleranceBps) {
        await this.release(d.rfqId, d.claimToken);
        return { filled: false, why: `quote ${worseBps.toFixed(0)} bps under market` };
      }
    }

    const allowance = await reader.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "allowance",
      args: [account.address, d.quote.spender],
    });
    if (allowance < paying) {
      const a = await signer.sendTransaction({ to: d.transactions.approval.to, data: d.transactions.approval.data });
      await reader.waitForTransactionReceipt({ hash: a });
    }
    if (Date.parse(d.quote.expiresAt) <= Date.now()) {
      await this.release(d.rfqId, d.claimToken);
      return { filled: false, why: "quote expired during approval" };
    }

    const tx = await signer.sendTransaction({ to: d.transactions.swap.to, data: d.transactions.swap.data });
    const receipt = await reader.waitForTransactionReceipt({ hash: tx });
    if (receipt.status !== "success") return { filled: false, why: `swap reverted ${tx}` };

    // Report the fill. Best effort: the swap is final whether or not Textile hears about it.
    await fetch(`${this.opts.url ?? API}/rfq/${d.rfqId}/submit`, {
      method: "POST",
      headers: this.headers(d.claimToken),
      body: JSON.stringify({ txHash: tx }),
    }).catch(() => undefined);

    return { filled: true, usdt, sold: paying, tx, rfqId: d.rfqId };
  }

  private async release(rfqId: string, claim: string) {
    await fetch(`${this.opts.url ?? API}/rfq/${rfqId}/cancel`, { method: "POST", headers: this.headers(claim), body: "{}" }).catch(
      () => undefined,
    );
  }
}

/** Market USD₮ per one unit of local currency (CoinGecko: USD₮ priced in ARS/BRL/COP). */
export async function marketUsdtPer(currency: "ars" | "brl" | "cop" | "mxn"): Promise<number | undefined> {
  try {
    const res = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=${currency}`, {
      signal: AbortSignal.timeout(8_000),
    });
    const body = (await res.json()) as { tether?: Record<string, number> };
    const localPerUsdt = body.tether?.[currency];
    return localPerUsdt ? 1 / localPerUsdt : undefined;
  } catch {
    return undefined;
  }
}
