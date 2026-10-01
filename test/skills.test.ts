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
