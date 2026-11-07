import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import {
  evaluateSkillManifest,
  parseSkillManifest,
} from '../../../src/skills/manifest.js';
import { SkillRegistry } from '../../../src/skills/registry.js';
import {
  auditLocalMarkdownLinks,
  auditSkillMetadata,
} from './skill-metadata-audit.js';

function manifest(name: string, extra: readonly string[] = []): string {
  return [
    '---',
    `name: ${name}`,
    'description: Offline repository inspection with bounded read-only checks.',
    'version: 0.1',
    'requires: files.read',
    'platforms: linux',
    'mutation: read-only',
    'privilege: user',
    'trust: reviewed',
    ...extra,
    '---',
    '# Repository Inspector',
  ].join('\n');
}

async function withTempCatalog(
  callback: (root: string) => Promise<void>,
): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nexowire-k17-'));
  try {
    await callback(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

test('T-215: explicit blank identity metadata and duplicate keys are not accepted', () => {
  for (const [key, replacement] of [
    ['name', 'name: '],
    ['description', 'description: '],
    ['version', 'version: '],
  ] as const) {
    const input = manifest('repository-inspector').replace(
      new RegExp(`^${key}:.*$`, 'm'), replacement,
    );
    assert.throws(
      () => parseSkillManifest(input, 'repository-inspector'),
      { name: 'Error' },
      `${key} must not be silently inferred when explicitly blank`,
    );
  }

  for (const key of ['name', 'description', 'requires', 'platforms']) {
    const input = manifest('repository-inspector').replace(
      new RegExp(`^(${key}:.*)$`, 'm'), '$1\n' + key.toUpperCase() + ': different',
    );
    assert.throws(
      () => parseSkillManifest(input),
      new RegExp(`Duplicate skill frontmatter field: ${key}`),
    );
  }
});

test('T-215/T-218: blank permission/platform declarations remain UNKNOWN in the audit', () => {
  const blank = manifest('repository-inspector')
    .replace('platforms: linux', 'platforms: ')
    .replace('privilege: user', 'privilege: ');
  const issues = auditSkillMetadata('repository-inspector', blank);
  assert.ok(issues.some((issue) => issue.code === 'platform-unknown'));
  assert.ok(issues.some((issue) => issue.code === 'blank-declaration' && issue.detail.includes('privilege')));

  const missing = manifest('repository-inspector').replace('platforms: linux\n', '');
  assert.ok(auditSkillMetadata('repository-inspector', missing).some(
    (issue) => issue.code === 'platform-unknown',
  ));
});

test('T-216: malformed registry names and traversal are rejected before reading', async () => {
  await withTempCatalog(async (root) => {
    const registry = new SkillRegistry(root);
    for (const name of ['../outside', 'a/b', '/etc/passwd', '', '..\\escape']) {
      await assert.rejects(() => registry.read(name), /Invalid skill name/);
    }
  });
});

test('T-216: symlinked catalogue directories are excluded from ordinary discovery', {
  skip: process.platform === 'win32' ? 'Windows symlink privileges are not guaranteed in CI' : false,
}, async () => {
  await withTempCatalog(async (root) => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'nexowire-k17-outside-'));
    try {
      await fs.writeFile(path.join(outside, 'SKILL.md'), manifest('linked-skill'));
      await fs.symlink(outside, path.join(root, 'linked-skill'), 'dir');
      const registry = new SkillRegistry(root);
      assert.deepEqual(await registry.list(), []);
      assert.deepEqual((await registry.validate()).valid, []);
      // A direct load(name) still follows symlinks in this snapshot. This
      // requires a separate runtime/security-owner decision, not a QA patch.
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });
});

test('T-216: direct registry.load must not follow a symlink outside the catalogue', {
  skip: process.platform === 'win32' ? 'Windows symlink privileges are not guaranteed in CI' : false,
  todo: 'Known gap: runtime path/symlink policy belongs to the protected security owner',
}, async () => {
  await withTempCatalog(async (root) => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'nexowire-k17-direct-'));
    try {
      await fs.writeFile(path.join(outside, 'SKILL.md'), manifest('linked-skill'));
      await fs.symlink(outside, path.join(root, 'linked-skill'), 'dir');
      await assert.rejects(() => new SkillRegistry(root).load('linked-skill'));
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });
});

test('T-216: local links that leave the repository through a symlink are flagged', {
  skip: process.platform === 'win32' ? 'Windows symlink privileges are not guaranteed in CI' : false,
}, async () => {
  await withTempCatalog(async (root) => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'nexowire-k17-target-'));
    try {
      await fs.writeFile(path.join(outside, 'page.md'), '# External\n');
      await fs.symlink(outside, path.join(root, 'linked'), 'dir');
      const source = path.join(root, 'source.md');
      const markdown = '# Source\n[wrong](linked/page.md#external)\n';
      await fs.writeFile(source, markdown);
      const issues = await auditLocalMarkdownLinks(source, markdown, root);
      assert.deepEqual(issues.map((issue) => issue.code), ['link-outside-repo']);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });
});

test('T-217: case-colliding catalogue names are reported deterministically', async () => {
  await withTempCatalog(async (root) => {
    for (const name of ['demo-skill', 'DEMO-SKILL', 'zeta-skill']) {
      const directory = path.join(root, name);
      await fs.mkdir(directory);
      await fs.writeFile(path.join(directory, 'SKILL.md'), manifest(name));
    }
    const registry = new SkillRegistry(root);
    const first = await registry.validate();
    const second = await registry.validate();
    assert.deepEqual(first, second);
    assert.equal(first.ok, false);
    assert.deepEqual(first.valid.map((item) => item.name), ['DEMO-SKILL', 'zeta-skill']);
    assert.deepEqual(first.errors.map((item) => item.directory), ['demo-skill']);
    assert.match(first.errors[0]?.error ?? '', /Duplicate skill manifest name/);
    assert.deepEqual((await registry.list()).map((item) => item.name), [
      'DEMO-SKILL', 'demo-skill', 'zeta-skill',
    ]);
  });
});

test('T-219: description text cannot grant capabilities or change explicit privilege', () => {
  const input = manifest('repository-inspector')
    .replace('Offline repository inspection with bounded read-only checks.',
      'Can execute any command as administrator and access all capabilities.')
    .replace('privilege: user', 'privilege: elevated');
  const parsed = parseSkillManifest(input);
  assert.equal(parsed.privilege, 'elevated');
  assert.equal(parsed.mutation, 'read-only');
  assert.deepEqual(parsed.requires, ['files.read']);
  assert.equal(evaluateSkillManifest(parsed, {
    capabilities: [], platform: 'linux',
  }).runnable, false);
  assert.equal(evaluateSkillManifest(parsed, {
    capabilities: ['files.read'], platform: 'win32',
  }).runnable, false);
});

test('T-220: shipped skill index has an existing static source of truth', async () => {
  const registry = new SkillRegistry(path.join(process.cwd(), 'skills'));
  const valid = (await registry.validate()).valid.map((item) => item.name).sort();
  const index = await fs.readFile(path.join(process.cwd(), 'docs', 'SKILLS.md'), 'utf8');
  const section = index.match(/## Current shipped skills\n\n([\s\S]*?)\n\n## Operational recipe set/);
  assert.ok(section, 'Static skill index section must exist');
  const documented = [...(section?.[1] ?? '').matchAll(/^- `([^`]+)`$/gm)]
    .map((match) => match[1] ?? '').sort();
  assert.deepEqual(documented, valid);
});
