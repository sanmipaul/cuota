/**
 * Deploy CuotaAgreements from the agent wallet (ERC-8021-tagged like every agent tx)
 * and authorize the agent. Build first: `cd ../contracts && forge build`.
 */
import { readFileSync } from "node:fs";
import { encodeDeployData, type Abi, type Hex } from "viem";
import { connect, cuotaAbi } from "../src/celo.ts";
import { readEnv } from "../src/env.ts";

const env = readEnv();
const { signer, reader, account } = connect(env);
const out = JSON.parse(readFileSync(new URL("../../contracts/out/CuotaAgreements.sol/CuotaAgreements.json", import.meta.url), "utf8")) as {
  abi: Abi;
  bytecode: { object: Hex };
};

const hash = await signer.sendTransaction({
  to: null,
  data: encodeDeployData({ abi: out.abi, bytecode: out.bytecode.object, args: [account.address] }),
});
const receipt = await reader.waitForTransactionReceipt({ hash });
const contract = receipt.contractAddress;
if (!contract) throw new Error(`deploy failed: ${hash}`);
console.log(`CuotaAgreements ${contract} (block ${receipt.blockNumber}, tx ${hash})`);

const auth = await signer.writeContract({ address: contract, abi: cuotaAbi, functionName: "setAgent", args: [account.address, true] });
await reader.waitForTransactionReceipt({ hash: auth });
console.log(`agent ${account.address} authorized (tx ${auth})`);
console.log(`\n.env:\nCONTRACT=${contract}\nCONTRACT_FROM_BLOCK=${receipt.blockNumber}`);
