import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {readCloudflareTunnelCredential} from '../src/mcp/cloudflare-credential-custody.js';
import {prepareTrustedCloudflared,stageDescriptorBoundImage,OFFICIAL_CLOUDFLARED_SHA256} from '../src/mcp/cloudflare-binary-trust.js';

const digest=(data:Buffer|string)=>createHash('sha256').update(data).digest('hex');
async function root(t:import('node:test').TestContext){
  const name=await fs.mkdtemp(path.join(os.tmpdir(),'nexowire-clean13-'));
  t.after(()=>fs.rm(name,{recursive:true,force:true,maxRetries:6,retryDelay:100}));
  return name;
}
test('CLEAN-13 P1-B: profile-controlled SHA cannot bless a non-Cloudflare executable',async t=>{
  const dir=await root(t),file=path.join(dir,'foreign-image');
  await fs.copyFile(process.execPath,file);
  const ownDigest=digest(await fs.readFile(file));
  assert.notEqual(ownDigest,OFFICIAL_CLOUDFLARED_SHA256['linux-x64']);
  assert.notEqual(ownDigest,OFFICIAL_CLOUDFLARED_SHA256['win32-x64']);
  await assert.rejects(prepareTrustedCloudflared(file,ownDigest),/publisher|provenance|platform/i);
});
test('CLEAN-13 P1-B: mismatched profile hash cannot be treated as official publisher',async t=>{
  const dir=await root(t),file=path.join(dir,'bad-image');
  await fs.writeFile(file,'not an approved binary');
  await assert.rejects(prepareTrustedCloudflared(file,'a'.repeat(64)),
    /checksum mismatch|platform/i);
});
test('CLEAN-13 P1-A: source executable symlink and hardlink aliases fail closed',{
  skip:process.platform==='win32',
},async t=>{
  const dir=await root(t),source=path.join(dir,'binary');
  const alias=path.join(dir,'alias'),sym=path.join(dir,'symlink');
  await fs.writeFile(source,'#!/bin/sh\nexit 0\n',{mode:0o700});
  await fs.link(source,alias);
  const sha=digest(await fs.readFile(source));
  await assert.rejects(prepareTrustedCloudflared(source,sha),/hardlink|unsafe/i);
  await fs.unlink(alias);
  await fs.symlink(source,sym);
  await assert.rejects(prepareTrustedCloudflared(sym,sha),/path|unsafe/i);
});
test('CLEAN-13 P1-A: descriptor exec cannot be redirected by atomic stage pathname swap',{
  skip:process.platform!=='linux',
  timeout:15000,
},async t=>{
  const dir=await root(t),marker=path.join(dir,'marker');
  const good=Buffer.from('#!/bin/sh\nprintf approved > '+JSON.stringify(marker)+'\n');
  const sealed=await stageDescriptorBoundImage(good,digest(good));
  t.after(()=>sealed.dispose());
  const target=await fs.readlink('/proc/self/fd/'+sealed.imageFd);
  const swapped=path.join(dir,'attacker-replacement');
  await fs.writeFile(swapped,'#!/bin/sh\nprintf replaced > '+JSON.stringify(marker)+'\n',{mode:0o500});
  await fs.rename(swapped,target);
  const run=spawnSync(sealed.command,[],{
    stdio:['ignore','ignore','ignore',sealed.imageFd],timeout:5000,encoding:'utf8',
  });
  assert.equal(run.status,0,run.error?.message);
  assert.equal(await fs.readFile(marker,'utf8'),'approved',
    'replacement path must not redirect inherited executable descriptor');
});
test('CLEAN-13 P1-D: descriptor custody requires 0600, sole owner and no link aliases',{
  skip:process.platform==='win32',
},async t=>{
  const dir=await root(t),file=path.join(dir,'fake-tunnel.json');
  await fs.writeFile(file,'{"synthetic":true}',{mode:0o600});
  assert.equal((await readCloudflareTunnelCredential(file)).toString('utf8'),'{"synthetic":true}');
  for(const mode of [0o640,0o644,0o666]){
    await fs.chmod(file,mode);
    await assert.rejects(readCloudflareTunnelCredential(file),/credential custody unsafe/);
  }
  await fs.chmod(file,0o600);
  const linked=path.join(dir,'linked.json');
  await fs.link(file,linked);
  await assert.rejects(readCloudflareTunnelCredential(file),/credential custody unsafe/);
  await fs.unlink(linked);
  const sym=path.join(dir,'alias.json');
  await fs.symlink(file,sym);
  await assert.rejects(readCloudflareTunnelCredential(sym),/credential custody unsafe/);
  await fs.chmod(dir,0o777);
  await assert.rejects(readCloudflareTunnelCredential(file),/credential custody unsafe/);
});
test('CLEAN-13 P1-D: pathname replacement does not silently approve a credential',{
  skip:process.platform==='win32',
},async t=>{
  const dir=await root(t),file=path.join(dir,'credential.json');
  await fs.writeFile(file,'old',{mode:0o600});
  const alternate=path.join(dir,'replacement.json');
  await fs.writeFile(alternate,'new',{mode:0o644});
  await fs.rename(alternate,file);
  await assert.rejects(readCloudflareTunnelCredential(file),/credential custody unsafe/);
});

test('CLEAN-13 P1-A: production sealed image has no pathname or hardlink alias',{
  skip:process.platform!=='linux',timeout:15000,
},async t=>{
  const dir=await root(t),marker=path.join(dir,'unlinked-marker');
  const original=Buffer.from('#!/bin/sh\nprintf sealed > '+JSON.stringify(marker)+'\n');
  const sealed=await stageDescriptorBoundImage(original,digest(original),true);
  t.after(()=>sealed.dispose());
  const name=await fs.readlink('/proc/self/fd/'+sealed.imageFd);
  assert.match(name,/\(deleted\)$/,'production file identity must be open-only');
  const run=spawnSync(sealed.command,[],{
    stdio:['ignore','ignore','ignore',sealed.imageFd],timeout:5000,encoding:'utf8',
  });
  assert.equal(run.status,0,run.error?.message);
  assert.equal(await fs.readFile(marker,'utf8'),'sealed');
});
