import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import {
  readSecretFile,
  readSecretListFile,
  resolveSingleSecret,
  SecretFileError,
} from '../src/security/secret-files.js';
import {
  assertSafeRemoteBinding,
  loadConfig,
} from '../src/config.js';
import { loadRelayConfig } from '../src/relay/config.js';
import { agentTokenFromEnv } from '../src/agent/native-agent.js';

test('bounded secret files trim single tokens and normalize rotation lists', async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'nexowire-secret-files-'),
  );
  const single = path.join(root, 'single.txt');
  const list = path.join(root, 'list.txt');

  try {
    await fs.writeFile(single, '  single-secret\n', 'utf8');
    await fs.writeFile(list, 'old-secret\ncurrent-secret,next-secret\n', 'utf8');

    assert.equal(
      readSecretFile(single, 'test token'),
      'single-secret',
    );
    assert.equal(
      readSecretListFile(list, 'test token list'),
      'old-secret,current-secret,next-secret',
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('secret files fail closed on multiline singles, NUL bytes, size bounds, and conflicting sources', async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'nexowire-secret-invalid-'),
  );
  const multiline = path.join(root, 'multiline.txt');
  const nul = path.join(root, 'nul.txt');
  const large = path.join(root, 'large.txt');
  const current = path.join(root, 'current.txt');

  try {
    await fs.writeFile(multiline, 'first\nsecond\n', 'utf8');
    await fs.writeFile(nul, Buffer.from([0x61, 0x00, 0x62]));
    await fs.writeFile(large, '1234567890', 'utf8');
    await fs.writeFile(current, 'file-secret\n', 'utf8');

    assert.throws(
      () => readSecretFile(multiline, 'multiline token'),
      (error: unknown) =>
        error instanceof SecretFileError &&
        error.code === 'SECRET_FILE_MULTILINE',
    );
    assert.throws(
      () => readSecretFile(nul, 'nul token'),
      (error: unknown) =>
        error instanceof SecretFileError &&
        error.code === 'SECRET_FILE_INVALID',
    );
    assert.throws(
      () =>
        readSecretFile(large, 'large token', {
          maxBytes: 4,
        }),
      (error: unknown) =>
        error instanceof SecretFileError &&
        error.code === 'SECRET_FILE_TOO_LARGE',
    );
    assert.throws(
      () =>
        resolveSingleSecret(
          'inline-secret',
          current,
          'conflicting token',
        ),
      (error: unknown) =>
        error instanceof SecretFileError &&
        error.code === 'SECRET_SOURCE_CONFLICT',
    );
    assert.equal(
      resolveSingleSecret(
        'file-secret',
        current,
        'matching token',
      ),
      'file-secret',
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('hub config accepts mounted secret files for MCP and native-agent rotation sets', async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'nexowire-secret-config-'),
  );
  const mcp = path.join(root, 'mcp.txt');
  const mcpList = path.join(root, 'mcp-list.txt');
  const agent = path.join(root, 'agent.txt');
  const agentList = path.join(root, 'agent-list.txt');

  try {
    await Promise.all([
      fs.writeFile(mcp, 'mcp-current\n', 'utf8'),
      fs.writeFile(mcpList, 'mcp-old\nmcp-next\n', 'utf8'),
      fs.writeFile(agent, 'agent-current\n', 'utf8'),
      fs.writeFile(agentList, 'agent-old,agent-next\n', 'utf8'),
    ]);

    const config = loadConfig({
      NEXOWIRE_HTTP_HOST: '0.0.0.0',
      NEXOWIRE_HTTP_PORT: '43110',
      NEXOWIRE_MCP_BEARER_TOKEN_FILE: mcp,
      NEXOWIRE_MCP_BEARER_TOKENS_FILE: mcpList,
      NEXOWIRE_AGENT_TOKEN_FILE: agent,
      NEXOWIRE_AGENT_TOKENS_FILE: agentList,
      NEXOWIRE_TLS_CERT_FILE: 'cert.pem',
      NEXOWIRE_TLS_KEY_FILE: 'key.pem',
    });

    assert.deepEqual(config.mcpBearerTokens, [
      'mcp-current',
      'mcp-old',
      'mcp-next',
    ]);
    assert.deepEqual(config.agentTokens, [
      'agent-current',
      'agent-old',
      'agent-next',
    ]);
    assert.equal(config.mcpBearerToken, 'mcp-current');
    assert.equal(config.agentToken, 'agent-current');
    assert.doesNotThrow(() => assertSafeRemoteBinding(config));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('native agent and relay can load bearer credentials from mounted secret files', async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'nexowire-secret-runtime-'),
  );
  const agent = path.join(root, 'agent.txt');
  const relayInbound = path.join(root, 'relay-inbound.txt');
  const relayList = path.join(root, 'relay-list.txt');
  const relayUpstream = path.join(root, 'relay-upstream.txt');

  try {
    await Promise.all([
      fs.writeFile(agent, 'agent-file-token\n', 'utf8'),
      fs.writeFile(relayInbound, 'relay-current\n', 'utf8'),
      fs.writeFile(relayList, 'relay-old\nrelay-next\n', 'utf8'),
      fs.writeFile(relayUpstream, 'hub-upstream-token\n', 'utf8'),
    ]);

    assert.equal(
      agentTokenFromEnv({
        NEXOWIRE_AGENT_TOKEN_FILE: agent,
      }),
      'agent-file-token',
    );

    const relay = loadRelayConfig({
      NEXOWIRE_RELAY_AGENT_TOKEN_FILE: relayInbound,
      NEXOWIRE_RELAY_AGENT_TOKENS_FILE: relayList,
      NEXOWIRE_RELAY_UPSTREAM_AGENT_TOKEN_FILE: relayUpstream,
    });
    assert.deepEqual(relay.inboundAgentTokens, [
      'relay-current',
      'relay-old',
      'relay-next',
    ]);
    assert.equal(
      relay.upstreamAgentToken,
      'hub-upstream-token',
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
