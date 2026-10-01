import path from 'node:path';
import { promises as fs } from 'node:fs';
import {
  buildMcpV1OutputContracts,
  mcpV1OutputContractHash,
  MCP_V1_OUTPUT_CONTRACT_VERSION,
} from '../src/mcp/output-contract.js';

const contracts = buildMcpV1OutputContracts();
const snapshot = {
  version: MCP_V1_OUTPUT_CONTRACT_VERSION,
  sha256: mcpV1OutputContractHash(contracts),
  contracts,
};

const output = path.join(
  process.cwd(),
  'src',
  'mcp',
  'v1-output-contract.json',
);
await fs.writeFile(
  output,
  JSON.stringify(snapshot, null, 2) + '\n',
  'utf8',
);
console.log(
  `Wrote ${Object.keys(contracts).length} stable MCP output contracts to ${output}`,
);
