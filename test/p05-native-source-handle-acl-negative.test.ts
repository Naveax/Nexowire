import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertNativeProtectedFileBoundary,
  NativeFileBoundaryError,
  type VerifiedFilesystemBoundary,
} from '../src/agent/windows-native-file-source-boundary.js';
import {
  assertCoreBrokerFilesystemPreflight,
  BrokerFilesystemPreflightError,
  type BrokerFilesystemTrust,
} from '../src/agent/broker-filesystem-preflight.js';
import {
  syntheticProtectedBoundary,syntheticSource,syntheticDestination,
} from './p05-native-boundary-fixtures.js';

const verify=(e:VerifiedFilesystemBoundary=syntheticProtectedBoundary(),
 source=syntheticSource,destination=syntheticDestination,
 scope:'read'|'write'|'delete'|'move'='write')=>
  assertNativeProtectedFileBoundary(source,destination,scope,
    'trusted-owner','trusted-device',e);
const denied=(code:string)=>(e:unknown)=>e instanceof NativeFileBoundaryError && e.code===code;

test('trusted-native fixture is accepted by policy only; it never creates any OS writer',()=>{
  const ok=verify();
  assert.deepEqual(ok,{
    sourceFileId:'source-id',
    parentFileId:'dest-parent-id',
    volumeGuid:'\\\\?\\Volume{synthetic-only}\\',
  });
});

test('source must match independently pinned protected component, not request-chosen path',()=>{
  assert.throws(()=>verify(syntheticProtectedBoundary(),
    'C:\\Users\\Public\\file-helper.exe'),
  denied('FILE_NATIVE_CALLER_SOURCE_MISMATCH'));
  for(const source of [
    'C:\\Users\\Public\\user-selected.exe',
    'C:\\ProgramData\\Nexowire\\privileged-broker-other\\evil.exe',
    'C:\\ProgramData\\Nexowire\\privileged-broker\\..\\updater\\evil.exe',
    'C:\\ProgramData\\Nexowire\\privileged-broker\\evil.exe:alt',
    '\\\\server\\share\\evil.exe',
    '\\\\?\\C:\\ProgramData\\Nexowire\\privileged-broker\\evil.exe',
  ]){
    const fixture=syntheticProtectedBoundary();
    fixture.pinnedSource=source;
    assert.throws(()=>verify(fixture,source), (e:unknown)=>
      e instanceof NativeFileBoundaryError &&
      ['FILE_NATIVE_UNTRUSTED_PINNED_SOURCE','FILE_NATIVE_UNSAFE_PATH'].includes(e.code),
      source);
  }
});

test('independent OS-open handle identity rejects rename/recreate, junction, hardlink, ADS and cross-volume swap',()=>{
  const mutations=[
    (x:VerifiedFilesystemBoundary)=>{x.source.fileId='recreated-file-id';},
    (x:VerifiedFilesystemBoundary)=>{x.source.observedAfter.fileId='swapped-file-id';},
    (x:VerifiedFilesystemBoundary)=>{x.source.observedAfter.volumeSerial='wrong-serial';},
    (x:VerifiedFilesystemBoundary)=>{x.source.volumeGuid='\\\\?\\Volume{other}\\';},
    (x:VerifiedFilesystemBoundary)=>{x.source.observedAfter.diskId='other-disk';},
    (x:VerifiedFilesystemBoundary)=>{x.source.observedAfter.partitionNumber=3;},
    (x:VerifiedFilesystemBoundary)=>{x.source.finalPath='C:\\Users\\Public\\reparse-target.exe';},
    (x:VerifiedFilesystemBoundary)=>{x.source.reparseTag=0xA0000003;},
    (x:VerifiedFilesystemBoundary)=>{x.source.noFollowVerified=false;},
    (x:VerifiedFilesystemBoundary)=>{x.source.alternateStream=true;},
    (x:VerifiedFilesystemBoundary)=>{x.source.linkCount=2;},
    (x:VerifiedFilesystemBoundary)=>{x.source.objectType='directory';},
  ];
  for(const mutate of mutations){
    const fixture=syntheticProtectedBoundary();
    mutate(fixture);
    assert.throws(()=>verify(fixture),denied('FILE_NATIVE_HANDLE_IDENTITY_UNVERIFIED'));
  }
});

test('protected source file ACL and exact signer/digest are mandatory independently of its directory ACL',()=>{
  for(const mutate of [
    (x:VerifiedFilesystemBoundary)=>{x.sourceAclOwnerSid='S-1-5-11';},
    (x:VerifiedFilesystemBoundary)=>{x.sourceDaclProtected=false;},
    (x:VerifiedFilesystemBoundary)=>{x.sourceUntrustedWriteOrDeleteOrOwnerRights=true;},
    (x:VerifiedFilesystemBoundary)=>{x.sourcePublisherAndDigestVerified=false;},
  ]){
    const evidence=syntheticProtectedBoundary();mutate(evidence);
    assert.throws(()=>verify(evidence),denied('FILE_NATIVE_SOURCE_ACL_OR_SIGNER_UNVERIFIED'));
  }
});

