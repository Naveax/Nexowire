import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {assertTapSummary} from '../../scripts/ci/assert-tap-summary.mjs';

function report({tests=41,pass=tests,fail=0,cancelled=0,skipped=0,todo=0}={}) {
  return ['TAP version 13', `1..${tests}`, `# tests ${tests}`,
    `# pass ${pass}`, `# fail ${fail}`, `# cancelled ${cancelled}`,
    `# skipped ${skipped}`, `# todo ${todo}`, ''].join('\n');
}

test('accepts exact historical K20 baseline and a greater genuine PASS count',()=>{
  assert.equal(assertTapSummary(report(),41).tests,41);
  assert.equal(assertTapSummary(report({tests:52}),41).pass,52);
});
test('rejects truncated fixture below the minimum test count',()=>{
  assert.throws(()=>assertTapSummary(report({tests:40}),41),/minimum|count/i);
  assert.throws(()=>assertTapSummary(report({tests:0}),1),/minimum|count/i);
});
test('rejects nonzero failing, skipped and todo assertions',()=>{
  assert.throws(()=>assertTapSummary(report({pass:40,fail:1}),41),/fail|pass/i);
  assert.throws(()=>assertTapSummary(report({pass:40,skipped:1}),41),/skip|pass/i);
  assert.throws(()=>assertTapSummary(report({pass:40,todo:1}),41),/todo|pass/i);
  assert.throws(()=>assertTapSummary(report({pass:40,cancelled:1}),41),/cancel|pass/i);
});
test('rejects mismatched pass count and missing TAP summary lines',()=>{
  assert.throws(()=>assertTapSummary(report({pass:40}),41),/pass|count/i);
  assert.throws(()=>assertTapSummary(report().replace('# todo 0',''),41),/todo|missing/i);
});
test('rejects duplicate or ambiguous TAP summaries',()=>{
  assert.throws(()=>assertTapSummary(report()+report(),41),/duplicate|multiple/i);
  assert.throws(()=>assertTapSummary(report().replace('# tests 41','# tests x'),41),/tests|missing/i);
});
test('CLI validates both Bash UTF-8 TAP and Windows PowerShell 5.1 UTF-16LE TAP',()=>{
  const root=mkdtempSync(join(tmpdir(),'nw-tap-contract-'));
  try{
    const cli=fileURLToPath(new URL('../../scripts/ci/assert-tap-summary.mjs',import.meta.url));
    const raw=report({tests:70});
    const samples=[
      ['bash.tap',Buffer.from(raw,'utf8')],
      ['powershell51.tap',Buffer.concat([Buffer.from([0xff,0xfe]),Buffer.from(raw,'utf16le')])],
    ];
    for(const [name,data] of samples){
      const file=join(root,name);
      writeFileSync(file,data);
      const result=spawnSync(process.execPath,[cli,file,'57'],{encoding:'utf8'});
      assert.equal(result.status,0,name+': '+result.stderr);
      assert.match(result.stdout,/70\/70 PASS/);
    }
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('CI explicitly runs all newly merged #1135 S5 tests without a frozen TAP total',()=>{
  const yaml=readFileSync(new URL('../../.github/workflows/ci.yml',import.meta.url),'utf8');
  const s5=yaml.slice(yaml.indexOf('name: Verify isolated S5'),
    yaml.indexOf('name: Verify delegated K06'));
  for(const file of ['issue-487-commercial-unknown.test.ts',
    'issue-487-meter-acceptance.test.ts','p005-s5-evidence.test.ts']){
    assert.match(s5,new RegExp('test/delegated/k11/'+file.replaceAll('.','\\.')));
  }
  assert.match(s5,/node scripts\/ci\/assert-tap-summary\.mjs/);
  assert.doesNotMatch(s5,/grep -qx '# (tests|pass) 57'/);
});

test('CI checks K20 with dynamic validated TAP and explicitly invokes this regression',()=>{
  const yaml=readFileSync(new URL('../../.github/workflows/ci.yml',import.meta.url),'utf8');
  const k20=yaml.slice(yaml.indexOf('name: Verify delegated K20'),
    yaml.indexOf('name: Verify delegated K14'));
  assert.match(k20,/node scripts\/ci\/assert-tap-summary\.mjs/);
  assert.match(k20,/test\/ci\/assert-tap-summary\.test\.mjs/);
  assert.doesNotMatch(k20,/grep -qx '# (tests|pass) 41'/);
});
