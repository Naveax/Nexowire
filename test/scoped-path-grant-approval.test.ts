import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { ScopedPathGrantRegistry, type VolumeIdentity } from '../src/agent/scoped-path-grants.js';
import {
  ScopedPathGrantAuthority,
  ScopedGrantApprovalError,
} from '../src/agent/scoped-path-grant-approval.js';
import { PathPolicy, PathDeniedError } from '../src/agent/path-policy.js';
import { executeCapability, normalizeAgentError } from '../src/agent/executors.js';

const VOLUME: VolumeIdentity = {
  driveLetter: 'E',
  volumeId: '\\\\?\\Volume{d115da39-45b3-4a4f-8ce0-527c548d8f6d}\\',
  deviceId: 'READ_ONLY_DISK_UNIQUE_ID',
  partitionNumber: 2,
  busType: 'USB',
  driveType: 'Removable',
};

async function fixture(t: import('node:test').TestContext) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nexowire-grant-approval-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test('local approval binds verified volume GUID and exact owner/device, revocation immediate', async t => {
  const root = await fixture(t);
  const registry = new ScopedPathGrantRegistry();
  let prompted = 0;
  const authority = new ScopedPathGrantAuthority(registry, 'owner-A', 'device-A', {
    platform: 'win32',
    resolveVolume: async () => ({...VOLUME}),
    approve: async details => {
      prompted++;
      assert.equal(details.root, await fs.realpath(root));
      assert.deepEqual(details.scopes, ['write', 'usb_write']);
      assert.equal(details.volumeId, VOLUME.volumeId);
      assert.equal(details.deviceId, VOLUME.deviceId);
      return true;
    },
  });
  const result = await authority.request({
    path: root, scopes: ['write', 'usb_write'], duration_minutes: 1,
  });
  assert.equal(result.approved, true);
  assert.equal(prompted, 1);
  assert.equal(authority.status().active.length, 1);
  const p = new PathPolicy([root], {
    ownerId: 'owner-A', deviceId: 'device-A', grants: registry,
    platform: 'win32', volumeResolver: async () => ({...VOLUME}),
    defaultScopes: ['read','write'],
  });
  const destination = path.join(root,'temp.txt');
  assert.equal(await p.authorizeForCreate(destination,'write'),
    path.join(await fs.realpath(root),'temp.txt'));
  assert.equal(authority.revoke({grant_id:result.grantId}).revoked, true);
  await assert.rejects(() => p.authorizeForCreate(destination,'write'), PathDeniedError);
  assert.equal(authority.status().active.length, 0);
});

test('approval denied never creates a grant or mutates any file', async t => {
  const root = await fixture(t);
  const registry = new ScopedPathGrantRegistry();
  const authority = new ScopedPathGrantAuthority(registry,'owner','device',{
    platform:'win32',resolveVolume:async()=>VOLUME,approve:async()=>false,
  });
  const result=await authority.request({path:root,scopes:['write','usb_write']});
  assert.deepEqual(result,{approved:false,grantId:null});
  assert.deepEqual(authority.status().active,[]);
});

test('hot-unplug and swapped identity during local prompt are denied', async t => {
  const root=await fixture(t);
  for(const swapped of [
    null,
    {...VOLUME,volumeId:'\\\\?\\Volume{e116da39-45b3-4a4f-8ce0-527c548d8f6d}\\'},
    {...VOLUME,deviceId:'CHANGED_DISK'},
    {...VOLUME,partitionNumber:4},
  ]) {
    const registry=new ScopedPathGrantRegistry();
    let count=0;
    const authority=new ScopedPathGrantAuthority(registry,'owner','device',{
      platform:'win32',
      resolveVolume:async()=>++count===1?VOLUME:swapped,
      approve:async()=>true,
    });
    await assert.rejects(
      ()=>authority.request({path:root,scopes:['write','usb_write']}),
      (error:unknown)=>error instanceof ScopedGrantApprovalError &&
        error.code==='VOLUME_CHANGED_DURING_APPROVAL',
    );
    assert.deepEqual(authority.status().active,[]);
  }
});

test('rejects drive root, dangerous scope duration, non-GUID volume, and wrong media', async t => {
  const root=await fixture(t);
  const registry=new ScopedPathGrantRegistry();
  let prompted=0;
  const authority=new ScopedPathGrantAuthority(registry,'owner','device',{
    platform:'win32',resolveVolume:async()=>VOLUME,
    approve:async()=>{prompted++;return true;},
  });
  await assert.rejects(()=>authority.request({
    path:root,scopes:['recursive_delete'],duration_minutes:16,
  }), (err:unknown)=>err instanceof ScopedGrantApprovalError &&
      err.code==='GRANT_DURATION_EXCEEDED');
  await assert.rejects(()=>authority.request({
    path:path.parse(root).root,scopes:['usb_write'],
  }), ScopedGrantApprovalError);
  assert.equal(prompted,0);
  const other=new ScopedPathGrantAuthority(registry,'owner','device',{
    platform:'win32',resolveVolume:async()=>({...VOLUME,busType:'NVMe',driveType:'Fixed'}),
    approve:async()=>{prompted++;return true;},
  });
  await assert.rejects(()=>other.request({path:root,scopes:['usb_write']}),
    (err:unknown)=>err instanceof ScopedGrantApprovalError &&
      err.code==='USB_VOLUME_REQUIRED');
  const invalid=new ScopedPathGrantAuthority(registry,'owner','device',{
    platform:'win32',resolveVolume:async()=>({...VOLUME,volumeId:'unstable-id'}),
    approve:async()=>{prompted++;return true;},
  });
  await assert.rejects(()=>invalid.request({path:root,scopes:['usb_write']}),
    (err:unknown)=>err instanceof ScopedGrantApprovalError &&
      err.code==='VOLUME_IDENTITY_UNAVAILABLE');
  assert.equal(prompted,0);
});

