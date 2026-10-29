// End-to-end run of the Cuota engine against a local anvil started with `anvil --chain-id 42220 --port 18545`.
// Deploys the contract and a mock peso, proposes/accepts through the API calldata, then time-travels through
// a collection, a returned conversion and a fixed-step adjustment. No paid calls: it exercises the fallbacks.
//   npm run e2e
import { readFileSync, rmSync } from "node:fs";
import { createPublicClient, createTestClient, createWalletClient, http, parseAbi, type Abi, type Hex, encodeDeployData } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { celo } from "viem/chains";
import { verifyTx } from "@celo/attribution-tags";

const RPC = process.env.E2E_RPC ?? "http://127.0.0.1:18545";
const DB = process.env.E2E_DB ?? "./e2e-anvil.db";
rmSync(DB, { force: true });
rmSync(`${DB}-wal`, { force: true });
rmSync(`${DB}-shm`, { force: true });

// anvil's first default account deploys and runs the agent; the two parties get fresh keys.
const agentKey = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const payeeKey = generatePrivateKey();
const payerKey = generatePrivateKey();

Object.assign(process.env, {
  RPC_URL: RPC,
  AGENT_KEY: agentKey,
  BUILDER_CODE: "celo_e2e",
  X402_KEY: "dummy",
  ADMIN_TOKEN: "0123456789abcdef0123",
  DB_PATH: DB,
  BUY_BUDGET_USD_PER_DAY: "0", // no paid calls in this run: exercises the fallbacks
});

const { readEnv } = await import("../src/env.ts");
const { connect, cuotaAbi } = await import("../src/celo.ts");
const { openDb } = await import("../src/db.ts");
const { Engine } = await import("../src/engine.ts");
const { Fx } = await import("../src/fx.ts");
const { Notices } = await import("../src/notices.ts");
const { Paid } = await import("../src/paid.ts");
const { app } = await import("../src/http.ts");

const reader = createPublicClient({ chain: celo, transport: http(RPC) });
const testClient = createTestClient({ chain: celo, mode: "anvil", transport: http(RPC) });
const wallet = (k: Hex) => createWalletClient({ chain: celo, transport: http(RPC), account: privateKeyToAccount(k) });
const artifact = (p: string) => JSON.parse(readFileSync(new URL(`../../contracts/out/${p}`, import.meta.url), "utf8")) as { abi: Abi; bytecode: { object: Hex } };
const send = async (k: Hex, to: Hex | null, data: Hex) => {
  const hash = await wallet(k).sendTransaction({ to, data });
  const r = await reader.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`reverted ${hash}`);
  return r;
};
const erc20 = parseAbi(["function mint(address,uint256)", "function balanceOf(address) view returns (uint256)"]);

// 1. fund the parties, deploy the contract (agent) and a mock peso
for (const k of [payeeKey, payerKey]) await testClient.setBalance({ address: privateKeyToAccount(k).address, value: 10n ** 20n });
const env0 = readEnv();
const celoC = connect(env0);
const out = artifact("CuotaAgreements.sol/CuotaAgreements.json");
const dep = await celoC.signer.sendTransaction({ to: null, data: encodeDeployData({ abi: out.abi, bytecode: out.bytecode.object, args: [celoC.account.address] }) });
const contract = (await reader.waitForTransactionReceipt({ hash: dep })).contractAddress!;
await reader.waitForTransactionReceipt({ hash: await celoC.signer.writeContract({ address: contract, abi: cuotaAbi, functionName: "setAgent", args: [celoC.account.address, true] }) });
const peso = artifact("CuotaAgreements.t.sol/Peso.json");
const token = (await send(payerKey, null, peso.bytecode.object)).contractAddress!;
const payer = privateKeyToAccount(payerKey).address;
const payee = privateKeyToAccount(payeeKey).address;
await send(payerKey, token, (await import("viem")).encodeFunctionData({ abi: erc20, functionName: "mint", args: [payer, 10n ** 27n] }));
console.log("deployed", { contract, token });

