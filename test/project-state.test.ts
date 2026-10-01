import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import {
  parseProjectState,
  validateProjectState,
} from '../src/continuation/project-state.js';

test('repository continuation state validates against current files', async () => {
  const result = await validateProjectState(process.cwd());
  assert.equal(result.state.project, 'Nexowire');
  assert.equal(result.state.canonicalBranch, 'main');
  assert.equal(result.state.runtimeOwnership, 'first-party-only');
  assert.ok(result.checkedFiles.includes('HANDOFF.md'));
  assert.ok(
    result.checkedFiles.includes('docs/CONTINUATION.md'),
  );
});

test('project-state parser rejects duplicate priorities and unsorted priority order', () => {
  const base = {
    schemaVersion: 1,
    project: 'Nexowire',
    canonicalRepository: 'Naveax/Nexowire',
    canonicalBranch: 'main',
    runtimeOwnership: 'first-party-only',
    continuationFiles: [
      'docs/CONTINUATION.md',
      'HANDOFF.md',
      'ROADMAP.md',
      'PROJECT_STATE.json',
    ],
    invariants: ['test'],
    priorities: [
      {
        id: 'second',
        status: 'partial',
        priority: 2,
        summary: 'second',
      },
      {
        id: 'first',
        status: 'done',
        priority: 1,
        summary: 'first',
      },
    ],
    standardVerification: ['npm test'],
    hotFiles: ['HANDOFF.md'],
    notes: [],
    lastStateSync: '2026-10-01',
    lastVerifiedMain: 'a'.repeat(40),
    activeWork: [],
  };

  assert.throws(
    () => parseProjectState(base),
    /priorities must stay sorted/,
  );

  assert.throws(
    () =>
      parseProjectState({
        ...base,
        priorities: [
          {
            id: 'same',
            status: 'done',
            priority: 1,
            summary: 'a',
          },
          {
            id: 'same',
            status: 'partial',
            priority: 2,
            summary: 'b',
          },
        ],
      }),
    /priority ids contains duplicate/,
  );
});

test('continuation validation fails when a declared source-of-truth file is missing', async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'nexowire-continuation-'),
  );

  try {
    await fs.mkdir(path.join(root, 'docs'), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(root, 'docs', 'CONTINUATION.md'),
      [
        'docs/CONTINUATION.md',
        'HANDOFF.md',
        'ROADMAP.md',
        'PROJECT_STATE.json',
      ].join('\n'),
      'utf8',
    );
    await fs.writeFile(
      path.join(root, 'HANDOFF.md'),
      'Canonical branch: `main`\n## Resume protocol\n',
      'utf8',
    );
    await fs.writeFile(
      path.join(root, 'ROADMAP.md'),
      '# roadmap\n',
      'utf8',
    );

    const state = {
      schemaVersion: 1,
      project: 'Nexowire',
      canonicalRepository: 'Naveax/Nexowire',
      canonicalBranch: 'main',
      runtimeOwnership: 'first-party-only',
      continuationFiles: [
        'docs/CONTINUATION.md',
        'HANDOFF.md',
        'ROADMAP.md',
        'PROJECT_STATE.json',
      ],
      invariants: ['test'],
      priorities: [
        {
          id: 'one',
          status: 'partial',
          priority: 1,
          summary: 'one',
        },
      ],
      standardVerification: ['npm test'],
      hotFiles: ['HANDOFF.md'],
      notes: [],
      lastStateSync: '2026-10-01',
      lastVerifiedMain: 'b'.repeat(40),
      activeWork: [],
    };
    await fs.writeFile(
      path.join(root, 'PROJECT_STATE.json'),
      JSON.stringify(state, null, 2),
      'utf8',
    );

    await assert.rejects(
      () => validateProjectState(root),
      /PROJECT_STATE\.json|ENOENT/,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
