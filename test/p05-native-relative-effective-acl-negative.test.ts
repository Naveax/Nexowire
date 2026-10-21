import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertEffectiveNativeAcl,authorizeNativeRelativeChain,
  RelativeAccessDenied,type NativeEffectiveAcl,
} from '../src/agent/windows-native-relative-access.js';
import {assertNativeProtectedFileBoundary,NativeFileBoundaryError} from '../src/agent/windows-native-file-source-boundary.js';
import {syntheticProtectedBoundary,syntheticNativeHandle,
  syntheticEffectiveAcl,syntheticSource,syntheticDestination} from './p05-native-boundary-fixtures.js';

const relativeError=(code:string)=>(e:unknown)=>e instanceof RelativeAccessDenied&&e.code===code;
const protectedDenied=(e:unknown)=>e instanceof NativeFileBoundaryError;

test('effective DACL witness allows read-only untrusted ACE but never untrusted effective mutation',()=>{
  const fixture=syntheticProtectedBoundary();
  const target=fixture.protectedComponents.module.handle;
  assert.doesNotThrow(()=>assertEffectiveNativeAcl(fixture.protectedComponents.module.effectiveAcl,target));
  for(const rights of [0x2,0x4,0x10,0x40,0x100,0x10000,0x40000,0x80000,0x40000000,0x10000000,0x02000000]){
    const acl=syntheticEffectiveAcl(target.fileId);
    acl.aces=[...acl.aces,{sid:'S-1-5-11',type:'allow',accessMask:rights,inheritOnly:false}];
    assert.throws(()=>assertEffectiveNativeAcl(acl,target),
      relativeError('NATIVE_EFFECTIVE_UNTRUSTED_WRITE'),'mask '+rights);
  }
});

test('effective ACL denies inherited future write ACE, owner substitution and forged result',()=>{
  const fixture=syntheticProtectedBoundary();
  const target=fixture.protectedComponents.parent.handle;
  const changes=[
    (x:NativeEffectiveAcl)=>{x.provider='unavailable';},
    (x:NativeEffectiveAcl)=>{x.observedFileId='replaced-after-ACL';},
    (x:NativeEffectiveAcl)=>{x.ownerSid='S-1-5-11';},
    (x:NativeEffectiveAcl)=>{x.daclProtected=false;},
    (x:NativeEffectiveAcl)=>{x.ancestorsVerified=false;},
    (x:NativeEffectiveAcl)=>{x.descendantsVerified=false;},
    (x:NativeEffectiveAcl)=>{x.aces=[] as never;x.aces=null as never;},
    (x:NativeEffectiveAcl)=>{x.aces=[{sid:'S-1-5-11',type:'allow',accessMask:0x2,inheritOnly:true}];},
    (x:NativeEffectiveAcl)=>{x.aces=[{sid:'S-1-5-11',type:'allow',accessMask:-1,inheritOnly:false}];},
    (x:NativeEffectiveAcl)=>{x.aces=[{sid:'S-1-5-11',type:'allow',accessMask:NaN,inheritOnly:false}];},
  ];
  for(const mutate of changes){
    const acl=syntheticEffectiveAcl(target.fileId);
    mutate(acl);
    assert.throws(()=>assertEffectiveNativeAcl(acl,target),
      e=>e instanceof RelativeAccessDenied);
  }
  const acl=syntheticEffectiveAcl(target.fileId);
  acl.aces=[{sid:'S-1-5-11',type:'allow',accessMask:0x2,inheritOnly:true}];
  assert.doesNotThrow(()=>assertEffectiveNativeAcl(acl,target,'ancestor'),
    'inherit-only does not mutate an ancestor itself');
  acl.aces=[{sid:'S-1-5-11',type:'allow',accessMask:0x40,inheritOnly:false}];
  assert.throws(()=>assertEffectiveNativeAcl(acl,target,'ancestor'),
    relativeError('NATIVE_EFFECTIVE_UNTRUSTED_WRITE'));
});

