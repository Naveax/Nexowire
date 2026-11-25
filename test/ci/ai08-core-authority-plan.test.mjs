import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {COMPOSITION,COMPOSITION_IMPORTS,COMPOSITION_TOP_LEVEL,WINDOWS_PLAN,validateWindowsPlan,assertCoreExactTap} from '../../scripts/ci/ai08-core-authority-plan.mjs';
const blob=b=>createHash('sha1').update('blob '+b.length+'\0').update(b).digest('hex');
function tap(){
 const lines=['TAP version 13'];
 for(const [i,title] of COMPOSITION_TOP_LEVEL.entries()){
  const nested=i===14?17:i===16?8:0;
  for(let n=1;n<=nested;n++)lines.push('    ok '+n+' - nested fixture '+n);
  if(nested)lines.push('    1..'+nested);
  lines.push('ok '+(i+1)+' - '+title);
 }
 return [...lines,'1..19','# tests 44','# suites 0','# pass 44','# fail 0','# cancelled 0','# skipped 0','# todo 0',''].join('\n');
}
test('composition exact side-effect imports are pinned and not independently executed',()=>{
 validateWindowsPlan();
 const bytes=readFileSync(COMPOSITION);
 assert.equal(blob(bytes),WINDOWS_PLAN[COMPOSITION][0]);
 const imported=[...bytes.toString().matchAll(/^import '\.\.\/([^']+\.test)\.js';$/gm)].map(m=>'test/'+m[1]+'.ts');
 assert.deepEqual(imported,Object.keys(COMPOSITION_IMPORTS));
 for(const [file,p] of Object.entries(COMPOSITION_IMPORTS))assert.equal(blob(readFileSync(file)),p.blob);
 assert.equal(Object.keys(WINDOWS_PLAN).length,8);
 assert.equal(Object.values(WINDOWS_PLAN).reduce((n,p)=>n+p[1],0),71);
 assert.throws(()=>validateWindowsPlan({...WINDOWS_PLAN,[imported[0]]:[COMPOSITION_IMPORTS[imported[0]].blob,14]}),/COMPOSITION_DUPLICATE/);
 assert.throws(()=>validateWindowsPlan({...WINDOWS_PLAN,[COMPOSITION]:[WINDOWS_PLAN[COMPOSITION][0],2]}),/COMPOSITION_DUPLICATE/);
});
test('44 nested and parent TAP results, with 19 top-level entries, are accepted on LF and CRLF',()=>{
 const text=tap();
 for(const t of [text,text.replaceAll('\n','\r\n')])assert.equal(assertCoreExactTap(COMPOSITION,t,44).pass,44);
});
test('strict composition receipt rejects mismatched counts, duplicate execution, skips and missing local cases',()=>{
 const text=tap();
 assert.throws(()=>assertCoreExactTap(COMPOSITION,text,2),/EXACT_TEST_COUNT_MISMATCH/);
 assert.throws(()=>assertCoreExactTap(COMPOSITION,text+text,44),/duplicate/);
 assert.throws(()=>assertCoreExactTap(COMPOSITION,text.replace('# skipped 0','# skipped 1'),44));
 assert.throws(()=>assertCoreExactTap(COMPOSITION,text.replace('1..19','1..17'),44),/COMPOSITION_TAP_STRUCTURE/);
 assert.throws(()=>assertCoreExactTap(COMPOSITION,text.replace('ok 19 - '+COMPOSITION_TOP_LEVEL[18],'ok 19 - substituted case'),44),/COMPOSITION_TAP_STRUCTURE/);
 assert.throws(()=>assertCoreExactTap(COMPOSITION,text.replace('    ok 1 - nested fixture 1\n',''),44),/COMPOSITION_TAP_STRUCTURE/);
 assert.throws(()=>assertCoreExactTap(COMPOSITION,text.replace('# todo 0',''),44),/missing/);
});
