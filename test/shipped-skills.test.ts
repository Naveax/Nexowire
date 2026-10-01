import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
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
