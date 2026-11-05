import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {promises as fs} from 'node:fs';
import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {OFFICIAL_CLOUDFLARED_SHA256,prepareTrustedCloudflared} from '../src/mcp/cloudflare-binary-trust.js';

const official=OFFICIAL_CLOUDFLARED_SHA256['win32-x64'];
function probe(helper:string,mode:'--probe'|'--race',file:string,sha:string){
  const run=spawnSync(helper,[mode,file,sha],{
    timeout:30000,windowsHide:true,encoding:'utf8',maxBuffer:4096,
  });
  assert.equal(run.error,undefined,'native probe subprocess must complete');
  return run;
}
function rejectAt(helper:string,mode:'--probe'|'--race',file:string,sha:string,stage:RegExp){
  const result=probe(helper,mode,file,sha);
  assert.notEqual(result.status,0,'native guard must reject the adversarial fixture');
  assert.match(result.stderr,stage,'native guard rejection must be stage-specific');
}
test('CLEAN-13 P1-A Windows native FileIdInfo proof remains suspended and never resumes',{
  skip:process.platform!=='win32',timeout:90000,
},async t=>{
  const binary=process.env.NEXOWIRE_CLOUDFLARED_TEST_BINARY;
  const helper=process.env.NEXOWIRE_CLOUDFLARED_IMAGE_PROBE;
  assert.ok(binary,'official SHA-pinned Windows image must be provisioned on runner');
  assert.ok(helper,'MSVC native probe must be built from reviewed source on runner');
  assert.equal(createHash('sha256').update(await fs.readFile(binary)).digest('hex'),official);
  const positive=probe(helper,'--probe',binary,official);
  assert.equal(positive.status,0,positive.stderr);
  assert.match(positive.stdout,/NEXOWIRE_C13_NATIVE_PROBE=OK/);
  for(const marker of ['held_sha256=1','held_file_id=1','process_path_file_id=1',
    'suspended=1','resumed=0'])assert.ok(positive.stdout.includes(marker),marker);
  // Disposable copy only: deliberately attempt overwrite, rename, deletion
  // with same-owner privileges while the native helper holds the trusted file.
  const dir=await fs.mkdtemp(path.join(os.homedir(),'nw-c13-image-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true,maxRetries:8,retryDelay:100}));
  const copy=path.join(dir,'signed-copy.exe');
  await fs.copyFile(binary,copy);
  const race=probe(helper,'--race',copy,official);
  assert.equal(race.status,0,race.stderr);
  assert.match(race.stdout,/write_delete_lock=1/);
  assert.equal(createHash('sha256').update(await fs.readFile(copy)).digest('hex'),official,
    'simulated same-owner swaps must not modify held source');

  // An extra hardlink must be detected by actual native link count, not only
  // Node lstat() metadata or an arbitrary error before identity inspection.
  const hardlink=path.join(dir,'extra-link.exe');
  await fs.link(copy,hardlink);
  rejectAt(helper,'--probe',copy,official,/stage=SOURCE_LINK_OR_ID/);
  await fs.unlink(hardlink);

  // A symbolic-link executable is rejected at the leaf reparse point.
  const symbolic=path.join(dir,'symbolic.exe');
  await fs.symlink(copy,symbolic,'file');
  rejectAt(helper,'--probe',symbolic,official,/stage=SOURCE_OPEN_REPARSE/);

  // A junction redirects an ancestor, not the executable leaf.
  const junction=path.join(dir,'junction');
  await fs.symlink(dir,junction,'junction');
  rejectAt(helper,'--probe',path.join(junction,'signed-copy.exe'),official,
    /stage=ANCESTOR_OR_ARGUMENT/);

  const tampered=path.join(dir,'tampered.exe');
  await fs.writeFile(tampered,'not cloudflared');
  rejectAt(helper,'--probe',tampered,official,/stage=SOURCE_SHA/);

  // Independent signed-publisher check must still culminate in a fail-closed
  // native launcher denial. The test probe does not grant launch authority.
  await assert.rejects(prepareTrustedCloudflared(binary,official),
    /native signed handle custodian/);
});
