import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const blobs = Object.freeze({
  'ROADMAP.md': 'c20922d7a5bf9771ea1973a537227dc7143c2906',
  'docs/SCALE_V2_ROADMAP.md': 'e91a28d44cb48ab42bf4d4802aea4203170ce5dd',
});

// Current #482 is open. This table deliberately makes distinct evidence
// dimensions visible; a source claim or success in unrelated CI is not a
// release, signed installer, authorized production rollout or real S5 soak.
export const stages = Object.freeze([
  { id: 'S1', issue: 483, requirement: 'two-PC authenticated connection' },
  { id: 'S2', issue: 484, requirement: 'daily quota and atomic accounting' },
  { id: 'S3', issue: 485, requirement: 'signed end-user installer/rollback' },
  { id: 'S4', issue: 486, requirement: 'authorized billing and entitlements' },
  { id: 'S5', issue: 487, requirement: 'measured load/cost/soak acceptance' },
]);

const hashBlob = (buffer) => createHash('sha1').update(`blob ${buffer.length}\0`).update(buffer).digest('hex');

export function auditPhaseProof(stageDoc, rootDoc) {
  const ledgerSection = stageDoc.split('### User-visible acceptance and measurement dependencies')[0];
  const map = new Map();
  for (const { id, issue, requirement } of stages) {
    const lines = ledgerSection.split('\n').filter((line) => line.startsWith(`| ${id} `));
    if (lines.length !== 1 || !lines[0].includes('NO-GO') || !lines[0].includes('PLANNED'))
      throw new Error(`${id} historical source ledger lost its explicit PLANNED / NO-GO gate`);
    if (/(^|\n)\s*- \[x\]/.test(stageDoc))
      throw new Error('S1–S5 gate checked without independent acceptance evidence');
    map.set(id, { id, issue, requirement,
      source: 'HISTORICAL_CANDIDATE', hostedCi: 'STAGE_CI_NOT_VERIFIED',
      physical: 'NOT_RUN', release: 'NOT_ESTABLISHED', decision: 'NO_GO' });
  }
  if (!rootDoc.includes('A checked item (`[x]`) is a historical source/work-tracking claim'))
    throw new Error('Historical root milestones lack their non-deployment caveat');
  if (!rootDoc.includes('DEPLOYED / ACCEPTED') || !rootDoc.includes('UNKNOWN / NOT_RUN'))
    throw new Error('Roadmap does not preserve deployment evidence boundary');
  return [...map.values()];
}

export function readCurrentPhaseProof(dir = root) {
  const texts = {};
  for (const [path, sha] of Object.entries(blobs)) {
    // Older working trees may carry a local, unpublished roadmap WIP. For
    // source comparison, use an explicitly fetched main blob if supplied;
    // SHA verification still prevents arbitrary or stale substitutions.
    const sourcePath = path === 'ROADMAP.md' && process.env.K09_ROADMAP_MAIN_SNAPSHOT
      ? process.env.K09_ROADMAP_MAIN_SNAPSHOT
      : path === 'docs/SCALE_V2_ROADMAP.md' && process.env.K09_SCALE_MAIN_SNAPSHOT
      ? process.env.K09_SCALE_MAIN_SNAPSHOT : resolve(dir, path);
    const data = readFileSync(sourcePath);
    if (hashBlob(data) !== sha) throw new Error(`Phase source changed: ${path}`);
    texts[path] = data.toString('utf8');
  }
  return auditPhaseProof(texts['docs/SCALE_V2_ROADMAP.md'], texts['ROADMAP.md']);
}

export function markdownPhaseProof(rows = readCurrentPhaseProof()) {
  const header = '| Phase / issue | Source | Exact hosted stage CI | Physical acceptance | Release / deployed | Decision |\n| --- | --- | --- | --- | --- | --- |';
  return `${header}\n${rows.map((r) => `| ${r.id} / #${r.issue} | ${r.source} | ${r.hostedCi} | ${r.physical} | ${r.release} | ${r.decision} |`).join('\n')}`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.stdout.write(`${markdownPhaseProof()}\n`);
