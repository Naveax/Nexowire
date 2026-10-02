import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import type { NexowireConfig } from '../src/config.js';
import { CredentialStore } from '../src/security/credential-store.js';
import { assertFunnelAuthReady, tailscaleCommandErrorMessage } from '../src/tailscale-exposure.js';

function config(stateDir: string): NexowireConfig {
  return {
    host: '127.0.0.1',
    port: 43110,
    stateDir,
    skillsDir: path.join(process.cwd(), 'skills'),
  };
}

test('public Tailscale Funnel fails closed without MCP and agent auth', async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'nexowire-funnel-auth-'),
  );
  try {
    await assert.rejects(
      () => assertFunnelAuthReady(config(root)),
      /Refusing public Tailscale Funnel exposure/,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('public Tailscale Funnel accepts usable stored MCP and agent credentials', async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'nexowire-funnel-auth-ready-'),
  );
  try {
    const store = new CredentialStore(root);
    await store.initialize();
    await store.issue('mcp', {
      name: 'test-mcp',
      ttlMs: 60_000,
      role: 'admin',
    });
    await store.issue('agent', {
      name: 'test-agent',
      ttlMs: 60_000,
    });

    await assert.doesNotReject(
      () => assertFunnelAuthReady(config(root)),
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});


test('Tailscale command errors preserve actionable stdout such as enablement prompts', () => {
  const message = tailscaleCommandErrorMessage({
    message: 'Command failed: tailscale funnel --bg http://127.0.0.1:43110',
    stdout:
      'Funnel is not enabled on your tailnet.\nTo enable, visit:\nhttps://login.tailscale.com/f/funnel?node=test-node\n',
    stderr: '',
  });

  assert.match(message, /Funnel is not enabled on your tailnet/);
  assert.match(message, /https:\/\/login\.tailscale\.com\/f\/funnel\?node=test-node/);
  assert.equal(message.includes('Command failed:'), false);
});
