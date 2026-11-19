/** The combined Windows candidate must keep round2 provenance and AI-03 Windows QA on its exact HEAD. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function parseCsv(raw: string): string[][] {
  const rows: string[][] = [];
  let cells: string[] = [];
  let value = '';
  let quoted = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    if (quoted) {
      if (ch === '"' && raw[i + 1] === '"') { value += '"'; i++; }
      else if (ch === '"') quoted = false;
      else value += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { cells.push(value); value = ''; }
    else if (ch === '\n') {
      cells.push(value);
      if (cells.some(Boolean)) rows.push(cells);
      cells = []; value = '';
    } else if (ch !== '\r') value += ch;
  }
  assert.equal(quoted, false, 'unterminated provenance CSV quote');
  if (value || cells.length) { cells.push(value); rows.push(cells); }
  return rows;
}

function committedBlobs(): Map<string, string> {
  const files = new Map<string, string>();
  for (const item of execFileSync('git', ['ls-tree', '-r', '-z', 'HEAD'])
    .toString('utf8').split('\0').filter(Boolean)) {
    const match = /^\d+ blob ([a-f0-9]{40})\t(.+)$/.exec(item);
    if (match) files.set(match[2]!, match[1]!);
  }
  return files;
}

test('Round2 290-source preservation rows match exact integrated Git blob IDs', () => {
  const rows = parseCsv(readFileSync(resolve('docs/coord/AI05_ROUND2_SOURCE_PRESERVATION.csv'), 'utf8'));
  assert.deepEqual(rows.shift(), [
    'source', 'source_sha', 'path_or_gate', 'source_blob_sha',
    'candidate_blob_sha', 'classification', 'proof',
  ]);
  assert.equal(rows.length, 290, 'do not remove original provenance entries');
  const blobs = committedBlobs();
  const byPath = new Map<string, string>();
  const SHA = /^[a-f0-9]{40}$/;
  let deniedGates = 0;
  for (const row of rows) {
    assert.equal(row.length, 7, 'round2 provenance row schema');
    const [source, sourceSha, target, original, candidate, classification, proof] = row;
    assert.ok(source && target && classification && proof, 'incomplete provenance row');
    if (target!.startsWith('gate://')) {
      assert.equal(source, 'RELEASE_GATE');
      assert.equal(sourceSha, 'N/A');
      assert.equal(original, 'N/A');
      assert.equal(candidate, 'N/A');
      assert.equal(classification, 'MISSING');
      deniedGates++;
      continue;
    }
    assert.match(sourceSha!, SHA);
    assert.ok(original === 'EVOLVED' || SHA.test(original!), 'invalid original source evidence');
    assert.match(candidate!, SHA);
    assert.ok(!target!.startsWith('/') && !target!.includes('..') && !target!.includes('\\'));
    assert.equal(blobs.get(target!), candidate, 'stale integrated candidate blob: ' + target);
    const earlier = byPath.get(target!);
    if (earlier) assert.equal(candidate, earlier, 'conflicting candidate path evidence: ' + target);
    byPath.set(target!, candidate!);
    if (classification === 'EXACT_SOURCE_BLOB') assert.equal(original, candidate,
      'false source equality: ' + target);
  }
  assert.ok(deniedGates >= 2, 'physical release gates must remain NO-GO');
});

test('AI-03 Windows authority workflow includes both Windows integration PR branches', () => {
  const yaml = readFileSync(resolve('.github/workflows/ai03-windows-authority.yml'), 'utf8');
  const condition = /^\s{4}if:\s*(.+)$/m.exec(yaml)?.[1];
  assert.ok(condition, 'AI-03 Windows workflow must have an explicit job condition');
  for (const prefix of ['integration/workpc-windows-recovery-', 'integration/ai01-ai06-candidate-']) {
    assert.ok(condition.includes("startsWith(github.head_ref, '" + prefix + "')"),
      'AI-03 exact-HEAD Windows job does not run for ' + prefix);
  }
  assert.ok(condition.includes("github.head_ref == 'agent/ai03-core-broker-repair'"),
    'retain direct AI-03 branch acceptance');
});
