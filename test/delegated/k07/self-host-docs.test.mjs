import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const documents = ['docs/SELF_HOST.md', 'docs/DEPLOYMENT_ONBOARDING.md'];

async function contents(file) {
  return readFile(path.join(repoRoot, file), 'utf8');
}

function localLinks(markdown) {
  return [...markdown.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)]
    .map((match) => match[1].trim())
    .filter((target) => !/^(?:[a-z]+:|#)/i.test(target));
}

function possibleCredentials(markdown) {
  return [
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
    /\bnwx1\.(?:mcp|agent)\.[a-z0-9_-]{16,}/i,
    /\bNEXOWIRE_[A-Z0-9_]*(?:TOKEN|SECRET|KEY)\s*=\s*["']?[a-z0-9._-]{16,}/i,
  ].some((pattern) => pattern.test(markdown));
}

test('all relative self-host documentation links resolve offline', async () => {
  let checked = 0;
  for (const doc of documents) {
    for (const link of localLinks(await contents(doc))) {
      const target = decodeURIComponent(link.split('#')[0]);
      const resolved = path.resolve(repoRoot, path.dirname(doc), target);
      assert.ok(
        resolved.startsWith(repoRoot + path.sep),
        `Link escapes repository: ${doc} -> ${link}`,
      );
      assert.ok((await stat(resolved)).isFile(), `Broken link: ${doc} -> ${link}`);
      checked++;
    }
  }
  assert.ok(checked >= 3, 'Test should cover multiple real relative links');
});

test('documentation distinguishes hosted login from Windows self-host bootstrap', async () => {
  const selfHost = await contents(documents[0]);
  const onboarding = await contents(documents[1]);
  assert.match(selfHost, /normal hosted connection flow/);
  assert.match(selfHost, /requires Windows/);
  assert.match(selfHost, /Node\.js \*\*22\+\*\*/);
  assert.match(selfHost, /Tailscale Funnel.*optional|Optional Tailscale Funnel/is);
  assert.match(selfHost, /\b127\.0\.0\.1\b/);
  assert.match(onboarding, /two distinct operator flows/i);
  assert.match(onboarding, /does \*\*not\*\* install a Hub\/Agent/);
  assert.match(onboarding, /doctor --remote/);
});

test('CLI examples remain within documented, read-only or explicit bootstrap verbs', async () => {
  const allowed = new Set([
    'node bootstrap', 'node status', 'node connector',
    'hub status', 'agent doctor', 'tailscale status',
    'onboard plan', 'onboard bootstrap', 'doctor',
  ]);
  let examined = 0;
  for (const doc of documents) {
    for (const line of (await contents(doc)).split(/\r?\n/)) {
      const match = line.trim().match(/^nexowire\s+(\S+)(?:\s+(\S+))?/);
      if (!match) continue;
      const verb = match[1] === 'doctor' ? 'doctor' : `${match[1]} ${match[2] ?? ''}`.trim();
      assert.ok(allowed.has(verb), `Unreviewed CLI verb in ${doc}: ${verb}`);
      examined++;
    }
  }
  assert.ok(examined >= 10, 'Command smoke should examine the actual examples');
});

test('docs do not contain a token or private key; negative fixtures are recognized', async () => {
  assert.equal(possibleCredentials('nwx1.mcp.' + 'X'.repeat(28)), true);
  assert.equal(possibleCredentials('NEXOWIRE_AGENT_TOKEN=' + 'fake-example-value-123456'), true);
  assert.equal(possibleCredentials('-----BEGIN PRIVATE KEY-----'), true);
  assert.equal(possibleCredentials('NEXOWIRE_AGENT_TOKEN_FILE=<protected-path>'), false);
  for (const doc of documents) {
    assert.equal(possibleCredentials(await contents(doc)), false, `Possible secret in ${doc}`);
  }
});
