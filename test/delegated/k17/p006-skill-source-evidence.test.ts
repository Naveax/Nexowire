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

test('T-632: REGRESSION GUARD — direct registry load rejects an external symlink, as listing already does', {
  skip: false,
}, async () => {
  await withCatalog(async (root) => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'nexowire-k17-p006-outside-'));
    try {
      await fs.writeFile(path.join(outside, 'SKILL.md'), source('linked-skill'));
      await fs.symlink(outside, path.join(root, 'linked-skill'), process.platform === 'win32' ? 'junction' : 'dir');
      const registry = new SkillRegistry(root);
      assert.deepEqual(await registry.list(), [], 'ordinary discovery omits symlinked directories');
      assert.deepEqual((await registry.validate()).valid, []);
      await assert.rejects(() => registry.load('linked-skill'), /regular directory|escapes/,
        'Direct load must reject a symlinked skill directory, not just ordinary discovery');
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });
});

test('P010: a junction or directory symlink cannot bypass direct load or post-validation read', async () => {
  await withCatalog(async (root) => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'nexowire-k17-p010-outside-'));
    const name = 'bounded-directory';
    const entry = path.join(root, name);
    const linkType = process.platform === 'win32' ? 'junction' : 'dir';
    try {
      await fs.writeFile(path.join(outside, 'SKILL.md'), `${source(name)}\nEXTERNAL_CONTENT`);
      await fs.symlink(outside, entry, linkType);
      const registry = new SkillRegistry(root);
      assert.deepEqual(await registry.list(), [], 'discovery must ignore external links');
      await assert.rejects(() => registry.load(name), /regular directory|escapes/,
        'direct load must not read the external manifest');

      await fs.rm(entry, { recursive: true, force: true });
      await fs.mkdir(entry);
      await fs.writeFile(path.join(entry, 'SKILL.md'), source(name));
      assert.equal((await registry.validate()).ok, true, 'ordinary in-catalog skill remains valid');
      await fs.rename(entry, path.join(root, 'retired-before-swap'));
      await fs.symlink(outside, entry, linkType);
      await assert.rejects(() => registry.read(name), /regular directory|escapes/,
        'a prior successful validation cannot authorize a later link replacement');
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });
});

test('D-097: REGRESSION GUARD — a regular skill directory rejects a symlinked SKILL.md', {
  skip: process.platform === 'win32' ? 'Windows file symlink privileges are not established' : false,
}, async () => {
  await withCatalog(async (root) => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'nexowire-k17-p007-outside-'));
    try {
      const skillDir = path.join(root, 'linked-manifest');
      await fs.mkdir(skillDir);
      await fs.writeFile(path.join(outside, 'SKILL.md'), source('linked-manifest'));
      await fs.symlink(path.join(outside, 'SKILL.md'), path.join(skillDir, 'SKILL.md'));

      const registry = new SkillRegistry(root);
      await assert.rejects(() => registry.load('linked-manifest'), /regular file/);
      const validation = await registry.validate();
      assert.deepEqual(validation.valid, [], 'Validation must not accept an external linked manifest');
      assert.equal(validation.errors.length, 1);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });
});

test('P007 followup: REGRESSION GUARD — a later manifest read revalidates the file', {
  skip: process.platform === 'win32' ? 'Windows file symlink privileges are not established' : false,
}, async () => {
  await withCatalog(async (root) => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'nexowire-k17-swapped-manifest-'));
    try {
      const skillDir = path.join(root, 'swapped-manifest');
      const manifestFile = path.join(skillDir, 'SKILL.md');
      const outsideFile = path.join(outside, 'SKILL.md');
      await fs.mkdir(skillDir);
      await fs.writeFile(manifestFile, source('swapped-manifest'));
      const registry = new SkillRegistry(root);

      // A trusted initial check says nothing about the path used by a future read.
      assert.equal((await registry.validate()).ok, true);
      await fs.writeFile(outsideFile, `${source('swapped-manifest')}\nEXTERNAL_READ_MARKER`);
      await fs.unlink(manifestFile);
      await fs.symlink(outsideFile, manifestFile);

      await assert.rejects(() => registry.read('swapped-manifest'), /regular file/,
        'A previously validated manifest cannot authorize a later symlink swap');
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });
});

test('P008 R-097/R-099: REGRESSION GUARD — a directory swap after validation is rejected before read', {
  skip: false,
}, async () => {
  await withCatalog(async (root) => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'nexowire-k17-p008-outside-'));
    try {
      const name = 'swapped-directory';
      const skillDir = path.join(root, name);
      const parkedDir = path.join(root, 'parked-before-read');
      await fs.mkdir(skillDir);
      await fs.writeFile(path.join(skillDir, 'SKILL.md'), source(name));
      const registry = new SkillRegistry(root);

      assert.deepEqual((await registry.validate()).valid.map((skill) => skill.name), [name]);
      await fs.writeFile(
        path.join(outside, 'SKILL.md'),
        `${source(name)}\nEXTERNAL_DIRECTORY_MARKER`,
      );

      // A *directory entry* replacement, distinct from the prior SKILL.md swap.
      // It proves only a gap between separate validate() and read() calls.
      await fs.rename(skillDir, parkedDir);
      await fs.symlink(outside, skillDir, process.platform === 'win32' ? 'junction' : 'dir');

      await assert.rejects(() => registry.read(name), /regular directory|escapes/,
        'A previously validated directory cannot authorize a later symlink swap');
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
