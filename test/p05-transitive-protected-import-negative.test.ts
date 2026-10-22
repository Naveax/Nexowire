import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertNativeProtectedFileBoundary,
  NativeFileBoundaryError,
  type VerifiedFilesystemBoundary,
} from '../src/agent/windows-native-file-source-boundary.js';
import {RelativeAccessDenied} from '../src/agent/windows-native-relative-access.js';
import {
  assertProtectedImportClosure,ProtectedImportError,
  type ProtectedImportGraph,
} from '../src/agent/windows-native-protected-import-closure.js';
import {
  syntheticProtectedBoundary,syntheticSource,syntheticDestination,
  syntheticNativeHandle,syntheticEffectiveAcl,
} from './p05-native-boundary-fixtures.js';

const err=(code:string)=>(error:unknown)=>
  (error instanceof ProtectedImportError ||
    error instanceof RelativeAccessDenied ||
    error instanceof NativeFileBoundaryError) && error.code===code;
function check(fixture:VerifiedFilesystemBoundary):void {
  assertNativeProtectedFileBoundary(
    syntheticSource,syntheticDestination,'write',
    'trusted-owner','trusted-device',fixture);
}
function mutation(run:(f:VerifiedFilesystemBoundary)=>void,code:string):void{
  const fixture=syntheticProtectedBoundary();
  run(fixture);
  assert.throws(()=>check(fixture),err(code));
}
const graph=(f:VerifiedFilesystemBoundary)=>f.protectedImportGraph;
const byKey=(g:ProtectedImportGraph,k:string)=>
  g.observed.find(x=>x.key===k)!;
const pin=(g:ProtectedImportGraph,k:string)=>
  g.pinned.find(x=>x.key===k)!;

test('root, updater DLL and transitive imported module require separate pinned signer, SHA256 and native handle',()=>{
  const f=syntheticProtectedBoundary();
  const result=assertProtectedImportClosure(
    graph(f),f.pinnedSource,f.source,f.protectedComponents);
  assert.equal(result.importsVerified,3);
  assert.deepEqual(result.verifiedFileIds,['source-id','import-updater','import-module']);
  assert.doesNotThrow(()=>check(f));
});

test('missing, inserted, duplicate or orphan transitive binaries fail instead of trusting updater-wide signed=true',()=>{
  mutation(f=>{graph(f).observed=graph(f).observed.filter(x=>x.key!=='module');},
    'IMPORT_MANIFEST_OR_INVENTORY_UNAVAILABLE');
  mutation(f=>{graph(f).pinned=[...graph(f).pinned,pin(graph(f),'module')];},
    'IMPORT_MANIFEST_OR_INVENTORY_UNAVAILABLE');
  mutation(f=>{
    graph(f).observed=[...graph(f).observed,
      {...byKey(graph(f),'module'),key:'injected-loader'}];
  },'IMPORT_MANIFEST_OR_INVENTORY_UNAVAILABLE');
  mutation(f=>{pin(graph(f),'root').imports=[];},
    'IMPORT_ORPHANED_OR_UNREACHABLE_MODULE');
  mutation(f=>{pin(graph(f),'updater').imports=['rogue.dll'];},
    'IMPORT_UNPINNED_TRANSITIVE_MODULE');
  mutation(f=>{pin(graph(f),'module').imports=['root'];},
    'IMPORT_GRAPH_CYCLE_OR_DEPTH');
  mutation(f=>{graph(f).manifestProvider='unavailable';},
    'IMPORT_MANIFEST_OR_INVENTORY_UNAVAILABLE');
  mutation(f=>{graph(f).manifestSignatureVerified=false;},
    'IMPORT_MANIFEST_OR_INVENTORY_UNAVAILABLE');
});

test('independently discovered PE import inventory denies transitive DLL injection/omission',()=>{
  mutation(f=>{byKey(graph(f),'updater').discoveredImports=[];},
    'IMPORT_DISCOVERED_GRAPH_MISMATCH');
  mutation(f=>{byKey(graph(f),'updater').discoveredImports=['module','malware.dll'];},
    'IMPORT_DISCOVERED_GRAPH_MISMATCH');
  mutation(f=>{byKey(graph(f),'module').importInventoryComplete=false;},
    'IMPORT_DISCOVERED_GRAPH_MISMATCH');
  mutation(f=>{pin(graph(f),'updater').imports=['module','module'];},
    'IMPORT_INVALID_PIN_OR_DUPLICATE');
});