test('untrusted junction root is refused even with affirmative mock approval', async t => {
  const dir=await fixture(t);
  const source=path.join(dir,'real-root');
  const link=path.join(dir,'junction-link');
  await fs.mkdir(source);
  try {
    await fs.symlink(source,link,process.platform==='win32'?'junction':'dir');
  } catch (e) {t.skip(String(e));return;}
  let prompt=0;
  const authority=new ScopedPathGrantAuthority(new ScopedPathGrantRegistry(),'o','d',{
    platform:'win32',resolveVolume:async()=>VOLUME,
    approve:async()=>{prompt++;return true;},
  });
  await assert.rejects(()=>authority.request({path:link,scopes:['write']}),
    (err:unknown)=>err instanceof ScopedGrantApprovalError &&
      err.code==='REPARSE_ROOT_DENIED');
  assert.equal(prompt,0);
});

test('Native Agent dispatcher accepts only console-approved grants; shell and WSL remain denied', async t => {
  const root=await fixture(t);
  const registry=new ScopedPathGrantRegistry();
  const authority=new ScopedPathGrantAuthority(registry,'o','d',{
    platform:'win32',resolveVolume:async()=>VOLUME,approve:async()=>false,
  });
  const policy=new PathPolicy([root],{
    grants:registry,ownerId:'o',deviceId:'d',
    platform:'win32',volumeResolver:async()=>VOLUME,
    defaultScopes:['read','write'],
  });
  const result=await executeCapability('files.grant.request',{
    path:root,scopes:['write','usb_write'],
  },policy,{scopedGrantAuthority:authority}) as {data:{approved:boolean}};
  assert.equal(result.data.approved,false);
  const list=await executeCapability('files.grant.status',{},policy,
    {scopedGrantAuthority:authority}) as {data:{active:unknown[]}};
  assert.equal(list.data.active.length,0);
  for (const name of ['shell.exec','wsl.exec','process.start','task.graph.run','runbook.run','workspace.checks'] as const) {
    await assert.rejects(()=>executeCapability(name, {command:'echo deny'}, policy),
      (err:unknown)=>name === 'wsl.exec' && process.platform !== 'win32'
        ? err instanceof Error && /only available from a Windows native agent/.test(err.message)
        : err instanceof PathDeniedError &&
          err.details.reason==='UNSANDBOXED_EXECUTION_DENIED',
      name);
  }
});

test('PATH_DENIED is policy refusal; Windows EPERM/EACCES retain true OS attribution', () => {
  const policyDenied=normalizeAgentError(new PathDeniedError('C:\\restricted','SCOPE_NOT_GRANTED','write'));
  assert.equal(policyDenied.code,'PATH_DENIED');
  assert.equal((policyDenied.details as {reason:string}).reason,'SCOPE_NOT_GRANTED');
  for (const code of ['EPERM','EACCES'] as const) {
    const native=Object.assign(new Error('Access is denied'), {
      code,syscall:'open',path:'C:\\restricted',
    });
    const result=normalizeAgentError(native);
    assert.equal(result.code,code);
    assert.equal((result.details as {reason:string}).reason,'OS_FILESYSTEM_PERMISSION_DENIED');
    assert.notEqual(result.code,policyDenied.code);
  }
});

test('junction retargeted during console approval cannot mint a grant', async t => {
  const dir = await fixture(t);
  const root = path.join(dir, 'original');
  const replacement = path.join(dir, 'replacement');
  await fs.mkdir(root);
  await fs.mkdir(replacement);
  let mutated=false;
  const registry=new ScopedPathGrantRegistry();
  const authority=new ScopedPathGrantAuthority(registry,'owner','device',{
    platform:'win32',
    resolveVolume:async()=>VOLUME,
    approve:async()=>{
      await fs.rename(root,path.join(dir,'original-moved'));
      try { await fs.symlink(replacement,root,process.platform==='win32'?'junction':'dir'); }
      catch(error) { t.diagnostic('Cannot create junction for this runner: '+String(error)); }
      mutated=true;
      return true;
    },
  });
  await assert.rejects(()=>authority.request({
    path:root,scopes:['write','usb_write'],
  }));
  assert.equal(mutated,true);
  assert.equal(authority.status().active.length,0);
});

test('removing path after approval denies issuance instead of granting stale permissions', async t=>{
  const dir=await fixture(t);
  const root=path.join(dir,'approved-folder');
  await fs.mkdir(root);
  const registry=new ScopedPathGrantRegistry();
  const authority=new ScopedPathGrantAuthority(registry,'owner','device',{
    platform:'win32',resolveVolume:async()=>VOLUME,
    approve:async()=>{await fs.rename(root,path.join(dir,'moved-folder'));return true;},
  });
  await assert.rejects(()=>authority.request({path:root,scopes:['usb_write']}));
  assert.deepEqual(authority.status().active,[]);
});

test('request cannot inject owner or disk identity through remote payload', async t=>{
  const root=await fixture(t);
  const authority=new ScopedPathGrantAuthority(new ScopedPathGrantRegistry(),'o','d',{
    platform:'win32',resolveVolume:async()=>VOLUME,
    approve:async()=>true,
  });
  await assert.rejects(()=>authority.request({
    path:root,scopes:['usb_write'],ownerId:'victim',
  }));
  await assert.rejects(()=>authority.request({
    path:root,scopes:['usb_write'],volume:{...VOLUME},
  }));
});
