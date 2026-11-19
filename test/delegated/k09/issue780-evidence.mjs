import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export const issue = 'https://github.com/Naveax/Nexowire/issues/780';
export const base = '4e7db16f4233048a956664bef6b607781eb63fb7';

// Each SHA is a Git blob observed on this exact main revision. Presence of a
// surface is *not* a claim that the whole epic, its security gates, or a real
// operator workflow has been accepted.
export const inventory = Object.freeze([
  {
    lane: 'P1-A/agent-loop',
    path: 'src/agent/task-graph-store.ts',
    blob: '2e33356713a55eb6c64fcdf313000a7f46c2241d',
    sourceEvidence: 'Durable task graph state and UNKNOWN restart classification',
    missingGate: 'No verified #780 plan/tool/observe coding loop, owner-epoch admission or crash resume acceptance',
  },
  {
    lane: 'P1-A/checkpoint',
    path: 'src/workspace/artifact-checkpoint-adapter.ts',
    blob: '465d3e61965e17b64718f3b1ffc5422b821aa146',
    sourceEvidence: 'Explicit legacy artifact checkpoint import adapter',
    missingGate: 'No verified coding task context compaction, encrypted grant binding or safe resumed mutation',
  },
  {
    lane: 'P1-B/git-ux',
    path: 'skills/git-safe-workflow/SKILL.md',
    blob: 'e3420a4fb03532f63c2bfc88f9ddd3aa6e217b8f',
    sourceEvidence: 'Guidance for safe Git inspection, staging and commit',
    missingGate: 'Guidance is not a reviewed worktree diff approval, rollback or owner/device enforced Git API',
  },
  {
    lane: 'P1-B/browser',
    path: 'src/agent/browser-control.ts',
    blob: '62e9161f200c6080821ba821ed6df2328713dc2e',
    sourceEvidence: 'Browser control source exists',
    missingGate: 'No exact-head integration/physical acceptance of #780 navigate/wait/assert/screenshot coding-agent loop',
  },
]);

export const unverifiedLanes = Object.freeze([
  'P1-A/reviewed-diff-apply-rollback',
  'P1-A/task-specific-OS-sandbox',
  'P1-B/hooks-and-subagents',
  'P1-B/audit-panel',
  'P2/cloud-runner-and-OS-parity',
]);

export function hashGitBlob(bytes) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  return createHash('sha1').update(`blob ${buffer.length}\0`).update(buffer).digest('hex');
}

export function inspectInventory(entries = inventory, root = repoRoot) {
  const seen = new Set();
  return entries.map(({ lane, path, blob, sourceEvidence, missingGate }) => {
    if (seen.has(lane)) throw new Error(`Duplicate #780 feature lane: ${lane}`);
    seen.add(lane);
    if (!/^(src\/|skills\/)[a-zA-Z0-9/_.-]+$/.test(path) || path.includes('..') || !/^[0-9a-f]{40}$/.test(blob))
      throw new Error(`Invalid source reference for ${lane}`);
    const actual = hashGitBlob(readFileSync(resolve(root, path)));
    if (actual !== blob) throw new Error(`Main source changed for ${lane}: expected ${blob}, got ${actual}`);
    if (!sourceEvidence || !missingGate) throw new Error(`Missing evidence boundary for ${lane}`);
    return { lane, path, blob, sourceEvidence, missingGate, status: 'SOURCE_SURFACE_ONLY' };
  });
}

export function reportInventory(entries = inventory, root = repoRoot) {
  return inspectInventory(entries, root).map(({ lane, path, status, missingGate }) =>
    `${lane}\t${path}\t${status}\t${missingGate}`,
  ).concat(unverifiedLanes.map((lane) => `${lane}\tNO_VERIFIED_SOURCE\tUNKNOWN\tOWNER_SCOPE_OR_TEST_NOT_RUN`)).join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write(`ISSUE ${issue}\nMAIN ${base}\n${reportInventory()}\n`);
}
