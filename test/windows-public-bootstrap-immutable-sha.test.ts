import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import path from 'node:path';

const script=path.join(process.cwd(),'scripts','smoke-windows-user-setup.ts');
function run(args:string[]){
  return spawnSync(process.execPath,['--import','tsx',script,'--bundle-dir',
    path.join(process.cwd(),'does-not-exist-bootstrap-smoke-fixture'),
    '--download-source','github',...args],{
    cwd:process.cwd(),encoding:'utf8',timeout:15000,windowsHide:true,
  });
}
test('public bootstrap verification requires explicit commit pin, rejects absent and invalid SHA',()=>{
  const examples=[[],['--public-source-sha','main'],
    ['--public-source-sha','../../../evil'],
    ['--public-source-sha','a'.repeat(39)],
    ['--public-source-sha','Z'.repeat(40)]];
  for(const args of examples){
    const r=run(args);
    assert.notEqual(r.status,0,'Malformed source SHA cannot pass');
    assert.match(r.stderr,/immutable exact GitHub commit SHA/,
      'Expected fail-closed before filesystem or network');
  }
});
test('public bootstrap accepts bounded SHA syntax then reaches separate fixture gate',()=>{
  const r=run(['--public-source-sha','a'.repeat(40)]);
  assert.notEqual(r.status,0,'Missing fixture must fail');
  assert.doesNotMatch(r.stderr,/immutable exact GitHub commit SHA/);
});
