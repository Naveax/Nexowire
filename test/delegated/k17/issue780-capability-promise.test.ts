import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { SkillRegistry } from '../../../src/skills/registry.js';
import { parseSkillManifest } from '../../../src/skills/manifest.js';
import { CORE_CAPABILITIES } from '../../../src/protocol/capabilities.js';
import { reviewReadOnlyPromise } from './issue780-capability-promise.js';

const registry = new SkillRegistry(path.join(process.cwd(), 'skills'));

test('T-393: all 45 shipped manifests only reference known capability names', async () => {
  const validation = await registry.validate();
  assert.equal(validation.ok, true);
  assert.equal(validation.valid.length, 45);
  const known = new Set<string>(CORE_CAPABILITIES);
  const unknown = validation.valid.flatMap((skill) => [
    ...skill.requires,
    ...(skill.requiresAny ?? []).flat(),
    ...(skill.prefers ?? []),
  ].filter((capability) => !known.has(capability)).map((capability) => `${skill.name}: ${capability}`));
  assert.deepEqual(unknown, []);
});

test('T-393: read-only claims needing mutation-capable alternatives are surfaced for owner review', async () => {
  const validation = await registry.validate();
  const findings = validation.valid.flatMap(reviewReadOnlyPromise);
  assert.deepEqual(findings, [
    { skill: 'incident-triage', field: 'requiresAny', capability: 'shell.exec', group: 1 },
    { skill: 'incident-triage', field: 'requiresAny', capability: 'shell.exec', group: 2 },
    { skill: 'incident-triage', field: 'requiresAny', capability: 'shell.exec', group: 3 },
    { skill: 'network-troubleshoot', field: 'requiresAny', capability: 'shell.exec', group: 0 },
    { skill: 'network-troubleshoot', field: 'requiresAny', capability: 'shell.exec', group: 1 },
    { skill: 'tls-diagnostics', field: 'requiresAny', capability: 'shell.exec', group: 0 },
    { skill: 'tls-diagnostics', field: 'requiresAny', capability: 'shell.exec', group: 1 },
    { skill: 'verify-before-finish', field: 'prefers', capability: 'workspace.checks' },
  ]);
});

test('T-393: all required, alternative and preferred non-read-only capabilities are checked', () => {
  const skill = parseSkillManifest([
    '---',
    'name: fixture',
    'manifest_version: 2',
    'description: Read-only fixture with inconsistent capabilities.',
    'requires: shell.exec',
    'requires_any: files.read | process.start',
    'prefers: workspace.checks',
    'mutation: read-only',
    'replay: safe',
    '---',
    '# Fixture',
  ].join('\n'));
  assert.deepEqual(reviewReadOnlyPromise(skill), [
    { skill: 'fixture', field: 'requires', capability: 'shell.exec' },
    { skill: 'fixture', field: 'requiresAny', capability: 'process.start', group: 0 },
    { skill: 'fixture', field: 'prefers', capability: 'workspace.checks' },
  ]);
  assert.deepEqual(reviewReadOnlyPromise({ ...skill, mutation: 'mixed' }), []);
});
