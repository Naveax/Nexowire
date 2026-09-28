import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { WorkspaceStore } from '../src/workspace/store.js';

test('workspace checkpoints survive save/get/list', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nexowire-state-'));
  const store = new WorkspaceStore(root);
  const saved = await store.save({ deviceId: 'device-1', workspaceId: 'project-a', cwd: '/tmp/project-a', summary: 'Initial checkpoint', completed: ['inspect repository'], remaining: ['run tests'], lastCommands: ['git status'] });
  assert.deepEqual(await store.get('device-1', 'project-a'), saved);
  const list = await store.list();
  assert.equal(list.length, 1);
  assert.equal(list[0]?.workspaceId, 'project-a');
});
