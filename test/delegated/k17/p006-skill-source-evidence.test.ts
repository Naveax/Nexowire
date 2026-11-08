import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { evaluateSkillManifest, parseSkillManifest } from '../../../src/skills/manifest.js';
import { SkillRegistry } from '../../../src/skills/registry.js';

function source(name: string, extra: readonly string[] = []): string {
  return [
    '---',
    `name: ${name}`,
    'description: Source-only offline skill fixture.',
    'version: 0.1',
    'requires: files.read',
    ...extra,
    '---',
    '# Source-only fixture',
  ].join('\n');
}

async function withCatalog(callback: (root: string) => Promise<void>): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nexowire-k17-p006-'));
  try {
    await callback(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

test('T-631: explicit win32 platform rejects Linux while omitted platforms stay source-UNKNOWN', () => {
  const explicit = parseSkillManifest(source('fixture', ['platforms: win32']));
  assert.deepEqual(explicit.platforms, ['win32']);
  assert.equal(evaluateSkillManifest(explicit, { platform: 'linux' }).platformCompatible, false);
  assert.equal(evaluateSkillManifest(explicit, { platform: 'win32' }).platformCompatible, true);

  const omitted = source('fixture');
  const legacy = parseSkillManifest(omitted);
  assert.deepEqual(legacy.platforms, ['any']);
  assert.equal(evaluateSkillManifest(legacy, { platform: 'linux' }).platformCompatible, true);
  assert.equal(/^platforms\s*:/im.test(omitted), false,
    'An implicit any admission is not an explicit platform support claim');
});

test('T-631: invalid explicit platform values are rejected rather than widened', () => {
  assert.throws(
    () => parseSkillManifest(source('fixture', ['platforms: windows'])),
    /Invalid skill platform: windows/,
  );
  assert.throws(
    () => parseSkillManifest(source('fixture', ['platforms: linux, unknown-os'])),
    /Invalid skill platform: unknown-os/,
  );
});

test('T-636: an exact-case quoted skill name is valid, but mismatched case is not', async () => {
  await withCatalog(async (root) => {
    const directory = path.join(root, 'CaseFixture');
    await fs.mkdir(directory);
    const manifestFile = path.join(directory, 'SKILL.md');
    await fs.writeFile(manifestFile, source('"CaseFixture"', ['platforms: linux']));
    const registry = new SkillRegistry(root);
    assert.equal((await registry.load('CaseFixture')).manifest.name, 'CaseFixture');
    assert.deepEqual((await registry.validate()).valid.map((skill) => skill.name), ['CaseFixture']);

    await fs.writeFile(manifestFile, source('casefixture', ['platforms: linux']));
    await assert.rejects(() => registry.load('CaseFixture'), /does not match directory/);
    const validation = await registry.validate();
    assert.equal(validation.ok, false);
    assert.equal(validation.valid.length, 0);
    assert.equal(validation.errors.length, 1);
  });
});

test('T-632: KNOWN OPEN GAP — direct registry load follows an external symlink, listing hides it', {
  skip: process.platform === 'win32' ? 'Windows symlink creation privileges are not established' : false,
}, async () => {
  await withCatalog(async (root) => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'nexowire-k17-p006-outside-'));
    try {
      await fs.writeFile(path.join(outside, 'SKILL.md'), source('linked-skill'));
      await fs.symlink(outside, path.join(root, 'linked-skill'), 'dir');
      const registry = new SkillRegistry(root);
      assert.deepEqual(await registry.list(), [], 'ordinary discovery omits symlinked directories');
      assert.deepEqual((await registry.validate()).valid, []);
      const direct = await registry.load('linked-skill');
      assert.equal(direct.manifest.name, 'linked-skill',
        'Source behavior reproduced: direct load currently reads outside path; NOT a security PASS');
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });
});

test('T-633: platform source admission is separate from a physically executed install command', () => {
  const windowsOnly = parseSkillManifest(source('fixture', ['platforms: win32']));
  const linuxResult = evaluateSkillManifest(windowsOnly, { platform: 'linux' });
  assert.equal(linuxResult.runnable, false);
  // This test evaluates metadata. It does not execute a Windows setup or Linux installer.
  const physicalEvidence: 'NOT_RUN' = 'NOT_RUN';
  assert.equal(physicalEvidence, 'NOT_RUN');
});

interface RunJob { conclusion: string | null; steps: Array<{ name: string; conclusion: string | null }> }

function hasExplicitSuccessfulStep(jobs: readonly RunJob[], testFile: string): boolean {
  return jobs.some((job) => job.conclusion === 'success' && job.steps.some((step) =>
    step.conclusion === 'success' && step.name.includes(testFile)));
}

test('T-634: seven green CI jobs do not prove an unnamed nested K17 test was invoked', () => {
  const jobs = Array.from({ length: 7 }, (_, index) => ({
    conclusion: 'success',
    steps: [{ name: index === 0 ? 'Run npm test' : 'Run CI matrix', conclusion: 'success' }],
  }));
  assert.equal(jobs.every((job) => job.conclusion === 'success'), true);
  assert.equal(hasExplicitSuccessfulStep(jobs, 'p006-skill-source-evidence.test.ts'), false);
  assert.equal(hasExplicitSuccessfulStep([{
    conclusion: 'success',
    steps: [{ name: 'node --test p006-skill-source-evidence.test.ts', conclusion: 'success' }],
  }], 'p006-skill-source-evidence.test.ts'), true);
  // A named successful step is necessary evidence, not itself proof of assertions in TAP logs.
});
