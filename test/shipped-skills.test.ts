import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { SkillRegistry } from '../src/skills/registry.js';

const EXPECTED_V3_SKILLS = [
  'backup-restore',
  'browser-workflow-recovery',
  'large-file-investigation',
  'log-triage',
  'performance-triage',
  'port-conflict',
  'safe-config-migration',
  'tls-diagnostics',
  'verify-before-finish',
  'windows-screenshot',
] as const;

const EXPECTED_MANIFEST_V2_SKILLS = [
  'fast-repo-inspect',
  'incident-triage',
  'large-file-investigation',
  'log-triage',
  'network-troubleshoot',
  'performance-triage',
  'tls-diagnostics',
] as const;

const EXPECTED_V2_SKILLS = [
  'application-repair',
  'dependency-install',
  'deploy-verify',
  'disk-space-recovery',
  'git-safe-workflow',
  'incident-triage',
  'machine-bootstrap',
  'process-debug',
  'project-bootstrap',
  'service-debug',
] as const;

const EXPECTED_DOMAIN_READ_ONLY_V2_SKILLS = [
  'artifact-integrity-audit',
  'backup-integrity-audit',
  'browser-session-inspection',
  'configuration-drift-audit',
  'service-readiness-audit',
] as const;

const EXPECTED_DOMAIN_MIXED_V2_SKILLS = [
  'release-readiness-audit',
  'workspace-regression-triage',
] as const;

test('shipped skill library has valid machine-readable manifests', async () => {
  const registry = new SkillRegistry(
    path.join(process.cwd(), 'skills'),
  );
  const validation = await registry.validate();

  assert.deepEqual(
    validation.errors,
    [],
    'Every shipped skill directory must have a valid manifest.',
  );
  assert.equal(validation.ok, true);

  const names = validation.valid.map((skill) => skill.name);
  for (const name of [
    ...EXPECTED_V2_SKILLS,
    ...EXPECTED_V3_SKILLS,
    ...EXPECTED_DOMAIN_READ_ONLY_V2_SKILLS,
    ...EXPECTED_DOMAIN_MIXED_V2_SKILLS,
  ]) {
    assert.ok(
      names.includes(name),
      'Expected shipped skill is missing: ' + name,
    );
  }

  for (const skill of validation.valid) {
    assert.ok(skill.requires.length > 0, skill.name);
    assert.ok(skill.platforms.length > 0, skill.name);
    assert.ok(skill.tags.length > 0, skill.name);
  }

  for (const name of EXPECTED_MANIFEST_V2_SKILLS) {
    const skill = validation.valid.find(
      (candidate) => candidate.name === name,
    );
    assert.ok(skill, 'Expected manifest-v2 skill is missing: ' + name);
    assert.equal(skill?.manifestVersion, 2, name);
    assert.equal(skill?.concurrency, 'parallel-safe', name);
    assert.equal(skill?.replay, 'safe', name);
    assert.equal(skill?.mutation, 'read-only', name);
  }
});

test('domain recipes declare explicit replay and concurrency semantics', async () => {
  const registry = new SkillRegistry(
    path.join(process.cwd(), 'skills'),
  );

  for (const name of EXPECTED_DOMAIN_READ_ONLY_V2_SKILLS) {
    const loaded = await registry.load(name);
    assert.equal(loaded.manifest.manifestVersion, 2, name);
    assert.equal(loaded.manifest.mutation, 'read-only', name);
    assert.equal(loaded.manifest.concurrency, 'parallel-safe', name);
    assert.equal(loaded.manifest.replay, 'safe', name);
  }

  for (const name of EXPECTED_DOMAIN_MIXED_V2_SKILLS) {
    const loaded = await registry.load(name);
    assert.equal(loaded.manifest.manifestVersion, 2, name);
    assert.equal(loaded.manifest.mutation, 'mixed', name);
    assert.equal(loaded.manifest.concurrency, 'serial', name);
    assert.equal(loaded.manifest.replay, 'verify', name);
  }

  const artifact = await registry.load('artifact-integrity-audit');
  assert.ok(
    artifact.manifest.requires.includes('task.artifact.verify'),
  );

  const browser = await registry.load('browser-session-inspection');
  assert.ok(
    browser.manifest.prefers?.includes('browser.visual.verify'),
  );

  const configuration = await registry.load('configuration-drift-audit');
  assert.ok(configuration.manifest.requires.includes('files.hash'));

  const regression = await registry.load('workspace-regression-triage');
  assert.ok(
    regression.manifest.requires.includes('workspace.checks'),
  );
});

test('documented shipped skill index matches the validated library', async () => {
  const registry = new SkillRegistry(
    path.join(process.cwd(), 'skills'),
  );
  const validation = await registry.validate();
  assert.equal(validation.ok, true);

  const markdown = await fs.readFile(
    path.join(process.cwd(), 'docs', 'SKILLS.md'),
    'utf8',
  );
  const section = markdown.match(
    /## Current shipped skills\n\n([\s\S]*?)\n\n## Operational recipe set/,
  );
  const documentedSection = section?.[1];
  assert.ok(documentedSection, 'Current shipped skills section is missing.');

  const documented = Array.from(
    documentedSection.matchAll(/^- `([^`]+)`$/gm),
    (match) => match[1],
  ).sort();
  const actual = validation.valid.map((skill) => skill.name).sort();

  assert.deepEqual(documented, actual);
});

test('Windows-only shipped skills are excluded from Linux runnability', async () => {
  const registry = new SkillRegistry(
    path.join(process.cwd(), 'skills'),
  );
  const skills = await registry.list({
    platform: 'linux',
    capabilities: [
      'machine.health',
      'process.list',
      'network.dns.resolve',
      'network.tcp.probe',
      'network.http.probe',
      'shell.exec',
      'workspace.detect',
      'workspace.snapshot',
      'files.read_many',
      'files.write',
      'files.mkdir',
      'files.stat',
      'files.list',
      'files.delete',
      'search.text',
      'runbook.run',
      'task.graph.run',
      'verify.assertions',
    ],
  });

  const processDebug = skills.find(
    (skill) => skill.name === 'process-debug',
  );
  const incident = skills.find(
    (skill) => skill.name === 'incident-triage',
  );

  assert.equal(
    processDebug?.evaluation?.platformCompatible,
    false,
  );
  assert.equal(incident?.evaluation?.platformCompatible, true);
  assert.equal(incident?.evaluation?.runnable, true);
});


test('event-driven-control does not pretend process creation is replay-safe', async () => {
  const registry = new SkillRegistry(
    path.join(process.cwd(), 'skills'),
  );
  const loaded = await registry.load('event-driven-control');

  assert.equal(loaded.manifest.manifestVersion, 2);
  assert.equal(loaded.manifest.mutation, 'mixed');
  assert.equal(loaded.manifest.concurrency, 'serial');
  assert.equal(loaded.manifest.replay, 'manual');
  assert.ok(
    loaded.manifest.requires.includes('process.start'),
  );
  assert.notEqual(loaded.manifest.replay, 'safe');
});
