import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { auditPhaseProof, markdownPhaseProof, readCurrentPhaseProof } from './scale-phase-proof.mjs';

const stage = readFileSync(new URL('../../../docs/SCALE_V2_ROADMAP.md', import.meta.url), 'utf8');
const root = readFileSync(new URL('../../../ROADMAP.md', import.meta.url), 'utf8');

test('#482: five stages, each with separate source, CI, physical, release, decision columns', () => {
  const rows = readCurrentPhaseProof();
  assert.deepEqual(rows.map((row) => row.id), ['S1', 'S2', 'S3', 'S4', 'S5']);
  assert.deepEqual(rows.map((row) => row.issue), [483, 484, 485, 486, 487]);
  assert.deepEqual(rows.map((row) => row.decision), Array(5).fill('NO_GO'));
  assert.deepEqual(rows.map((row) => row.physical), Array(5).fill('NOT_RUN'));
});

test('removing NO-GO from S3 cannot silently promote an installer', () => {
  const modified = stage.replace(/(\| S3 installer \|[^\n]*)/, (line) => line.replace('NO-GO', 'PASS'));
  assert.notEqual(modified, stage);
  assert.throws(() => auditPhaseProof(modified, root), /S3 historical source ledger lost/);
});

test('duplicate or missing S5 row fails closed', () => {
  const row = stage.split('\n').find((line) => line.startsWith('| S5 scale/cost |'));
  assert.ok(row);
  assert.throws(() => auditPhaseProof(stage.replace(row, `${row}\n${row}`), root), /S5 historical source ledger lost/);
  assert.throws(() => auditPhaseProof(stage.replace(row, ''), root), /S5 historical source ledger lost/);
});

test('checked gate and missing historical caveat do not imply deployment', () => {
  assert.throws(() => auditPhaseProof(stage.replace('- [ ] Lock policy version:', '- [x] Lock policy version:'), root), /gate checked/);
  assert.throws(() => auditPhaseProof(stage, root.replace('A checked item (`[x]`) is a historical source/work-tracking claim', 'DONE')), /Historical root milestones/);
});

test('a source blob change invalidates this dated table', () => {
  assert.equal(readCurrentPhaseProof().length, 5);
  assert.match(markdownPhaseProof(), /STAGE_CI_NOT_VERIFIED/);
  assert.equal(markdownPhaseProof().split('\n').length, 7);
  assert.doesNotMatch(markdownPhaseProof(), /\| PASS \||DEPLOYED_OK/);
});