test('protected parent/updater/module each require verified OS ACL owner, no reparse, complete descendants and signed provenance',()=>{
  for(const role of ['parent','updater','module'] as const){
    const mutations=[
      (x:VerifiedFilesystemBoundary)=>{x.protectedComponents[role].aclOwnerSid='S-1-5-11';},
      (x:VerifiedFilesystemBoundary)=>{x.protectedComponents[role].provider='unavailable';},
      (x:VerifiedFilesystemBoundary)=>{x.protectedComponents[role].daclProtected=false;},
      (x:VerifiedFilesystemBoundary)=>{x.protectedComponents[role].untrustedWriteOrDeleteOrOwnerRights=true;},
      (x:VerifiedFilesystemBoundary)=>{x.protectedComponents[role].ancestorChainChecked=false;},
      (x:VerifiedFilesystemBoundary)=>{x.protectedComponents[role].descendantsChecked=false;},
      (x:VerifiedFilesystemBoundary)=>{x.protectedComponents[role].pinnedPublisherAndDigest=false;},
    ];
    for(const mutate of mutations){
      const fixture=syntheticProtectedBoundary();
      mutate(fixture);
      assert.throws(()=>verify(fixture),denied('FILE_NATIVE_PROTECTED_ACL_UNVERIFIED'),role);
    }
    for(const mutate of [
      (x:VerifiedFilesystemBoundary)=>{x.protectedComponents[role].handle.reparseTag=0xA0000003;},
      (x:VerifiedFilesystemBoundary)=>{x.protectedComponents[role].handle.finalPath='C:\\Users\\Public\\updater';},
      (x:VerifiedFilesystemBoundary)=>{x.protectedComponents[role].handle.observedAfter.fileId='replaced';},
      (x:VerifiedFilesystemBoundary)=>{x.protectedComponents[role].handle.noFollowVerified=false;},
    ]){
      const fixture=syntheticProtectedBoundary();
      mutate(fixture);
      assert.throws(()=>verify(fixture),denied('FILE_NATIVE_HANDLE_IDENTITY_UNVERIFIED'),role);
    }
  }
});

test('destination grants are scoped to immutable parent handle and actual volume GUID/disk/partition',()=>{
  const mutations=[
    (x:VerifiedFilesystemBoundary)=>{x.destinationParent.fileId='new-parent';},
    (x:VerifiedFilesystemBoundary)=>{x.destinationParent.observedAfter.fileId='parent-replaced';},
    (x:VerifiedFilesystemBoundary)=>{x.destinationParent.reparseTag=0xA0000003;},
    (x:VerifiedFilesystemBoundary)=>{x.destinationParent.finalPath='C:\\Users\\Public\\evil';},
    (x:VerifiedFilesystemBoundary)=>{x.destinationParent.noFollowVerified=false;},
  ];
  for(const mutate of mutations){
    const fixture=syntheticProtectedBoundary();mutate(fixture);
    assert.throws(()=>verify(fixture),denied('FILE_NATIVE_HANDLE_IDENTITY_UNVERIFIED'));
  }
  for(const mutate of [
    (x:VerifiedFilesystemBoundary)=>{x.grant.volumeGuid='\\\\?\\Volume{changed}\\';},
    (x:VerifiedFilesystemBoundary)=>{x.grant.diskId='different-disk';},
    (x:VerifiedFilesystemBoundary)=>{x.grant.partitionNumber=8;},
    (x:VerifiedFilesystemBoundary)=>{x.grant.ownerId='other-owner';},
    (x:VerifiedFilesystemBoundary)=>{x.grant.deviceId='other-device';},
    (x:VerifiedFilesystemBoundary)=>{x.grant.root='C:\\Protected\\other';},
    (x:VerifiedFilesystemBoundary)=>{x.grant.approvalEpoch=3;},
    (x:VerifiedFilesystemBoundary)=>{x.grant.expiresAtMonotonic=500;},
    (x:VerifiedFilesystemBoundary)=>{x.grant.ownerApprovalVerified=false;},
    (x:VerifiedFilesystemBoundary)=>{x.grant.scopes=['read'];},
    (x:VerifiedFilesystemBoundary)=>{x.grant.removable=true;x.grant.usbWriteApproved=false;},
  ]){
    const fixture=syntheticProtectedBoundary();mutate(fixture);
    assert.throws(()=>verify(fixture),(error:unknown)=>
      error instanceof NativeFileBoundaryError &&
      ['FILE_NATIVE_OWNER_VOLUME_GRANT_UNVERIFIED','FILE_NATIVE_HANDLE_IDENTITY_UNVERIFIED']
        .includes(error.code));
  }
});

