import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import {
  evaluateSkillManifest,
  parseSkillManifest,
} from '../src/skills/manifest.js';
import { SkillRegistry } from '../src/skills/registry.js';

test('skill manifest parser applies safe defaults and parses machine-readable metadata', () => {
  const manifest = parseSkillManifest(
    [
      '---',
      'name: windows-demo',
      'description: Demonstrate structured Windows control.',
      'version: 1.2.3',
      'requires: windows.processes, windows.services, windows.processes',
      'platforms: win32',
      'mutation: read-only',
      'privilege: user',
      'trust: trusted',
      'tags: windows, diagnostics',
      '---',
      '# Windows Demo',
      '',
    ].join('\n'),
    'windows-demo',
  );

  assert.deepEqual(manifest, {
    name: 'windows-demo',
    description: 'Demonstrate structured Windows control.',
    version: '1.2.3',
    requires: ['windows.processes', 'windows.services'],
    platforms: ['win32'],
    mutation: 'read-only',
    privilege: 'user',
    trust: 'trusted',
    tags: ['windows', 'diagnostics'],
  });
});

test('skill manifest evaluation reports capability and platform gaps', () => {
  const manifest = parseSkillManifest(
    [
      '---',
      'name: windows-demo',
      'description: Demonstrate structured Windows control.',
      'requires: windows.processes, windows.services',
      'platforms: win32',
      '---',
      '# Windows Demo',
      '',
    ].join('\n'),
    'windows-demo',
  );

  assert.deepEqual(
    evaluateSkillManifest(manifest, {
      capabilities: ['windows.processes'],
      platform: 'win32',
    }),
    {
      runnable: false,
      platformCompatible: true,
      missingCapabilities: ['windows.services'],
    },
  );

  assert.deepEqual(
    evaluateSkillManifest(manifest, {
      capabilities: ['windows.processes', 'windows.services'],
      platform: 'linux',
    }),
    {
      runnable: false,
      platformCompatible: false,
      missingCapabilities: [],
    },
  );
});

test('skill registry loads manifests lazily and evaluates device compatibility', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nexowire-skill-'));
  const dir = path.join(root, 'repo-resume');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'SKILL.md'),
    [
      '---',
      'name: repo-resume',
      'description: Resume repository work safely.',
      'version: 0.1',
      'requires: workspace.snapshot, search.text',
      'platforms: any',
      'mutation: mixed',
      'privilege: user',
      'trust: reviewed',
      'tags: repo, recovery',
      '---',
      '# Skill',
      '',
    ].join('\n'),
    'utf8',
  );

  const registry = new SkillRegistry(root);
  assert.deepEqual(await registry.list(), [
    {
      name: 'repo-resume',
      description: 'Resume repository work safely.',
      version: '0.1',
      requires: ['workspace.snapshot', 'search.text'],
      platforms: ['any'],
      mutation: 'mixed',
      privilege: 'user',
      trust: 'reviewed',
      tags: ['repo', 'recovery'],
    },
  ]);

  const evaluated = await registry.list({
    capabilities: ['workspace.snapshot'],
    platform: 'linux',
  });
  assert.equal(evaluated[0]?.evaluation?.runnable, false);
  assert.deepEqual(
    evaluated[0]?.evaluation?.missingCapabilities,
    ['search.text'],
  );

  const loaded = await registry.load('repo-resume');
  assert.equal(loaded.manifest.name, 'repo-resume');
  assert.match(loaded.markdown, /# Skill/);
  assert.match(await registry.read('repo-resume'), /# Skill/);
  await assert.rejects(() => registry.read('../escape'));

  const validated = await registry.validate();
  assert.equal(validated.ok, true);
  assert.equal(validated.valid.length, 1);

  await fs.rm(root, { recursive: true, force: true });
});

test('skill registry validation reports mismatched or invalid manifests without hiding them', async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'nexowire-skill-invalid-'),
  );
  const dir = path.join(root, 'actual-name');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'SKILL.md'),
    [
      '---',
      'name: different-name',
      'description: Invalid mismatch.',
      'mutation: impossible',
      '---',
      '# Skill',
      '',
    ].join('\n'),
    'utf8',
  );

  const registry = new SkillRegistry(root);
  assert.deepEqual(await registry.list(), []);

  const result = await registry.validate();
  assert.equal(result.ok, false);
  assert.equal(result.valid.length, 0);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0]?.directory, 'actual-name');

  await fs.rm(root, { recursive: true, force: true });
});

test('skill manifest v2 supports capability alternatives, preferences, concurrency, and replay policy', () => {
  const manifest = parseSkillManifest(
    [
      '---',
      'manifest_version: 2',
      'name: network-v2',
      'description: Exercise additive manifest v2 semantics.',
      'version: 2.0',
      'requires: machine.health, network.dns.resolve',
      'requires_any: network.http.probe | shell.exec; network.tcp.probe | shell.exec',
      'prefers: network.http.probe, network.tcp.probe',
      'platforms: any',
      'mutation: read-only',
      'privilege: user',
      'trust: trusted',
      'tags: network, diagnostics',
      'concurrency: parallel-safe',
      'replay: safe',
      '---',
      '# Network v2',
      '',
    ].join('\n'),
  );

  assert.deepEqual(manifest, {
    name: 'network-v2',
    description: 'Exercise additive manifest v2 semantics.',
    version: '2.0',
    requires: ['machine.health', 'network.dns.resolve'],
    platforms: ['any'],
    mutation: 'read-only',
    privilege: 'user',
    trust: 'trusted',
    tags: ['network', 'diagnostics'],
    manifestVersion: 2,
    requiresAny: [
      ['network.http.probe', 'shell.exec'],
      ['network.tcp.probe', 'shell.exec'],
    ],
    prefers: ['network.http.probe', 'network.tcp.probe'],
    concurrency: 'parallel-safe',
    replay: 'safe',
  });

  assert.deepEqual(
    evaluateSkillManifest(manifest, {
      capabilities: [
        'machine.health',
        'network.dns.resolve',
        'shell.exec',
      ],
      platform: 'linux',
    }),
    {
      runnable: true,
      platformCompatible: true,
      missingCapabilities: [],
      unsatisfiedCapabilityGroups: [],
      availablePreferredCapabilities: [],
      missingPreferredCapabilities: [
        'network.http.probe',
        'network.tcp.probe',
      ],
    },
  );

  assert.deepEqual(
    evaluateSkillManifest(manifest, {
      capabilities: [
        'machine.health',
        'network.dns.resolve',
        'network.http.probe',
      ],
      platform: 'linux',
    }),
    {
      runnable: false,
      platformCompatible: true,
      missingCapabilities: [],
      unsatisfiedCapabilityGroups: [
        ['network.tcp.probe', 'shell.exec'],
      ],
      availablePreferredCapabilities: [
        'network.http.probe',
      ],
      missingPreferredCapabilities: [
        'network.tcp.probe',
      ],
    },
  );
});

test('skill manifest v1 rejects v2-only fields and v2 fails closed on unsafe replay declaration', () => {
  assert.throws(
    () =>
      parseSkillManifest(
        [
          '---',
          'name: bad-v1',
          'requires_any: shell.exec | process.list',
          '---',
          '# Bad',
        ].join('\n'),
      ),
    /manifest v2 fields require manifest_version: 2/,
  );

  assert.throws(
    () =>
      parseSkillManifest(
        [
          '---',
          'manifest_version: 2',
          'name: unsafe-replay',
          'mutation: mutation',
          'replay: safe',
          '---',
          '# Unsafe',
        ].join('\n'),
      ),
    /cannot declare replay: safe/,
  );
});
