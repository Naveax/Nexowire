import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {installedTransferHelperPath,readVerifiedTransferHelperBinding,runTransferHelperLifecycle,type HelperPin,type HelperRequest,type HelperSelection,type HelperCommit,type TransferHelperArtifactStore,type TransferHelperDeploymentAuthority} from '../../src/installer/protected-transfer-helper-lifecycle.js';
const a:HelperPin={sha256:'a'.repeat(64),signerSha256:'1'.repeat(64)};
const b:HelperPin={sha256:'b'.repeat(64),signerSha256:'2'.repeat(64)};
function fixture(initial:HelperSelection={revision:'0',pin:null}){
  let selected=initial;
  const artifacts=new Set<string>();
  if(initial.pin)artifacts.add(initial.pin.sha256);
  const calls:string[]=[];
  const provisions:boolean[]=[];
  let outcome:HelperCommit='COMMITTED',readbackFailure=false;
  const store:TransferHelperArtifactStore={
    async verifyInstalled(p){calls.push('verify:'+p.sha256);if(!artifacts.has(p.sha256))throw Error('MISSING_SIGNED_ARTIFACT');},
    async stage(_source,p,provision){calls.push('stage:'+p.sha256);provisions.push(provision);artifacts.add(p.sha256);},
  };
  const authority:TransferHelperDeploymentAuthority={
    async withExclusiveQuiescedDeployment(req,effect){calls.push('admit:'+req.operation);return effect();},
    async readSelection(){if(readbackFailure&&calls.includes('commit'))throw Error('READBACK_FAILED');return selected;},
    async commitSelection(req){calls.push('commit');if(outcome==='COMMITTED'||outcome==='UNKNOWN')selected={revision:String(Number(selected.revision)+1),pin:req.desired};return outcome;},
  };
  return {store,authority,artifacts,calls,provisions,get selected(){return selected;},setOutcome(v:HelperCommit){outcome=v;},failReadback(){readbackFailure=true;}};
}
function request(operation:HelperRequest['operation'],expected:HelperSelection,desired:HelperPin|null,sourcePath?:string):HelperRequest{
  return {requestId:randomUUID(),operation,expected,desired,...(sourcePath===undefined?{}:{sourcePath})};
}
test('clean install, upgrade, rollback and detach retain both verified versions',async()=>{
  const f=fixture();
  await runTransferHelperLifecycle(request('clean-install',f.selected,a,'offline-a'),f.authority,f.store);
  await runTransferHelperLifecycle(request('upgrade',f.selected,b,'offline-b'),f.authority,f.store);
  await runTransferHelperLifecycle(request('rollback',f.selected,a),f.authority,f.store);
  const result=await runTransferHelperLifecycle(request('uninstall',f.selected,null),f.authority,f.store);
  assert.equal(result.selection.pin,null);assert.equal(result.previous.pin?.sha256,a.sha256);
  assert.equal(result.binariesRetained,true);assert.equal(result.userDataMutationRequested,false);
  assert.deepEqual([...f.artifacts],[a.sha256,b.sha256]);
  assert.equal(f.calls.filter(x=>x==='commit').length,4);
  assert.deepEqual(f.provisions,[true,false]);
});
test('stale revision is refused before staging or commit',async()=>{
  const f=fixture({revision:'2',pin:a});
  await assert.rejects(runTransferHelperLifecycle(request('upgrade',{revision:'1',pin:a},b,'offline-b'),f.authority,f.store),/STALE_SELECTION/);
  assert.deepEqual(f.calls,['admit:upgrade']);
});
test('rollback requires an already installed verified previous artifact',async()=>{
  const f=fixture({revision:'2',pin:b});
  await assert.rejects(runTransferHelperLifecycle(request('rollback',f.selected,a),f.authority,f.store),/MISSING_SIGNED_ARTIFACT/);
  assert.equal(f.calls.includes('commit'),false);
});
test('UNKNOWN after committed effect is not retried or auto-rolled back',async()=>{
  const f=fixture({revision:'2',pin:a});f.setOutcome('UNKNOWN');
  await assert.rejects(runTransferHelperLifecycle(request('upgrade',f.selected,b,'offline-b'),f.authority,f.store),/COMMIT_UNKNOWN/);
  assert.equal(f.selected.pin?.sha256,b.sha256);
  assert.equal(f.calls.filter(x=>x==='commit').length,1);assert.equal(f.artifacts.size,2);
});
test('failed readback after commit retains evidence and never retries',async()=>{
  const f=fixture({revision:'2',pin:a});f.failReadback();
  await assert.rejects(runTransferHelperLifecycle(request('upgrade',f.selected,b,'offline-b'),f.authority,f.store),/COMMIT_READBACK_UNKNOWN/);
  assert.equal(f.calls.filter(x=>x==='commit').length,1);assert.equal(f.artifacts.size,2);
});
test('rejected selection preserves previous helper and staged candidate',async()=>{
  const f=fixture({revision:'2',pin:a});f.setOutcome('REJECTED');
  await assert.rejects(runTransferHelperLifecycle(request('upgrade',f.selected,b,'offline-b'),f.authority,f.store),/COMMIT_REJECTED/);
  assert.equal(f.selected.pin?.sha256,a.sha256);assert.equal(f.artifacts.size,2);
});
test('invalid transitions and path pins do not reach admission',async()=>{
  const f=fixture();
  await assert.rejects(runTransferHelperLifecycle(request('rollback',f.selected,a),f.authority,f.store),/ROLLBACK_INVALID/);
  await assert.rejects(runTransferHelperLifecycle(request('uninstall',f.selected,null),f.authority,f.store),/UNINSTALL_INVALID/);
  assert.throws(()=>installedTransferHelperPath({sha256:'..\\x',signerSha256:a.signerSha256}),/PIN_REQUIRED/);
  assert.equal(f.calls.length,0);
  assert.equal(installedTransferHelperPath(a),'C:\\ProgramData\\Nexowire-TransferRuntime\\windows-transfer-volume-flush-'+a.sha256+'.exe');
});

