import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, symlink, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {auditPhysicalPassLabels, scanPhysicalPassClaims}
  from '../../../scripts/delegated/pool-k19/audit-physical-pass-labels.js';

test('T-245: physical PASS assertions are candidates for review, never verified results', () => {
  const md = [
    '# Evidence',
    'Gerçek iki cihaz testi PASS.',
    'Physical Windows device PASSED without a run URL.',
    'Gerçek cihaz PASS değildir; onay bekliyor.',
    'Real two-PC ACCEPTANCE NOT_RUN, not PASS.',
    'Windows Node 24 CI PASS (offline compilation only).',
    '```md',
    'real device PASS (example in a code fence)',
    '```',
    'fiziksel makine ✅',
  ].join('\n');
  const report = scanPhysicalPassClaims(md, 'evidence.md');
  assert.deepEqual(report.map(x => x.line), [2, 3, 10]);
  assert.ok(report.every(x => x.kind === 'PHYSICAL_PASS_REVIEW_REQUIRED'));
  assert.ok(report.every(x => x.file === 'evidence.md'));
  assert.ok(report.every(x => x.excerpt.length <= 240));
});

test('T-245: scoped reader skips symlinks and non-doc files, sorts reproducibly', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'nw-k19-evidence-audit-'));
  try {
    await mkdir(path.join(root, 'docs'));
    await writeFile(path.join(root, 'docs', 'z.md'), 'Real device PASS\n', 'utf8');
    await writeFile(path.join(root, 'docs', 'a.txt'), 'gerçek Windows cihaz PASS\n', 'utf8');
    await writeFile(path.join(root, 'docs', 'ignored.ts'), 'real device PASS\n', 'utf8');
    try {
      await symlink(path.join(root, 'docs', 'z.md'), path.join(root, 'docs', 'link.md'));
    } catch (error) {
      // Symlink creation may require extra privileges on a Windows CI runner.
      if (!['EPERM', 'EACCES', 'ENOSYS'].includes((error as NodeJS.ErrnoException).code ?? '')) {
        throw error;
      }
    }
    const findings = await auditPhysicalPassLabels([path.join(root, 'docs')]);
    assert.deepEqual(findings.map(x => path.basename(x.file)), ['a.txt', 'z.md']);
    assert.deepEqual(findings.map(x => x.line), [1, 1]);
    await assert.rejects(auditPhysicalPassLabels([path.join(root, 'nonexistent')]),
      /ENOENT/);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test('T-245: claims without physical qualifiers are not mislabeled physical acceptance', () => {
  const md = [
    '17/17 sentetik PASS; gerçek iki-PC NOT_RUN.',
    'Node 22 Linux smoke PASS.',
    'Fiziksel kabul BLOKLU; PASS sayma.',
    'Gerçek Windows cihaz NOT_RUN.',
  ].join('\n');
  assert.deepEqual(scanPhysicalPassClaims(md, 'scope.md'), []);
});

