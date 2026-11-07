import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { auditManifestText, auditSkillCatalogue } from './issue780-catalog-audit.js';

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