test('damaged selected binary does not block authorized detach or verified rollback',async()=>{
  const detach=fixture({revision:'2',pin:a});
  detach.artifacts.delete(a.sha256);
  await runTransferHelperLifecycle(request('uninstall',detach.selected,null),detach.authority,detach.store);
  assert.equal(detach.selected.pin,null);
  assert.equal(detach.calls.some(x=>x.startsWith('verify:')),false);
  const recover=fixture({revision:'3',pin:b});
  recover.artifacts.delete(b.sha256);recover.artifacts.add(a.sha256);
  await runTransferHelperLifecycle(request('rollback',recover.selected,a),recover.authority,recover.store);
  assert.equal(recover.selected.pin?.sha256,a.sha256);
  assert.deepEqual(recover.calls.filter(x=>x.startsWith('verify:')),['verify:'+a.sha256]);
});
test('authority callback reentry cannot dispatch a second selection commit',async()=>{
  const f=fixture();
  const reenter:TransferHelperDeploymentAuthority={...f.authority,
    async withExclusiveQuiescedDeployment(_req,effect){await effect();return effect();},
  };
  await assert.rejects(runTransferHelperLifecycle(request('clean-install',f.selected,a,'offline-a'),reenter,f.store),/ADMISSION_REENTERED/);
  assert.equal(f.calls.filter(x=>x==='commit').length,1);
});
test('pin and request ID reject final newline and non-string coercions',async()=>{
  assert.throws(()=>installedTransferHelperPath({...a,sha256:a.sha256+'\n'}),/PIN_REQUIRED/);
  const f=fixture();
  await assert.rejects(runTransferHelperLifecycle({...request('clean-install',f.selected,a,'offline-a'),requestId:randomUUID()+'\n'},f.authority,f.store),/REQUEST_INVALID/);
  assert.equal(f.calls.length,0);
});