process.env.CONTRACT = contract;
const env = readEnv();
const db = openDb(DB);
const paid = new Paid(db, 0, celoC);
const fx = new Fx(celoC, { toleranceBps: 200 });
const notices = new Notices(db, paid);
const log = (m: string, d?: object) => console.log("  agent:", m, JSON.stringify(d ?? {}));
const engine = new Engine({ db, celo: celoC, contract, fromBlock: 0n, paid, fx, notices, log });
const api = app({ env, db, celo: celoC, fx, engine, contract, log });
const auth = { authorization: "Bearer 0123456789abcdef0123", "content-type": "application/json" };

// 2. payee prepares + proposes. The API only knows real wFIAT symbols, so swap the token in the calldata.
const block = await reader.getBlock();
const firstDue = new Date(Number(block.timestamp + 5n * 86_400n) * 1000).toISOString().slice(0, 10);
const prep = await (await api.request("/v1/agreements/prepare", {
  method: "POST",
  headers: auth,
  body: JSON.stringify({
    payee, payer, token: "wARS", amount: 650000, maxStepPct: 25, periodDays: 30, noticeDays: 10,
    firstDueDate: firstDue, convertPct: 40, index: "FIXED", fixedStepPct: 3, adjustEveryMonths: 1,
    label: "Depto Palermo 3B", locale: "es-AR",
  }),
})).json() as { payeeSigns: { to: Hex; data: Hex }; termsHash: Hex };
const realWars = "0dc4f92879b7670e5f4e4e6e3c801d229129d90d";
const data = prep.payeeSigns.data.toLowerCase().replace(realWars, token.slice(2).toLowerCase()) as Hex;
await send(payeeKey, contract, data);

// 3. sync, payer accepts with the calls the API returns
await engine.tick();
const calls = await (await api.request("/v1/agreements/1/payer-calls", { headers: auth })).json() as { to: Hex; data: Hex }[];
calls[0]!.to = token; // approval goes to the mock token
for (const c of calls) await send(payerKey, c.to, c.data);
await engine.tick();
console.log("status after accept:", (db.prepare("SELECT status, amount FROM agreements WHERE id=1").get() as any));

// 4. travel to the due date → collect
await testClient.increaseTime({ seconds: 6 * 86_400 }); // first due date is day 5 at 12:00 UTC
await testClient.mine({ blocks: 1 });
await engine.tick();
const bal = (a: Hex) => reader.readContract({ address: token, abi: erc20, functionName: "balanceOf", args: [a] });
console.log("payee after cycle 1:", Number((await bal(payee)) / 10n ** 18n), "(expect 390000 = 60%)");
console.log("agent holds for conversion:", Number((await bal(celoC.account.address)) / 10n ** 18n), "(expect 260000)");

// 5. conversion can't fill (mock token has no market) → after 24h it's returned in pesos
await testClient.increaseTime({ seconds: 25 * 3600 });
await testClient.mine({ blocks: 1 });
await engine.tick();
console.log("payee after return:", Number((await bal(payee)) / 10n ** 18n), "(expect 650000)");
console.log("conversion:", db.prepare("SELECT state, attempts FROM conversions").get());

// 6. adjustEveryMonths=1 from the first due date lands on the period-3 due date (day 60, since a calendar
//    month is longer than 30 days). The window opens notice (10d) + slack (3d) before it: travel to ~day 48.
await testClient.increaseTime({ seconds: 46 * 86_400 });
await testClient.mine({ blocks: 1 });
await engine.tick();
const a = await reader.readContract({ address: contract, abi: cuotaAbi, functionName: "get", args: [1n] });
console.log("pending amount:", Number(a.pendingAmount / 10n ** 18n), "(expect 669500)", "from", new Date(Number(a.pendingFrom) * 1000).toISOString().slice(0, 10), "(expect first due + 60d)", "cycle now", a.cycle, "(expect 3: period 2 collected)");

// 7. ERC-8021: every agent tx carries the builder code
const lastCollect = db.prepare("SELECT tx FROM payments WHERE cycle = 1").get() as { tx: Hex };
console.log("attribution on collect tx:", await verifyTx({ client: reader, hash: lastCollect.tx }));
console.log("notices:", (db.prepare("SELECT kind, audience, substr(body,1,90) AS body FROM notices").all() as any[]).map((n) => `${n.kind}/${n.audience}: ${n.body}`));