test('each updater and DLL needs its own valid Authenticode cert SHA256 and handle-bound file hash',()=>{
  for(const key of ['updater','module']){
    mutation(f=>{byKey(graph(f),key).authenticodeStatus='Invalid';},
      'IMPORT_SIGNER_OR_DIGEST_MISMATCH');
    mutation(f=>{byKey(graph(f),key).sha256='0'.repeat(64);},
      'IMPORT_SIGNER_OR_DIGEST_MISMATCH');
    mutation(f=>{byKey(graph(f),key).signerCertificateSha256='0'.repeat(64);},
      'IMPORT_SIGNER_OR_DIGEST_MISMATCH');
    mutation(f=>{pin(graph(f),key).signerCertificateSha256='x'.repeat(64);},
      'IMPORT_INVALID_PIN_OR_DUPLICATE');
  }
});

test('renamed DLL, replaced post-open ID, reparse junction, hardlink and ADS cannot pass',()=>{
  for(const key of ['updater','module']){
    mutation(f=>{byKey(graph(f),key).handle.finalPath='C:\\Users\\Public\\new.dll';},
      'IMPORT_FILE_HANDLE_UNVERIFIED');
    mutation(f=>{byKey(graph(f),key).handle.observedAfter.fileId='replaced-after-open';},
      'IMPORT_FILE_HANDLE_UNVERIFIED');
    mutation(f=>{byKey(graph(f),key).handle.reparseTag=0xA0000003;},
      'IMPORT_FILE_HANDLE_UNVERIFIED');
    mutation(f=>{byKey(graph(f),key).handle.alternateStream=true;},
      'IMPORT_FILE_HANDLE_UNVERIFIED');
    mutation(f=>{byKey(graph(f),key).handle.linkCount=2;},
      'IMPORT_FILE_HANDLE_UNVERIFIED');
    mutation(f=>{byKey(graph(f),key).handle.volumeGuid='\\\\?\\Volume{wrong}\\';},
      'IMPORT_FILE_HANDLE_UNVERIFIED');
  }
});

test('native retained RootDirectory/OpenFileById receipt rejects a user-supplied path and identity switch after SHA readback',()=>{
  mutation(f=>{byKey(graph(f),'module').open.provider='unavailable';},
    'IMPORT_OPEN_BY_HANDLE_OR_POST_READBACK_UNVERIFIED');
  mutation(f=>{byKey(graph(f),'module').open.parentFileId='old-parent-handle';},
    'IMPORT_OPEN_BY_HANDLE_OR_POST_READBACK_UNVERIFIED');
  mutation(f=>{byKey(graph(f),'module').open.openedFileId='foreign-DLL';},
    'IMPORT_OPEN_BY_HANDLE_OR_POST_READBACK_UNVERIFIED');
  mutation(f=>{byKey(graph(f),'module').open.afterReadback.fileId='new-DLL';},
    'IMPORT_OPEN_BY_HANDLE_OR_POST_READBACK_UNVERIFIED');
  mutation(f=>{byKey(graph(f),'module').open.retainedUntilVerified=false;},
    'IMPORT_OPEN_BY_HANDLE_OR_POST_READBACK_UNVERIFIED');
  mutation(f=>{byKey(graph(f),'module').open.noReparseTraversal=false;},
    'IMPORT_OPEN_BY_HANDLE_OR_POST_READBACK_UNVERIFIED');
  mutation(f=>{byKey(graph(f),'module').parentRelativeChain.grantRoot.fileId='foreign-anchor';},
    'IMPORT_PROTECTED_ANCHOR_MISMATCH');
  mutation(f=>{byKey(graph(f),'module').parentRelativeChain.destinationLeaf='other.dll';},
    'NATIVE_RELATIVE_REQUEST_PATH_MISMATCH');
});

test('transitive imported DLL needs independently protected effective ACL, even if updater root is protected',()=>{
  mutation(f=>{byKey(graph(f),'module').effectiveAcl.ownerSid='S-1-5-11';},
    'NATIVE_EFFECTIVE_ACL_UNVERIFIED');
  mutation(f=>{byKey(graph(f),'updater').effectiveAcl.aces=[
    ...byKey(graph(f),'updater').effectiveAcl.aces,
    {sid:'S-1-5-11',type:'allow',accessMask:0x40000,inheritOnly:false},
  ];},'NATIVE_EFFECTIVE_UNTRUSTED_WRITE');
  mutation(f=>{byKey(graph(f),'module').effectiveAcl.aces=[
    ...byKey(graph(f),'module').effectiveAcl.aces,
    {sid:'S-1-5-11',type:'allow',accessMask:0x2,inheritOnly:true},
  ];},'NATIVE_EFFECTIVE_UNTRUSTED_WRITE');
});