test('verified native relative directory handles derive path from grant root without requester controlling traversal',()=>{
  const fixture=syntheticProtectedBoundary();
  const chain=fixture.destinationRelativeChain;
  chain.steps=[
    {parentFileId:'dest-parent-id',leaf:'nested',
      child:syntheticNativeHandle('C:\\Protected\\owner\\nested','nested-handle')},
    {parentFileId:'nested-handle',leaf:'deep',
      child:syntheticNativeHandle('C:\\Protected\\owner\\nested\\deep','deep-handle')},
  ];
  chain.destinationLeaf='stage.tmp';
  const destination='C:\\Protected\\owner\\nested\\deep\\stage.tmp';
  const valid=authorizeNativeRelativeChain(chain,fixture.grant.root,destination);
  assert.equal(valid.parent.fileId,'deep-handle');
  assert.equal(valid.derivedDestination.toLowerCase(),destination.toLowerCase());
  fixture.destinationParent=syntheticNativeHandle('C:\\Protected\\owner\\nested\\deep','deep-handle');
  assert.equal(assertNativeProtectedFileBoundary(syntheticSource,destination,
    'write','trusted-owner','trusted-device',fixture).parentFileId,'deep-handle');
  for(const mutate of [
    (x:typeof chain)=>{x.steps[1]!.parentFileId='wrong-parent';},
    (x:typeof chain)=>{x.steps[0]!.child.reparseTag=0xA0000003;},
    (x:typeof chain)=>{x.steps[0]!.child.finalPath='C:\\Users\\Public\\junction-target';},
    (x:typeof chain)=>{x.steps[0]!.child.observedAfter.fileId='recreated';},
    (x:typeof chain)=>{x.steps[0]!.child.volumeGuid='\\\\?\\Volume{alien}\\';},
    (x:typeof chain)=>{x.steps[1]!.child.diskId='other-disk';},
    (x:typeof chain)=>{x.steps[0]!.leaf='..';},
    (x:typeof chain)=>{x.steps[0]!.leaf='nested:ads';},
    (x:typeof chain)=>{x.steps[0]!.leaf='CON';},
    (x:typeof chain)=>{x.destinationLeaf='stage.tmp:ads';},
  ]){
    const x=syntheticProtectedBoundary().destinationRelativeChain;
    x.steps=[
      {parentFileId:'dest-parent-id',leaf:'nested',
        child:syntheticNativeHandle('C:\\Protected\\owner\\nested','nested-handle')},
      {parentFileId:'nested-handle',leaf:'deep',
        child:syntheticNativeHandle('C:\\Protected\\owner\\nested\\deep','deep-handle')},
    ];
    x.destinationLeaf='stage.tmp';
    mutate(x);
    assert.throws(()=>authorizeNativeRelativeChain(x,'C:\\Protected\\owner',destination),
      e=>e instanceof RelativeAccessDenied);
  }
});

test('CORE source preflight refuses missing/inconsistent effective ACL on parent/import/updater, not just a boolean',()=>{
  for(const role of ['parent','updater','module'] as const){
    for(const tamper of [
      (x:NativeEffectiveAcl)=>{x.provider='unavailable';},
      (x:NativeEffectiveAcl)=>{x.aces=[...x.aces,{sid:'S-1-5-11',type:'allow',accessMask:0x40000,inheritOnly:false}];},
      (x:NativeEffectiveAcl)=>{x.observedFileId='mismatched-live-handle';},
    ]){
      const fixture=syntheticProtectedBoundary();
      tamper(fixture.protectedComponents[role].effectiveAcl);
      assert.throws(()=>assertNativeProtectedFileBoundary(
        syntheticSource,syntheticDestination,'write','trusted-owner','trusted-device',fixture),
      e=>e instanceof RelativeAccessDenied || protectedDenied(e),role);
    }
  }
});

test('source signature/ACL and grant-relative path cannot be replaced by booleans from caller',()=>{
  for(const tamper of [
    (x:ReturnType<typeof syntheticProtectedBoundary>)=>{x.sourceEffectiveAcl.provider='unavailable';},
    (x:ReturnType<typeof syntheticProtectedBoundary>)=>{x.sourceEffectiveAcl.aces=[
      {sid:'S-1-5-11',type:'allow',accessMask:0x2,inheritOnly:false}];},
    (x:ReturnType<typeof syntheticProtectedBoundary>)=>{x.destinationRelativeChain.grantRoot.fileId='foreign-root';},
    (x:ReturnType<typeof syntheticProtectedBoundary>)=>{x.destinationRelativeChain.destinationLeaf='out-of-scope.tmp';},
  ]){
    const fixture=syntheticProtectedBoundary();tamper(fixture);
    assert.throws(()=>assertNativeProtectedFileBoundary(
      syntheticSource,syntheticDestination,'write','trusted-owner','trusted-device',fixture),
    e=>e instanceof RelativeAccessDenied||protectedDenied(e));
  }
});