test('two independent destination parent witnesses must match full volume serial and partition FileId identity',()=>{
  // Native file ID alone is only scoped to its physical volume. The relative
  // chain root may not be silently substituted for the separately verified
  // destination-parent/grant handle by keeping just fileId/GUID/disk equal.
  for(const mutate of [
    (x:VerifiedFilesystemBoundary)=>{
      x.destinationRelativeChain.grantRoot.volumeSerial='OTHER-VOLUME-SERIAL';
      x.destinationRelativeChain.grantRoot.observedAfter.volumeSerial='OTHER-VOLUME-SERIAL';
    },
    (x:VerifiedFilesystemBoundary)=>{
      x.destinationRelativeChain.grantRoot.partitionNumber=9;
      x.destinationRelativeChain.grantRoot.observedAfter.partitionNumber=9;
    },
  ]){
    const fixture=syntheticProtectedBoundary();
    mutate(fixture);
    assert.throws(()=>verify(fixture),denied('FILE_NATIVE_PARENT_HANDLE_NOT_PINNED'));
  }
});

test('native retained-handle and owner-epoch witnesses reject truthy but unverified fields',()=>{
  // This is the original protected FILE boundary, not the already-strict
  // transitive imported-DLL graph. Missing and stringified Win32 evidence
  // must NOT promote a caller-supplied object into retained-handle authority.
  for(const mutate of [
    (x:VerifiedFilesystemBoundary)=>{x.source.noFollowVerified='true' as never;},
    (x:VerifiedFilesystemBoundary)=>{x.source.alternateStream=undefined as never;},
    (x:VerifiedFilesystemBoundary)=>{
      x.destinationRelativeChain.grantRoot.noFollowVerified=1 as never;
    },
    (x:VerifiedFilesystemBoundary)=>{
      x.destinationRelativeChain.grantRoot.alternateStream=undefined as never;
    },
    (x:VerifiedFilesystemBoundary)=>{x.grant.ownerApprovalVerified='true' as never;},
    (x:VerifiedFilesystemBoundary)=>{
      x.grant.approvalEpoch=-1;
      x.grant.currentOwnerEpoch=-1;
    },
    (x:VerifiedFilesystemBoundary)=>{
      x.grant.approvalEpoch=4;
      x.grant.currentOwnerEpoch=4.5;
    },
  ]){
    const fixture=syntheticProtectedBoundary(); mutate(fixture);
    assert.throws(()=>verify(fixture),
      (error:unknown)=>error instanceof NativeFileBoundaryError,
      'Wrong type or impossible ownerEpoch must not authorize native access');
  }
});

test('destination never leaves granted root even for path-prefix sibling, ADS, traversal or junction parent',()=>{
  for(const destination of [
    'C:\\Protected\\owner-other\\stage.tmp',
    'C:\\Protected\\owner\\..\\other\\stage.tmp',
    'C:\\Protected\\owner\\stage.tmp:malicious',
    '\\\\server\\share\\stage.tmp',
  ]){
    assert.throws(()=>verify(syntheticProtectedBoundary(),syntheticSource,destination),
      e=>e instanceof NativeFileBoundaryError,destination);
  }
});

test('no remote-request-only evidence can bypass CORE Broker native witness, even with fake high token',async()=>{
  const trusted:BrokerFilesystemTrust={
    brokerToken:async()=>({
      sid:'S-1-5-21-1-2-3-4',ownerId:'trusted-owner',
      deviceId:'trusted-device',integrity:'high',authenticated:true,
    }),
    callerToken:async()=>({
      sid:'S-1-5-21-1-2-3-4',ownerId:'trusted-owner',
      deviceId:'trusted-device',integrity:'high',authenticated:true,
    }),
    destinationOwner:async()=>({ownerId:'trusted-owner',deviceId:'trusted-device'}),
    attestProtectedSource:async()=>true,
    authorizeDestination:async()=>true,
    inspectNativeFilesystemBoundary:async()=>null,
  };
  await assert.rejects(()=>assertCoreBrokerFilesystemPreflight({
    source:syntheticSource,destination:syntheticDestination,scope:'write',
  },trusted),(e:unknown)=>e instanceof BrokerFilesystemPreflightError &&
    e.code==='BROKER_FILE_NATIVE_WITNESS_UNAVAILABLE');
  const forged=syntheticProtectedBoundary();
  forged.protectedComponents.module.untrustedWriteOrDeleteOrOwnerRights=true;
  await assert.rejects(()=>assertCoreBrokerFilesystemPreflight({
    source:syntheticSource,destination:syntheticDestination,scope:'write',
  },{...trusted,inspectNativeFilesystemBoundary:async()=>forged}),
  (e:unknown)=>e instanceof BrokerFilesystemPreflightError &&
    e.code==='FILE_NATIVE_PROTECTED_ACL_UNVERIFIED');
});
