import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { SkillRegistry } from '../../../src/skills/registry.js';
import { parseSkillManifest } from '../../../src/skills/manifest.js';
import {
  auditLocalMarkdownLinks,
  auditSkillMetadata,
  auditUnsafeInstructions,
} from './skill-metadata-audit.js';

const root = process.cwd();
const skillsDir = path.join(root, 'skills');

const validSkill = (name: string): string => [
  '---',
  `name: ${name}`,
  'description: Inspects a repository safely with explicit evidence.',
  'version: 0.1',
  'requires: files.read',
  'platforms: any',
  'mutation: read-only',
  '---',
  `# ${name.split('-').map((part) => part[0]?.toUpperCase() + part.slice(1)).join(' ')}`,
  '',
].join('\n');

test('T-097: shipped skill manifest paths and H1 titles agree', async () => {
  const registry = new SkillRegistry(skillsDir);
  const validation = await registry.validate();
  assert.deepEqual(validation.errors, []);

  const entries = await fs.readdir(skillsDir, { withFileTypes: true });
  const issues: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const markdown = await fs.readFile(
      path.join(skillsDir, entry.name, 'SKILL.md'), 'utf8',
    );
    issues.push(...auditSkillMetadata(entry.name, markdown).map((issue) => issue.detail));
  }
  assert.ok(entries.length > 0, 'A missing skills directory cannot pass this audit');
  assert.deepEqual(issues, []);
});

test('T-097/T-098: malformed path, missing H1 and duplicate metadata are rejected', () => {
  assert.deepEqual(auditSkillMetadata('repo-inspect', validSkill('repo-inspect')), []);

  const wrongName = validSkill('repo-inspect').replace(
    'name: repo-inspect', 'name: different-name',
  );
  assert.ok(auditSkillMetadata('repo-inspect', wrongName).some(
    (issue) => issue.code === 'directory-name',
  ));

  const missingTitle = validSkill('repo-inspect').replace('# Repo Inspect', '## Repo Inspect');
  assert.ok(auditSkillMetadata('repo-inspect', missingTitle).some(
    (issue) => issue.code === 'title-path',
  ));

  const duplicateName = validSkill('repo-inspect').replace(
    'name: repo-inspect', 'name: repo-inspect\nname: repo-inspect',
  );
  assert.ok(auditSkillMetadata('repo-inspect', duplicateName).some(
    (issue) => issue.code === 'frontmatter-field',
  ));
  assert.throws(
    () => parseSkillManifest(duplicateName, 'repo-inspect'),
    /Duplicate skill frontmatter field: name/,
  );

  const invalidName = validSkill('repo-inspect').replace(
    'name: repo-inspect', 'name: ../repo-inspect',
  );
  assert.ok(auditSkillMetadata('repo-inspect', invalidName).some(
    (issue) => issue.code === 'invalid-manifest',
  ));
});

test('T-099: missing or low-quality description appears in a schema-quality report', () => {
  const missingDescription = validSkill('repo-inspect').replace(
    'description: Inspects a repository safely with explicit evidence.\n', '',
  );
  const shortDescription = validSkill('repo-inspect').replace(
    'Inspects a repository safely with explicit evidence.', 'Short.',
  );
  assert.ok(auditSkillMetadata('repo-inspect', missingDescription).some(
    (issue) => issue.code === 'frontmatter-field',
  ));
  assert.ok(auditSkillMetadata('repo-inspect', shortDescription).some(
    (issue) => issue.code === 'description-quality',
  ));
});

test('T-100: explicit permission-bypass instructions are flagged, safety warnings are not', () => {
  const unsafe = [
    '# Risky',
    '- Bypass authentication to make the workflow pass.',
    '2. Disable permission checks before running.',
    'Run as administrator without approval.',
  ].join('\n');
  assert.deepEqual(
    auditUnsafeInstructions(unsafe).map((issue) => issue.code),
    ['unsafe-instruction', 'unsafe-instruction', 'unsafe-instruction'],
  );
  assert.deepEqual(auditUnsafeInstructions([
    'Do not bypass authentication.',
    '- Never disable security checks.',
    '```sh',
    '# skip permission checks (illustrative example only)',
    '```',
  ].join('\n')), []);
});

test('T-100/T-101: shipped skill instructions and offline Markdown links are clean', async () => {
  const entries = await fs.readdir(skillsDir, { withFileTypes: true });
  const issues: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const file = path.join(skillsDir, entry.name, 'SKILL.md');
    const markdown = await fs.readFile(file, 'utf8');
    issues.push(...auditUnsafeInstructions(markdown).map((issue) => `${file}: ${issue.detail}`));
    issues.push(...(await auditLocalMarkdownLinks(file, markdown, root)).map((issue) => issue.detail));
  }
  assert.deepEqual(issues, []);
});

test('T-101: links to absent files, absent anchors, unsafe schemes and paths outside repo fail', async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'nexowire-k17-links-'));
  try {
    const source = path.join(temporary, 'SKILL.md');
    const target = path.join(temporary, 'guide.md');
    await fs.writeFile(target, '# Available Topic\n', 'utf8');
    const markdown = [
      '# My Skill',
      '[own heading](#my-skill)',
      '[local](guide.md#available-topic)',
      '[remote](https://example.invalid/ignored)',
      '[broken](missing.md)',
      '[bad anchor](guide.md#unavailable)',
      '[bad own anchor](#not-there)',
      '[bad scheme](file:///etc/passwd)',
      '[escape](../outside.md)',
    ].join('\n');
    await fs.writeFile(source, markdown, 'utf8');
    const issues = await auditLocalMarkdownLinks(source, markdown, temporary);
    assert.deepEqual(issues.map((issue) => issue.code), [
      'link-missing', 'link-anchor', 'link-anchor', 'link-scheme', 'link-outside-repo',
    ]);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});
