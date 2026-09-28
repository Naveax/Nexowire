import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { SkillRegistry } from '../src/skills/registry.js';

test('skill registry loads metadata lazily', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nexowire-skill-'));
  const dir = path.join(root, 'repo-resume');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'SKILL.md'), '---\nname: repo-resume\ndescription: Resume repository work safely.\n---\n# Skill\n');
  const registry = new SkillRegistry(root);
  assert.deepEqual(await registry.list(), [{ name: 'repo-resume', description: 'Resume repository work safely.' }]);
  assert.match(await registry.read('repo-resume'), /# Skill/);
  await assert.rejects(() => registry.read('../escape'));
});
