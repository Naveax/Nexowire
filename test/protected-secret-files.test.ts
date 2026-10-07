import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import {
  inspectProtectedSecretFile,
  readProtectedSecretFile,
  readProtectedSecretListFile,
  resolveProtectedSingleSecret,
  writeProtectedSecretFile,
} from '../src/security/protected-secret-files.js';
import { SecretFileError } from '../src/security/secret-files.js';
import {
  protectWindowsUserSecretForPurpose,
  unprotectWindowsUserSecretForPurpose,
  WindowsDpapiError,
} from '../src/security/windows-dpapi.js';
import { loadConfig } from '../src/config.js';
import { agentTokenFromEnv } from '../src/agent/native-agent.js';
import { loadRelayConfig } from '../src/relay/config.js';

test(
  'purpose-bound Windows DPAPI secrets round-trip and reject cross-purpose unprotect',
  { skip: process.platform !== 'win32' },
  async () => {
    const ciphertext =
      await protectWindowsUserSecretForPurpose(
        'purpose-secret',
        'test-purpose-a',
      );
    assert.equal(
      await unprotectWindowsUserSecretForPurpose(
        ciphertext,
        'test-purpose-a',
      ),
      'purpose-secret',
    );
    await assert.rejects(
      () =>
        unprotectWindowsUserSecretForPurpose(
          ciphertext,
          'test-purpose-b',
        ),
      (error: unknown) =>
        error instanceof WindowsDpapiError &&
        error.code === 'WINDOWS_DPAPI_FAILED',
    );
  },
);

test(
  'protected secret files never persist plaintext and enforce purpose/overwrite',
  { skip: process.platform !== 'win32' },
  async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), 'nexowire-protected-secret-'),
    );
    const file = path.join(root, 'mcp.dpapi.json');

    try {
      const metadata = await writeProtectedSecretFile(
        file,
        'mcp-bearer-token',
        'mcp-super-secret\n',
      );
      assert.equal(metadata.purpose, 'mcp-bearer-token');
      assert.equal(
        readProtectedSecretFile(
          file,
          'mcp-bearer-token',
          'MCP token',
        ),
        'mcp-super-secret',
      );

      const raw = await fs.readFile(file, 'utf8');
      assert.equal(raw.includes('mcp-super-secret'), false);
      assert.deepEqual(
        inspectProtectedSecretFile(file),
        metadata,
      );

      assert.throws(
        () =>
          readProtectedSecretFile(
            file,
            'agent-bearer-token',
            'wrong purpose',
          ),
        (error: unknown) =>
          error instanceof SecretFileError &&
          error.code ===
            'PROTECTED_SECRET_PURPOSE_MISMATCH',
      );

      await assert.rejects(
        () =>
          writeProtectedSecretFile(
            file,
            'mcp-bearer-token',
            'replacement',
          ),
        (error: unknown) =>
          error instanceof SecretFileError &&
          error.code === 'PROTECTED_SECRET_EXISTS',
      );

      await writeProtectedSecretFile(
        file,
        'mcp-bearer-token',
        'replacement',
        { overwrite: true },
      );
      assert.equal(
        readProtectedSecretFile(
          file,
          'mcp-bearer-token',
          'MCP token',
        ),
        'replacement',
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);

test(
  'protected secret files support LocalMachine DPAPI envelopes without plaintext persistence',
  { skip: process.platform !== 'win32' },
  async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), 'nexowire-machine-secret-'),
    );
    const file = path.join(root, 'service.machine.dpapi.json');

    try {
      const metadata = await writeProtectedSecretFile(
        file,
        'control-plane-service-token',
        'machine-service-token',
        {
          scope: 'local-machine',
        },
      );
      assert.equal(
        metadata.protection,
        'windows-dpapi-local-machine',
      );
      assert.equal(
        readProtectedSecretFile(
          file,
          'control-plane-service-token',
          'service token',
        ),
        'machine-service-token',
      );
      const raw = await fs.readFile(file, 'utf8');
      assert.equal(
        raw.includes('machine-service-token'),
        false,
      );
      assert.equal(
        inspectProtectedSecretFile(file).protection,
        'windows-dpapi-local-machine',
      );
    } finally {
      await fs.rm(root, {
        recursive: true,
        force: true,
      });
    }
  },
);

