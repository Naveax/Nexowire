import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {COMPOSITION,COMPOSITION_IMPORTS,COMPOSITION_TOP_LEVEL,WINDOWS_PLAN,validateWindowsPlan,assertCoreExactTap} from '../../scripts/ci/ai08-core-authority-plan.mjs';
const blob=b=>createHash('sha1').update('blob '+b.length+'\0').update(b).digest('hex');
function tap(){
 const lines=['TAP version 13'];
 for(const [i,title] of COMPOSITION_TOP_LEVEL.entries()){
  const nested=i===13?17:i===15?8:0;
  for(let n=1;n<=nested;n++)lines.push('    ok '+n+' - nested fixture '+n);
  if(nested)lines.push('    1..'+nested);
  lines.push('ok '+(i+1)+' - '+title);
 }
 return [...lines,'1..18','# tests 43','# suites 0','# pass 43','# fail 0','# cancelled 0','# skipped 0','# todo 0',''].join('\n');
}
test('composition exact side-effect imports are pinned and not independently executed',()=>{
 validateWindowsPlan();
 const bytes=readFileSync(COMPOSITION);
 assert.equal(blob(bytes),WINDOWS_PLAN[COMPOSITION][0]);
 const imported=[...bytes.toString().matchAll(/^import '\.\.\/([^']+\.test)\.js';$/gm)].map(m=>'test/'+m[1]+'.ts');
 assert.deepEqual(imported,Object.keys(COMPOSITION_IMPORTS));
 for(const [file,p] of Object.entries(COMPOSITION_IMPORTS))assert.equal(blob(readFileSync(file)),p.blob);
 assert.equal(Object.keys(WINDOWS_PLAN).length,8);
 assert.equal(Object.values(WINDOWS_PLAN).reduce((n,p)=>n+p[1],0),70);
 assert.throws(()=>validateWindowsPlan({...WINDOWS_PLAN,[imported[0]]:[COMPOSITION_IMPORTS[imported[0]].blob,13]}),/COMPOSITION_DUPLICATE/);
 assert.throws(()=>validateWindowsPlan({...WINDOWS_PLAN,[COMPOSITION]:[WINDOWS_PLAN[COMPOSITION][0],2]}),/COMPOSITION_DUPLICATE/);
});
test('43 nested and parent TAP results, with 18 top-level entries, are accepted on LF and CRLF',()=>{
 const text=tap();
 for(const t of [text,text.replaceAll('\n','\r\n')])assert.equal(assertCoreExactTap(COMPOSITION,t,43).pass,43);
});
test('strict composition receipt rejects mismatched counts, duplicate execution, skips and missing local cases',()=>{
 const text=tap();
 assert.throws(()=>assertCoreExactTap(COMPOSITION,text,2),/EXACT_TEST_COUNT_MISMATCH/);
 assert.throws(()=>assertCoreExactTap(COMPOSITION,text+text,43),/duplicate/);
 assert.throws(()=>assertCoreExactTap(COMPOSITION,text.replace('# skipped 0','# skipped 1'),43));
 assert.throws(()=>assertCoreExactTap(COMPOSITION,text.replace('1..18','1..17'),43),/COMPOSITION_TAP_STRUCTURE/);
 assert.throws(()=>assertCoreExactTap(COMPOSITION,text.replace('ok 18 - '+COMPOSITION_TOP_LEVEL[17],'ok 18 - substituted case'),43),/COMPOSITION_TAP_STRUCTURE/);
 assert.throws(()=>assertCoreExactTap(COMPOSITION,text.replace('    ok 1 - nested fixture 1\n',''),43),/COMPOSITION_TAP_STRUCTURE/);
 assert.throws(()=>assertCoreExactTap(COMPOSITION,text.replace('# todo 0',''),43),/missing/);
});
