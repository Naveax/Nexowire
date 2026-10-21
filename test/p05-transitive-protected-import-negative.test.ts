import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertNativeProtectedFileBoundary,
  type VerifiedFilesystemBoundary,
} from '../src/agent/windows-native-file-source-boundary.js';
import {
  assertProtectedImportClosure,ProtectedImportError,
  type ProtectedImportGraph,
} from '../src/agent/windows-native-protected-import-closure.js';
import {
  syntheticProtectedBoundary,syntheticSource,syntheticDestination,
} from './p05-native-boundary-fixtures.js';

const err=(code:string)=>(error:unknown)=>
  error instanceof ProtectedImportError&&error.code===code;
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

test('hardlink aliases with distinct manifest keys cannot silently reuse same native file identity',()=>{
  mutation(f=>{
    const module=byKey(graph(f),'module'),updater=byKey(graph(f),'updater');
    module.handle.fileId=updater.handle.fileId;
    module.handle.observedAfter.fileId=updater.handle.fileId;
    module.open.openedFileId=updater.handle.fileId;
    module.open.afterReadback.fileId=updater.handle.fileId;
    // keep module on same volume to make duplicate physical-ID check material
  },'IMPORT_HARDLINK_OR_ALIAS_COLLISION');
});