test(
  'protected rotation-list files normalize newline/comma entries',
  { skip: process.platform !== 'win32' },
  async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), 'nexowire-protected-list-'),
    );
    const file = path.join(root, 'tokens.dpapi.json');

    try {
      await writeProtectedSecretFile(
        file,
        'mcp-bearer-token-list',
        'old-token\ncurrent-token,next-token\n',
        { allowMultiline: true },
      );
      assert.equal(
        readProtectedSecretListFile(
          file,
          'mcp-bearer-token-list',
          'MCP token list',
        ),
        'old-token,current-token,next-token',
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);

test(
  'hub, native agent, and relay accept DPAPI protected bootstrap sources',
  { skip: process.platform !== 'win32' },
  async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), 'nexowire-protected-runtime-'),
    );
    const mcp = path.join(root, 'mcp.dpapi.json');
    const mcpList = path.join(root, 'mcp-list.dpapi.json');
    const agent = path.join(root, 'agent.dpapi.json');
    const agentList = path.join(root, 'agent-list.dpapi.json');
    const relayInbound = path.join(root, 'relay.dpapi.json');
    const relayList = path.join(root, 'relay-list.dpapi.json');
    const relayUpstream = path.join(root, 'relay-upstream.dpapi.json');

    try {
      await Promise.all([
        writeProtectedSecretFile(
          mcp,
          'mcp-bearer-token',
          'mcp-current',
        ),
        writeProtectedSecretFile(
          mcpList,
          'mcp-bearer-token-list',
          'mcp-old\nmcp-next',
          { allowMultiline: true },
        ),
        writeProtectedSecretFile(
          agent,
          'agent-bearer-token',
          'agent-current',
        ),
        writeProtectedSecretFile(
          agentList,
          'agent-bearer-token-list',
          'agent-old,agent-next',
          { allowMultiline: true },
        ),
        writeProtectedSecretFile(
          relayInbound,
          'relay-inbound-agent-token',
          'relay-current',
        ),
        writeProtectedSecretFile(
          relayList,
          'relay-inbound-agent-token-list',
          'relay-old\nrelay-next',
          { allowMultiline: true },
        ),
        writeProtectedSecretFile(
          relayUpstream,
          'relay-upstream-agent-token',
          'upstream-current',
        ),
      ]);

      const config = loadConfig({
        NEXOWIRE_MCP_BEARER_TOKEN_DPAPI_FILE: mcp,
        NEXOWIRE_MCP_BEARER_TOKENS_DPAPI_FILE: mcpList,
        NEXOWIRE_AGENT_TOKEN_DPAPI_FILE: agent,
        NEXOWIRE_AGENT_BEARER_TOKENS_DPAPI_FILE: undefined,
        NEXOWIRE_AGENT_TOKENS_DPAPI_FILE: agentList,
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

      assert.equal(
        agentTokenFromEnv({
          NEXOWIRE_AGENT_TOKEN_DPAPI_FILE: agent,
        }),
        'agent-current',
      );

      const relay = loadRelayConfig({
        NEXOWIRE_RELAY_AGENT_TOKEN_DPAPI_FILE: relayInbound,
        NEXOWIRE_RELAY_AGENT_TOKENS_DPAPI_FILE: relayList,
        NEXOWIRE_RELAY_UPSTREAM_AGENT_TOKEN_DPAPI_FILE:
          relayUpstream,
      });
      assert.deepEqual(relay.inboundAgentTokens, [
        'relay-current',
        'relay-old',
        'relay-next',
      ]);
      assert.equal(
        relay.upstreamAgentToken,
        'upstream-current',
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);

test(
  'protected secret sealing fails closed off Windows',
  { skip: process.platform === 'win32' },
  async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), 'nexowire-protected-nonwin-'),
    );
    try {
      await assert.rejects(
        () =>
          writeProtectedSecretFile(
            path.join(root, 'secret.json'),
            'mcp-bearer-token',
            'secret',
          ),
        (error: unknown) =>
          error instanceof WindowsDpapiError &&
          error.code === 'WINDOWS_DPAPI_REQUIRED',
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);

test('additional single-secret source participates in conflict detection', () => {
  assert.equal(
    resolveProtectedSingleSecret(
      'same-secret',
      undefined,
      undefined,
      'agent-bearer-token',
      'agent token',
      'same-secret',
    ),
    'same-secret',
  );

  assert.throws(
    () =>
      resolveProtectedSingleSecret(
        'inline-secret',
        undefined,
        undefined,
        'agent-bearer-token',
        'agent token',
        'platform-secret',
      ),
    (error: unknown) =>
      error instanceof SecretFileError &&
      error.code === 'SECRET_SOURCE_CONFLICT',
  );
});
