import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {readCloudflareTunnelCredential} from '../src/mcp/cloudflare-credential-custody.js';

const ICACLS='C:\\Windows\\System32\\icacls.exe';
const WHOAMI='C:\\Windows\\System32\\whoami.exe';
function cmd(exe:string,args:string[]){
  const r=spawnSync(exe,args,{encoding:'utf8',windowsHide:true,timeout:20000,maxBuffer:4096});
  assert.equal(r.status,0,'disposable Windows ACL fixture command failed');
}
function sid(){
  const r=spawnSync(WHOAMI,['/user','/fo','csv','/nh'],{
    encoding:'utf8',windowsHide:true,timeout:15000,maxBuffer:4096});
  assert.equal(r.status,0);
  const match=r.stdout.match(/S-1-5-\d+(?:-\d+)+/);
  assert.ok(match,'authenticated Windows SID unavailable');
  return match[0];
}
test('CLEAN-13 P1-D Windows exact SID, inherited ACE and parent replacement rights',{
  skip:process.platform!=='win32',
  timeout:90000,
},async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'nexowire-clean13-win-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:200}));
  const file=path.join(dir,'fake-tunnel.json');
  await fs.writeFile(file,'{"fake":true}',{mode:0o600});
  const user=sid();
  // These ACL changes affect only test-owned temporary fixtures.
  for(const target of [dir,file])
    cmd(ICACLS,[target,'/inheritance:r','/grant:r',
      '*'+user+':(F)','*S-1-5-18:(F)','*S-1-5-32-544:(F)']);
  const good=await readCloudflareTunnelCredential(file);
  assert.equal(good.toString('utf8'),'{"fake":true}');

  cmd(ICACLS,[file,'/grant','*S-1-5-11:(R)']);
  await assert.rejects(readCloudflareTunnelCredential(file),/credential custody unsafe/);
  cmd(ICACLS,[file,'/remove:g','*S-1-5-11']);
  assert.equal((await readCloudflareTunnelCredential(file)).toString('utf8'),'{"fake":true}');

  // A world-readable file may be masked by a private parent. Parent writes
  // must be denied independently to block rename/replace attacks.
  cmd(ICACLS,[dir,'/grant','*S-1-5-32-545:(M)']);
  await assert.rejects(readCloudflareTunnelCredential(file),/credential custody unsafe/);
});