test('publisher bootstrap receives exact verified selected helper pins, never a caller path',async()=>{
  const f=fixture({revision:'3',pin:a});
  assert.deepEqual(await readVerifiedTransferHelperBinding(f.authority,f.store),{
    revision:'3',flushHelper:installedTransferHelperPath(a),flushHelperSha256:a.sha256,flushHelperSignerSha256:a.signerSha256,
  });
  assert.deepEqual(f.calls,['verify:'+a.sha256]);
});
test('publisher bootstrap denies detached, missing and changed selection',async()=>{
  const empty=fixture();
  await assert.rejects(readVerifiedTransferHelperBinding(empty.authority,empty.store),/NOT_SELECTED/);
  const f=fixture({revision:'3',pin:a});f.artifacts.delete(a.sha256);
  await assert.rejects(readVerifiedTransferHelperBinding(f.authority,f.store),/MISSING_SIGNED_ARTIFACT/);
  f.artifacts.add(a.sha256);
  let reads=0;
  await assert.rejects(readVerifiedTransferHelperBinding({
    async readSelection(){return {revision:String(++reads),pin:a};},
  },f.store),/SELECTION_CHANGED/);
});

test('non-entering authority cannot manufacture a successful deployment receipt',async()=>{
  const f=fixture();
  const authority:TransferHelperDeploymentAuthority={...f.authority,
    async withExclusiveQuiescedDeployment<T>(){return {selection:{revision:'fake',pin:a}} as T;},
  };
  await assert.rejects(runTransferHelperLifecycle(request('clean-install',f.selected,a,'offline-a'),authority,f.store),/ADMISSION_UNCONFIRMED/);
  assert.equal(f.calls.length,0);
});
test('a released deployment callback cannot commit after pending staging resolves',async()=>{
  const f=fixture();
  let release!:()=>void,started!:()=>void;
  const pending=new Promise<void>(resolve=>{release=resolve;});
  const enteredStage=new Promise<void>(resolve=>{started=resolve;});
  const store:TransferHelperArtifactStore={...f.store,
    async stage(){started();await pending;},
  };
  let deferred:Promise<unknown>|undefined;
  const authority:TransferHelperDeploymentAuthority={...f.authority,
    async withExclusiveQuiescedDeployment<T>(_request:Readonly<HelperRequest>,effect:()=>Promise<T>){
      deferred=effect();
      // Install the rejection handler before releasing the broken lease.
      void deferred.catch(()=>{});
      await enteredStage;
      return undefined as T;
    },
  };
  await assert.rejects(runTransferHelperLifecycle(request('clean-install',f.selected,a,'offline-a'),authority,store),/ADMISSION_UNCONFIRMED/);
  release();
  assert.ok(deferred);
  await assert.rejects(deferred,/DEPLOYMENT_LEASE_RELEASED/);
  assert.equal(f.calls.includes('commit'),false);
});
test('authority returning while commit is in flight is UNKNOWN, never retried',async()=>{
  const f=fixture();
  let release!:()=>void,started!:()=>void;
  const pending=new Promise<void>(resolve=>{release=resolve;});
  const enteredCommit=new Promise<void>(resolve=>{started=resolve;});
  let deferred:Promise<unknown>|undefined;
  const authority:TransferHelperDeploymentAuthority={...f.authority,
    async commitSelection(req){started();await pending;return f.authority.commitSelection(req);},
    async withExclusiveQuiescedDeployment<T>(_request:Readonly<HelperRequest>,effect:()=>Promise<T>){
      deferred=effect();void deferred.catch(()=>{});
      await enteredCommit;return undefined as T;
    },
  };
  await assert.rejects(runTransferHelperLifecycle(request('clean-install',f.selected,a,'offline-a'),authority,f.store),/COMMIT_UNKNOWN/);
  release();assert.ok(deferred);
  await assert.rejects(deferred,/COMMIT_UNKNOWN/);
  assert.equal(f.calls.filter(x=>x==='commit').length,1);
});
