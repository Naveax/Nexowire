/** AI-06: verify every recorded 243-row candidate blob against the *actual* commit tree. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
function csv(raw: string): string[][] {
  const rows: string[][] = [];
  let current: string[] = [], field = '', quote = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    if (quote) {
      if (ch === '"' && raw[i + 1] === '"') {field += '"'; i++;}
      else if (ch === '"') quote = false;
      else field += ch;
    } else if (ch === '"') quote = true;
    else if (ch === ',') {current.push(field); field = '';}
    else if (ch === '\n') {
      current.push(field); if (current.some(Boolean)) rows.push(current);
      current = []; field = '';
    } else if (ch !== '\r') field += ch;
  }
  assert.equal(quote, false, 'Unterminated CSV quote');
  if (field || current.length) {current.push(field); rows.push(current);}
  return rows;
}
function commitBlobs(): Map<string, string> {
  const raw = execFileSync('git', ['ls-tree', '-r', '-z', 'HEAD']);
  const blobs = new Map<string,string>();
  for (const entry of raw.toString('utf8').split('\0').filter(Boolean)) {
    const match = /^\d+ blob ([a-f0-9]{40})\t(.+)$/.exec(entry);
    if (match) blobs.set(match[2]!, match[1]!);
  }
  return blobs;
}
test('243-row AI-05 CORE/Connection v2 matrix matches exact committed candidate Git blobs',()=>{
  const rows = csv(readFileSync(resolve('docs/coord/AI05_CORE_CONNECTION_V2_PRESERVATION.csv'),'utf8'));
  assert.deepEqual(rows.shift(), [
    'source', 'source_sha', 'path', 'source_blob_sha', 'integrated_blob_sha', 'classification']);
  assert.equal(rows.length,243,'No missing or silently added provenance rows');
  const blobs = commitBlobs();
  const byPath = new Map<string,string>();
  const SHA=/^[a-f0-9]{40}$/;
  for (const row of rows) {
    assert.equal(row.length,6,'Provenance row schema changed');
    const [source, sourceSha, path, original, integrated, classification] = row;
    assert.ok(source && SHA.test(sourceSha!), 'Missing source commit');
    assert.ok(SHA.test(original!) && SHA.test(integrated!), 'Missing full Git blob ID');
    assert.ok(path && !path.startsWith('/') && !path.includes('..') && !path.includes('\\'), 'Unsafe blob path');
    assert.equal(blobs.get(path!), integrated, 'Recorded candidate blob changed: ' + path);
    const prior=byPath.get(path!);
    if (prior) assert.equal(prior, integrated, 'Conflicting candidate blobs: ' + path);
    byPath.set(path!, integrated!);
    assert.ok(['EXACT_SOURCE_BLOB','EVOLVED','REFRESHED_1077_REVIEW_REQUIRED',
      'EXACT_LATEST_SECURITY_BLOB'].includes(classification!),
      'Unreviewed classification: ' + classification);
    if (classification === 'EXACT_SOURCE_BLOB')
      assert.equal(original, integrated,'Untrue exact source claim: '+path);
  }
  assert.equal(byPath.size,239,'Unexpected duplicate or missing path inventory');
});