test('protected ancestor chain, anchored volume and immutable import root reject alias/namespace traversal',()=>{
  mutation(f=>{byKey(graph(f),'root').parentRelativeChain.steps[0]!.child.reparseTag=0xA0000003;},
    'NATIVE_RELATIVE_HANDLE_CHANGED');
  mutation(f=>{byKey(graph(f),'root').parentRelativeChain.steps[0]!.child.finalPath=
    'C:\\Users\\Public\\privileged-broker';},'NATIVE_RELATIVE_HANDLE_CHANGED');
  mutation(f=>{byKey(graph(f),'root').parentRelativeChain.steps[0]!.child.observedAfter.fileId='new-directory';},
    'NATIVE_RELATIVE_HANDLE_CHANGED');
  mutation(f=>{byKey(graph(f),'module').parentRelativeChain.grantRoot.volumeGuid=
    '\\\\?\\Volume{other}\\';},'IMPORT_PROTECTED_ANCHOR_MISMATCH');
  mutation(f=>{pin(graph(f),'module').path='C:\\Program Files\\Nexowire\\modules\\core.dll:ads';},
    'IMPORT_UNSAFE_PATH');
  mutation(f=>{pin(graph(f),'module').path='C:\\Program Files\\Nexowire\\modules\\..\\evil.dll';},
    'IMPORT_UNSAFE_PATH');
  mutation(f=>{pin(graph(f),'module').path='C:\\Program Files\\Nexowire\\modules-other\\core.dll';},
    'IMPORT_UNPROTECTED_OR_ALIASED_PATH');
  mutation(f=>{pin(graph(f),'module').path='\\\\attacker\\share\\core.dll';},
    'IMPORT_UNSAFE_PATH');
});

test('each intermediary import directory requires independent effective ACL and stable held handle',()=>{
  mutation(f=>{byKey(graph(f),'root').intermediateDirectoryAcls=[];},
    'IMPORT_ANCESTOR_ACL_INCOMPLETE');
  mutation(f=>{byKey(graph(f),'root').intermediateDirectoryAcls[0]!.provider='unavailable';},
    'NATIVE_EFFECTIVE_ACL_UNVERIFIED');
  mutation(f=>{byKey(graph(f),'root').intermediateDirectoryAcls[0]!.observedFileId='replaced-parent';},
    'NATIVE_EFFECTIVE_ACL_UNVERIFIED');
  mutation(f=>{byKey(graph(f),'root').intermediateDirectoryAcls[0]!.aces=[
    ...byKey(graph(f),'root').intermediateDirectoryAcls[0]!.aces,
    {sid:'S-1-5-11',type:'allow',accessMask:0x40,inheritOnly:false},
  ];},'NATIVE_EFFECTIVE_UNTRUSTED_WRITE');
  mutation(f=>{byKey(graph(f),'root').intermediateDirectoryAcls[0]!.aces=[
    ...byKey(graph(f),'root').intermediateDirectoryAcls[0]!.aces,
    {sid:'S-1-5-32-545',type:'allow',accessMask:0x40000,inheritOnly:true},
  ];},'NATIVE_EFFECTIVE_UNTRUSTED_WRITE');
});

test('unchanged native file ID does not authorize changed DLL bytes or signer after retained readback',()=>{
  for(const key of ['root','updater','module']){
    mutation(f=>{byKey(graph(f),key).open.digestAfterReadbackSha256='0'.repeat(64);},
      'IMPORT_POST_READBACK_SIGNER_OR_BYTES_CHANGED');
    mutation(f=>{byKey(graph(f),key).open.signerDigestAfterReadbackSha256='0'.repeat(64);},
      'IMPORT_POST_READBACK_SIGNER_OR_BYTES_CHANGED');
    mutation(f=>{byKey(graph(f),key).open.signerBinding='unavailable';},
      'IMPORT_POST_READBACK_SIGNER_OR_BYTES_CHANGED');
  }
});

test('caller-selected #709 read-only audit booleans cannot substitute for authenticated import witnesses',()=>{
  mutation(f=>{
    // #709's schema explicitly disclaims independently enumerated imports
    // and contains no native file-id, SHA or signer receipts per DLL.
    const auditReport={
      inputsInsideRoot:true,
      allInspectedPathsHaveAclEvidence:true,
      anyInspectedPathUnsafe:false,
      importListIndependentlyEnumerated:false,
      signedImportManifestVerified:false,
      publisherOfEveryImportVerified:false,
      protectedCompleteImageTreeAttested:false,
    };
    Object.assign(graph(f),{externalAuditReport:auditReport});
    byKey(graph(f),'module').intermediateDirectoryAcls=undefined as never;
  },'IMPORT_ANCESTOR_ACL_INCOMPLETE');
  mutation(f=>{
    Object.assign(graph(f),{callerProvidedApproval:true});
    byKey(graph(f),'updater').open.digestAfterReadbackSha256='';
  },'IMPORT_POST_READBACK_SIGNER_OR_BYTES_CHANGED');
});

