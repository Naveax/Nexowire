import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function rows(raw: string): string[][] {
  const output: string[][] = [];
  let cells: string[] = [], value = '', quoted = false;
  for (let i=0; i<raw.length; i++) {
    const ch = raw[i];
    if (quoted) {
      if (ch === '"' && raw[i+1] === '"') { value += '"'; i++; }
      else if (ch === '"') quoted = false;
      else value += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { cells.push(value); value=''; }
    else if (ch === '\n') { cells.push(value); if (cells.length>1) output.push(cells); cells=[]; value=''; }
    else if (ch !== '\r') value += ch;
  }
  assert.equal(quoted,false,'CSV quote left open');
  return output;
}
const sha=(buffer: Buffer): string =>
  createHash('sha1').update('blob '+buffer.length+'\0').update(buffer).digest('hex');
test('candidate preserves each recorded source path at its expected Git blob',() => {
  const matrix=rows(readFileSync(resolve('docs/connection-v2/source-preservation-matrix.csv'),'utf8'));
  assert.deepEqual(matrix.shift(),['source_pr','source_head','path','source_blob','candidate_blob','status','notes']);
  assert.equal(matrix.length,79);
  for (const id of ['1003','1044','1074','1075','1077','1081','1083','1084']) assert.ok(matrix.some(row=>row[0]===id),id+' missing');
  for(const row of matrix) {
    assert.equal(row.length,7,'matrix schema mismatch');
    const id = row[0]!;
    const path = row[2]!;
    const original = row[3]!;
    const expected = row[4]!;
    const status = row[5]!;
    assert.ok(!path.startsWith('/')&&!path.includes('..'),'unsafe path');
    const checkoutBytes=readFileSync(resolve(path));
    // .gitattributes enforces CRLF for *.ps1 in the working tree. Git stores
    // normalized LF blobs; compare Git-canonical bytes, not checkout EOL bytes.
    // Non-newline changes still alter SHA and fail this release gate.
    const canonical=path.toLowerCase().endsWith('.ps1')
      ? Buffer.from(checkoutBytes.toString('utf8').replace(/\r\n/g,'\n'),'utf8')
      : checkoutBytes;
    assert.equal(sha(canonical),expected,id+': blob changed '+path);
    if(status==='EXACT_BLOB')assert.equal(original,expected,id+': false exact claim '+path);
  }
});
test('unverified physical/security release conditions cannot be green',()=>{
  const e=JSON.parse(readFileSync(resolve('docs/connection-v2/staging-evidence.json'),'utf8'));
  assert.equal(e.verdict,'NO_GO');
  assert.equal(e.production_modified,false);
  assert.equal(e.acceptance.mcp_offnetwork_oauth_readonly,'NOT_RUN');
  assert.equal(e.acceptance.two_pc_read_only,'NOT_RUN');
  assert.equal(e.git.git_merge_tree,'NOT_RUN');
});
