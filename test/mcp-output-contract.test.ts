import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  buildMcpV1OutputContracts,
  mcpV1OutputContractHash,
  MCP_V1_OUTPUT_CONTRACT_VERSION,
} from '../src/mcp/output-contract.js';
import { MCP_V1_STABLE_TOOLS } from '../src/mcp/surface.js';
import { requiredCapabilityForMcpTool } from '../src/mcp/tool-capabilities.js';

test('MCP v1 output contract covers every stable tool exactly', () => {
  const contracts = buildMcpV1OutputContracts();
  assert.deepEqual(
    Object.keys(contracts),
    [...MCP_V1_STABLE_TOOLS],
  );

  for (const name of MCP_V1_STABLE_TOOLS) {
    const contract = contracts[name];
    assert.equal(contract.tool, name);
    assert.equal(contract.surfaceVersion, 1);
    assert.equal(
      contract.contractVersion,
      MCP_V1_OUTPUT_CONTRACT_VERSION,
    );
    assert.equal(contract.structuredContentType, 'object');

    const native = requiredCapabilityForMcpTool(name) !== undefined;
    assert.equal(
      contract.profile,
      native ? 'native-execution-v1' : 'hub-object-v1',
      name,
    );

    if (native) {
      const ok = contract.fields.find(
        (field) => field.path === 'ok',
      );
      assert.equal(ok?.type, 'boolean', name);
      assert.equal(ok?.requiredOnSuccess, true, name);
    }
  }
});

test('frozen MCP v1 output contract matches current semantic descriptors', async () => {
  const snapshotPath = path.join(
    process.cwd(),
    'src',
    'mcp',
    'v1-output-contract.json',
  );
  const snapshot = JSON.parse(
    await fs.readFile(snapshotPath, 'utf8'),
  ) as {
    version: number;
    sha256: string;
    contracts: unknown;
  };

  const contracts = buildMcpV1OutputContracts();
  assert.equal(
    snapshot.version,
    MCP_V1_OUTPUT_CONTRACT_VERSION,
  );
  assert.equal(
    snapshot.sha256,
    mcpV1OutputContractHash(contracts),
  );
  assert.match(snapshot.sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(snapshot.contracts, contracts);
});

test('image-returning stable tools advertise mixed content while keeping structured metadata object-shaped', () => {
  const contracts = buildMcpV1OutputContracts();
  for (const name of [
    'browser_screenshot',
    'browser_visual_verify',
    'windows_screenshot',
  ] as const) {
    assert.equal(
      contracts[name].contentMode,
      'image-plus-json',
      name,
    );
    assert.equal(
      contracts[name].structuredContentType,
      'object',
      name,
    );
  }
});