test('nested transitive DLL requires both parent handles, per-level ACL and post-read identity',()=>{
  const nested=(f:VerifiedFilesystemBoundary)=>{
    const node=byKey(graph(f),'module');
    const root='C:\\Program Files\\Nexowire\\modules';
    const vendor=syntheticNativeHandle(root+'\\vendor','vendor-directory');
    const runtime=syntheticNativeHandle(root+'\\vendor\\runtime','runtime-directory');
    const full=root+'\\vendor\\runtime\\core.dll';
    pin(graph(f),'module').path=full;
    node.parentRelativeChain.steps=[
      {parentFileId:node.parentRelativeChain.grantRoot.fileId,leaf:'vendor',child:vendor},
      {parentFileId:vendor.fileId,leaf:'runtime',child:runtime},
    ];
    node.parentRelativeChain.destinationLeaf='core.dll';
    node.intermediateDirectoryAcls=[
      syntheticEffectiveAcl(vendor.fileId),
      syntheticEffectiveAcl(runtime.fileId),
    ];
    node.handle.openedPath=full;
    node.handle.finalPath=full;
    node.open.parentFileId=runtime.fileId;
  };
  const valid=syntheticProtectedBoundary();
  nested(valid);
  assert.doesNotThrow(()=>check(valid));
  const failure=(tamper:(f:VerifiedFilesystemBoundary)=>void,code:string)=>{
    const f=syntheticProtectedBoundary();
    nested(f);
    tamper(f);
    assert.throws(()=>check(f),err(code));
  };
  const dll=(f:VerifiedFilesystemBoundary)=>byKey(graph(f),'module');
  failure(f=>{dll(f).parentRelativeChain.steps[0]!.child.reparseTag=0xA0000003;},
    'NATIVE_RELATIVE_HANDLE_CHANGED');
  failure(f=>{dll(f).parentRelativeChain.steps[1]!.child.alternateStream=true;},
    'NATIVE_RELATIVE_HANDLE_CHANGED');
  failure(f=>{dll(f).parentRelativeChain.steps[1]!.child.reparseTag=0xA000000C;},
    'NATIVE_RELATIVE_HANDLE_CHANGED');
  failure(f=>{dll(f).parentRelativeChain.steps[1]!.child.volumeGuid='foreign-volume';},
    'NATIVE_RELATIVE_CROSS_VOLUME');
  failure(f=>{dll(f).parentRelativeChain.steps[1]!.parentFileId='stale-vendor-handle';},
    'NATIVE_RELATIVE_PARENT_ID_MISMATCH');
  failure(f=>{dll(f).parentRelativeChain.steps[0]!.child.observedAfter.fileId='renamed-vendor';},
    'NATIVE_RELATIVE_HANDLE_CHANGED');
  failure(f=>{dll(f).intermediateDirectoryAcls[0]!.aces=[
    ...dll(f).intermediateDirectoryAcls[0]!.aces,
    {sid:'S-1-5-11',type:'allow',accessMask:0x40,inheritOnly:true},
  ];},'NATIVE_EFFECTIVE_UNTRUSTED_WRITE');
  failure(f=>{dll(f).intermediateDirectoryAcls[1]!.observedFileId='replaced-runtime';},
    'NATIVE_EFFECTIVE_ACL_UNVERIFIED');
  failure(f=>{dll(f).intermediateDirectoryAcls[1]!.provider='unavailable';},
    'NATIVE_EFFECTIVE_ACL_UNVERIFIED');
  failure(f=>{dll(f).handle.alternateStream=true;},
    'IMPORT_FILE_HANDLE_UNVERIFIED');
  failure(f=>{dll(f).handle.linkCount=2;},
    'IMPORT_FILE_HANDLE_UNVERIFIED');
  failure(f=>{dll(f).handle.observedAfter.fileId='replaced-on-disk';},
    'IMPORT_FILE_HANDLE_UNVERIFIED');
  failure(f=>{dll(f).open.afterReadback.fileId='post-hash-replaced';},
    'IMPORT_OPEN_BY_HANDLE_OR_POST_READBACK_UNVERIFIED');
  failure(f=>{pin(graph(f),'module').path+=':malicious';},
    'IMPORT_UNSAFE_PATH');
});

test('hardlink aliases with distinct manifest keys cannot silently reuse same native file identity',()=>{
  mutation(f=>{
    const module=byKey(graph(f),'module'),updater=byKey(graph(f),'updater');
    module.handle.fileId=updater.handle.fileId;
    module.handle.observedAfter.fileId=updater.handle.fileId;
    module.open.openedFileId=updater.handle.fileId;
    module.open.afterReadback.fileId=updater.handle.fileId;
    module.effectiveAcl.observedFileId=updater.handle.fileId;
    // same synthetic volume; duplicate file ID cannot be trusted as two DLLs
  },'IMPORT_HARDLINK_OR_ALIAS_COLLISION');
});
