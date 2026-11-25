import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';

const script=path.join(process.cwd(),'scripts','smoke-windows-user-setup.ts');
function run(bundle:string,args:string[]){
  assert.equal(existsSync(bundle),false,'negative fixture must not exist');
  const result=spawnSync(process.execPath,['--import','tsx',script,'--bundle-dir',
    bundle,'--download-source','github',...args],{
    cwd:process.cwd(),encoding:'utf8',timeout:30000,windowsHide:true,
  });
  assert.equal(result.error,undefined);
  assert.equal(result.signal,null);
  assert.equal(typeof result.status,'number');
  assert.notEqual(result.status,0);
  assert.equal(existsSync(bundle),false);
  return result;
}
function absentBundle(t:TestContext):string{
  const dir=mkdtempSync(path.join(tmpdir(),'nx-bootstrap-pin-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  return path.join(dir,'missing-bundle');
}
test('public bootstrap verification requires explicit commit pin, rejects absent and invalid SHA',{
  skip:process.platform!=='win32',
},t=>{
  const bundle=absentBundle(t);
  for(const args of [[],['--public-source-sha','main'],
    ['--public-source-sha','../../../evil'],
    ['--public-source-sha','a'.repeat(39)],
    ['--public-source-sha','Z'.repeat(40)]]){
    const r=run(bundle,args);
    assert.match(r.stderr,/immutable exact GitHub commit SHA/);
    assert.doesNotMatch(r.stderr,/ENOENT/);
  }
});
test('public bootstrap accepts bounded SHA syntax then reaches exact missing-bundle gate',{
  skip:process.platform!=='win32',
},t=>{
  const bundle=absentBundle(t);
  const r=run(bundle,['--public-source-sha','a'.repeat(40)]);
  assert.doesNotMatch(r.stderr,/immutable exact GitHub commit SHA/);
  assert.match(r.stderr,/ENOENT/);
  assert.match(r.stderr,/missing-bundle[\\/]+(?:Nexowire-Setup\.cmd|SHA256SUMS-Windows)/);
});
