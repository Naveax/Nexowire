import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';

// Temporary source-only CI diagnostic. The owner workflow redirects the
// delegated TAP to a temp file then exits under bash -e before printing it.
// This mirrored invocation exposes the *actual* failing assertion on our
// isolated Draft PR. It must be removed after the root cause is established.
// No Windows task, physical device, credentials or production DB is accessed.
test('AI-06 diagnostic: full delegated lane emits redacted failing TAP evidence',()=>{
  const workflow=readFileSync('.github/workflows/ci.yml','utf8');
  const name='- name: Verify reviewed delegated source and transfer tests (explicit files)';
  const start=workflow.indexOf(name);
  assert.ok(start>=0,'delegated lane absent from current checkout');
  const next=workflow.indexOf('\n      - name:',start+name.length);
  const block=workflow.slice(start,next>=0?next:undefined);
  const paths:string[]=[];
  let capturing=false;
  for(const line of block.split('\n')){
    if(line.includes('node --test --test-reporter=tap')){
      capturing=true;
      continue;
    }
    if(!capturing)continue;
    if(line.trim().startsWith('> "$RUNNER_TEMP'))break;
    const hit=line.match(/\b((?:test|scripts)\/[\w./-]+\.test\.(?:mjs|ts))\b/);
    if(hit)paths.push(hit[1]!);
  }
  assert.ok(paths.length>=45&&paths.length<=80,
    'delegated lane inventory unexpectedly changed: '+paths.length);

  const child=spawnSync(process.execPath,
    ['--test','--test-reporter=tap','--import','tsx','--test-concurrency=1',...paths],{
      cwd:process.cwd(),encoding:'utf8',timeout:180_000,
      maxBuffer:8*1024*1024,
      env:{...process.env,CI:'true'},
    });
  const output=child.stdout??'';
  const failures=[...output.matchAll(/^not ok\s+\d+.*$/gm)].map(match=>{
    const begin=match.index??0;
    return output.slice(begin,Math.min(output.length,begin+1300));
  });
  const summary=output.split('\n').filter(line=>/^# (?:tests|pass|fail|cancelled|skipped|todo)\s/.test(line)).join(' / ');
  const diagnostics='files='+paths.length+' exit='+child.status+
    ' signal='+child.signal+' summary='+summary+
    '\nfailed cases (bounded):\n'+failures.slice(0,6).join('\n')+
    '\nlast TAP lines:\n'+output.slice(-1800)+
    '\nchild stderr:\n'+(child.stderr??'').slice(-1000);
  assert.equal(child.error,undefined,
    'full delegated diagnostic could not run: '+String(child.error));
  assert.equal(child.signal,null,
    'full delegated diagnostic was interrupted: '+diagnostics);
  assert.equal(child.status,0,diagnostics);
  assert.match(output,/(?:^|\n)# tests 409(?:\r?\n|$)/,
    'delegated tests were not all discovered: '+diagnostics);
});
