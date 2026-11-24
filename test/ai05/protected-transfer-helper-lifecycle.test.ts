import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {installedTransferHelperPath,runTransferHelperLifecycle,type HelperPin,type HelperRequest,type HelperSelection,type HelperCommit,type TransferHelperArtifactStore,type TransferHelperDeploymentAuthority} from '../../src/installer/protected-transfer-helper-lifecycle.js';
const a:HelperPin={sha256:'a'.repeat(64),signerSha256:'1'.repeat(64)};
const b:HelperPin={sha256:'b'.repeat(64),signerSha256:'2'.repeat(64)};
function fixture(initial:HelperSelection={revision:'0',pin:null}){
  let selected=initial;
  const artifacts=new Set<string>();
  if(initial.pin)artifacts.add(initial.pin.sha256);
  const calls:string[]=[];
  let outcome:HelperCommit='COMMITTED',readbackFailure=false;
  const store:TransferHelperArtifactStore={
    async verifyInstalled(p){calls.push('verify:'+p.sha256);if(!artifacts.has(p.sha256))throw Error('MISSING_SIGNED_ARTIFACT');},
    async stage(_source,p){calls.push('stage:'+p.sha256);artifacts.add(p.sha256);},
  };
  const authority:TransferHelperDeploymentAuthority={
    async withExclusiveQuiescedDeployment(req,effect){calls.push('admit:'+req.operation);return effect();},
    async readSelection(){if(readbackFailure&&calls.includes('commit'))throw Error('READBACK_FAILED');return selected;},
    async commitSelection(req){calls.push('commit');if(outcome==='COMMITTED'||outcome==='UNKNOWN')selected={revision:String(Number(selected.revision)+1),pin:req.desired};return outcome;},
  };
  return {store,authority,artifacts,calls,get selected(){return selected;},setOutcome(v:HelperCommit){outcome=v;},failReadback(){readbackFailure=true;}};
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
  assert.equal(result.binariesRetained,true);assert.equal(result.userDataChanged,false);
  assert.deepEqual([...f.artifacts],[a.sha256,b.sha256]);
  assert.equal(f.calls.filter(x=>x==='commit').length,4);
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
