/**
 * ERC-8004 identity for the Cuota agent, registered from the agent wallet. With AGENT_ID
 * set it re-points the identity at the current /agent.json instead.
 */
import { parseAbi, parseEventLogs } from "viem";
import { connect } from "../src/celo.ts";
import { readEnv } from "../src/env.ts";

const REGISTRY = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432";
const abi = parseAbi([
  "function register(string agentURI) returns (uint256)",
  "function setAgentURI(uint256 agentId, string newURI)",
  "event Registered(uint256 indexed agentId, string agentURI, address indexed owner)",
]);

const env = readEnv();
const { signer, reader } = connect(env);
const uri = `${env.BASE_URL}/agent.json`;

if (env.AGENT_ID) {
  const hash = await signer.writeContract({ address: REGISTRY, abi, functionName: "setAgentURI", args: [BigInt(env.AGENT_ID), uri] });
  await reader.waitForTransactionReceipt({ hash });
  console.log(`agent ${env.AGENT_ID} → ${uri} (tx ${hash})`);
} else {
  const hash = await signer.writeContract({ address: REGISTRY, abi, functionName: "register", args: [uri] });
  const receipt = await reader.waitForTransactionReceipt({ hash });
  const [registered] = parseEventLogs({ abi, logs: receipt.logs, eventName: "Registered" });
  if (!registered) throw new Error(`no Registered event in ${hash}`);
  console.log(`registered agent ${registered.args.agentId} (tx ${hash})\n\n.env:\nAGENT_ID=${registered.args.agentId}`);
}
