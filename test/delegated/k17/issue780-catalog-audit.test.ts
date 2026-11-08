import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { auditManifestText, auditSkillCatalogue } from './issue780-catalog-audit.js';
import { evaluateSkillManifest, parseSkillManifest } from '../../../src/skills/manifest.js';

function markdown(name: string, platforms = 'linux', description = 'A useful offline skill.'): string {
  return [
    '---',
    `name: ${name}`,
    `description: ${description}`,
    'version: 0.1',
    `platforms: ${platforms}`,
    'requires: files.read',
    '---',
    '# Example',
  ].join('\n');
}

test('T-352: absent platform metadata remains UNKNOWN, not universal support', () => {
  const absent = markdown('offline-audit').replace('platforms: linux\n', '');
  const blank = markdown('offline-audit', '');
  assert.deepEqual(auditManifestText('offline-audit', absent).map((f) => f.code), ['platform-unknown']);
  assert.deepEqual(auditManifestText('offline-audit', blank).map((f) => f.code), ['platform-unknown']);
});

test('T-352: contradictory support promises are reported, ordinary platform mentions are not', () => {
  const contradiction = markdown('offline-audit', 'linux', 'Runs on Windows and reads files.');
  assert.deepEqual(auditManifestText('offline-audit', contradiction).map((f) => f.code), [
    'unsupported-platform-claim',
  ]);
  assert.deepEqual(auditManifestText(
    'offline-audit', markdown('offline-audit', 'linux', 'Inspects Windows logs from Linux.'),
  ), []);
  assert.deepEqual(auditManifestText(
    'offline-audit', markdown('offline-audit', 'any', 'Runs on Windows.'),
  ), []);
});

test('T-492: valid quoted identity and platform declarations match runtime interpretation', () => {
  const source = markdown('quoted-skill', '"linux", "win32"', 'Runs on Windows.')
    .replace('name: quoted-skill', 'name: "quoted-skill"');
  const actual = parseSkillManifest(source);
  assert.deepEqual(actual.platforms, ['linux', 'win32']);
  assert.equal(evaluateSkillManifest(actual, { platform: 'win32' }).platformCompatible, true);
  assert.deepEqual(auditManifestText('quoted-skill', source), []);

  const linuxOnly = markdown('quoted-skill', "'linux'", 'Runs on Windows.')
    .replace('name: quoted-skill', "name: 'quoted-skill'");
  assert.deepEqual(auditManifestText('quoted-skill', linuxOnly).map((finding) => finding.code), [
    'unsupported-platform-claim',
  ]);
});

test('T-492/T-494: absent or mistyped platform field is UNKNOWN despite runtime any fallback', () => {
  const original = markdown('quoted-skill').replace('platforms: linux\n', '');
  const parsed = parseSkillManifest(original);
  assert.deepEqual(parsed.platforms, ['any']);
  for (const platform of ['win32', 'darwin', 'linux'] as const) {
    assert.equal(evaluateSkillManifest(parsed, { platform }).platformCompatible, true);
  }
  assert.deepEqual(auditManifestText('quoted-skill', original).map((finding) => finding.code), [
    'platform-unknown',
  ]);

  const mistyped = original.replace('requires: files.read', 'requires-any: shell.exec')
    .replace('version: 0.1', 'version: 0.1\nplatform: win32');
  const mistypedRuntime = parseSkillManifest(mistyped);
  assert.deepEqual(mistypedRuntime.platforms, ['any']);
  assert.deepEqual(mistypedRuntime.requires, []);
  assert.deepEqual(auditManifestText('quoted-skill', mistyped).map((finding) => finding.code), [
    'unknown-metadata-key', 'unknown-metadata-key', 'platform-unknown',
  ]);

  const typoDescription = markdown('quoted-skill').replace('description:', 'descripton:');
  assert.equal(parseSkillManifest(typoDescription).description, 'No skill description has been provided.');
  assert.deepEqual(auditManifestText('quoted-skill', typoDescription).map((finding) => finding.code), [
    'unknown-metadata-key',
  ]);
});

test('T-353: duplicate frontmatter and wrong directory identity are visible in read-only audit', () => {
  const duplicate = markdown('offline-audit').replace('name: offline-audit',
    'name: offline-audit\nNAME: different');
  assert.deepEqual(auditManifestText('offline-audit', duplicate).map((f) => f.code), [
    'duplicate-field', 'identity-mismatch',
  ]);
});

test('T-354: symlinked skill entries and manifests are not followed during inventory', {
  skip: process.platform === 'win32' ? 'Symlink creation may require privileges on Windows CI' : false,
}, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nexowire-k17-skillscan-'));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'nexowire-k17-outside-'));
  try {
    await fs.writeFile(path.join(outside, 'SKILL.md'), markdown('outside'));
    await fs.symlink(outside, path.join(root, 'linked-dir'), 'dir');
    await fs.mkdir(path.join(root, 'linked-file'));
    await fs.symlink(path.join(outside, 'SKILL.md'), path.join(root, 'linked-file', 'SKILL.md'));
    await fs.mkdir(path.join(root, 'missing'));
    await fs.mkdir(path.join(root, 'safe'));
    await fs.writeFile(path.join(root, 'safe', 'SKILL.md'), markdown('safe'));
    assert.deepEqual(await auditSkillCatalogue(root), {
      directories: 3,
      findings: [
        { directory: 'linked-dir', code: 'symlink-entry', detail: 'Symbolic-link skill directory; excluded without reading its target' },
        { directory: 'linked-file', code: 'symlink-manifest', detail: 'SKILL.md is a symbolic link; excluded without reading its target' },
        { directory: 'missing', code: 'missing-manifest', detail: 'No SKILL.md' },
      ],
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test('T-354: shipped skill catalogue contains no current path or support claim findings', async () => {
  const result = await auditSkillCatalogue(path.join(process.cwd(), 'skills'));
  assert.equal(result.directories, 45);
  assert.deepEqual(result.findings, []);
});
