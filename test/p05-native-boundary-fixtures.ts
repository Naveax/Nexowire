import path from 'node:path';
import type {NativeEffectiveAcl} from '../src/agent/windows-native-relative-access.js';
import type {ProtectedImportGraph} from '../src/agent/windows-native-protected-import-closure.js';
import {
  PINNED_FILE_PROTECTED_COMPONENTS,
  type NativeFileId,
  type NativeHandleEvidence,
  type VerifiedFilesystemBoundary,
  type ProtectedRole,
} from '../src/agent/windows-native-file-source-boundary.js';

const SOURCE='C:\\ProgramData\\Nexowire\\privileged-broker\\file-helper.exe';
const DEST='C:\\Protected\\owner\\stage.tmp';
export const syntheticSource=SOURCE;
export const syntheticDestination=DEST;
const volumeId = {
  volumeSerial:'FAKE-SERIAL-NOT-PHYSICAL',
  volumeGuid:'\\\\?\\Volume{synthetic-only}\\',
  diskId:'FAKE-DISK-NOT-PHYSICAL',
  partitionNumber:1,
};
export function syntheticNativeHandle(
  openedPath:string,fileId:string,kind:'file'|'directory'='directory',
):NativeHandleEvidence{
  const id:NativeFileId={fileId,...volumeId};
  return {
    ...id,openedPath,finalPath:openedPath,objectType:kind,
    reparseTag:null,alternateStream:false,linkCount:1,
    observedAfter:{...id},noFollowVerified:true,
  };
}
export function syntheticEffectiveAcl(fileId:string):NativeEffectiveAcl {
  return {provider:'native-verified',observedFileId:fileId,
    ownerSid:'S-1-5-18',daclProtected:true,
    ancestorsVerified:true,descendantsVerified:true,
    aces:[{sid:'S-1-5-18',type:'allow',accessMask:0x001f01ff,inheritOnly:false},
      {sid:'S-1-5-11',type:'allow',accessMask:0x00000001,inheritOnly:false}],
  };
}

export function syntheticImportGraph(
  protectedComponents:VerifiedFilesystemBoundary['protectedComponents'],
  source:NativeHandleEvidence,
):ProtectedImportGraph {
  const modules=[
    {key:'root',path:SOURCE,role:'parent' as const,
      sha256:'a'.repeat(64),signerCertificateSha256:'b'.repeat(64),
      imports:['updater']},
    {key:'updater',path:'C:\\ProgramData\\Nexowire\\updater\\updater.dll',
      role:'updater' as const,sha256:'c'.repeat(64),
      signerCertificateSha256:'d'.repeat(64),imports:['module']},
    {key:'module',path:'C:\\Program Files\\Nexowire\\modules\\core.dll',
      role:'module' as const,sha256:'e'.repeat(64),
      signerCertificateSha256:'f'.repeat(64),imports:[]},
  ];
  return {
    manifestProvider:'protected-installed-manifest',
    manifestSignatureVerified:true,
    rootKey:'root',
    pinned:modules.map(({key,path,role,sha256,signerCertificateSha256,imports})=>({
      key,path,role,sha256,signerCertificateSha256,imports:[...imports],
    })),
    observed:modules.map(item=>{
      const anchor=protectedComponents[item.role].handle;
      const isRoot=item.key==='root';
      const rootDirectory=isRoot
        ?syntheticNativeHandle('C:\\ProgramData\\Nexowire\\privileged-broker',
          'broker-parent-id')
        :anchor;
      const steps=isRoot
        ?[{parentFileId:anchor.fileId,leaf:'privileged-broker',child:rootDirectory}]
        :[];
      const handle=isRoot
        ?{...source,observedAfter:{...source.observedAfter}}
        :syntheticNativeHandle(item.path,'import-'+item.key,'file');
      return {
        key:item.key,handle,
        parentRelativeChain:{
          grantRoot:{...anchor,observedAfter:{...anchor.observedAfter}},
          steps,destinationLeaf:path.win32.basename(item.path),
        },
        open:{
          provider:'native-retained-handle' as const,
          api:'NtCreateFile.RootDirectory' as const,
          parentFileId:rootDirectory.fileId,
          openedFileId:handle.fileId,
          afterReadback:{
            fileId:handle.fileId,volumeSerial:handle.volumeSerial,
            volumeGuid:handle.volumeGuid,diskId:handle.diskId,
            partitionNumber:handle.partitionNumber,
          },
          noReparseTraversal:true,retainedUntilVerified:true,
        },
        effectiveAcl:syntheticEffectiveAcl(handle.fileId),
        sha256:item.sha256,signerCertificateSha256:item.signerCertificateSha256,
        authenticodeStatus:'Valid' as const,
        importInventoryComplete:true,
        discoveredImports:[...item.imports],
      };
    }),
  };
}
export function syntheticProtectedBoundary():VerifiedFilesystemBoundary{
  const protectedComponents = Object.fromEntries(
    (['parent','updater','module'] as ProtectedRole[]).map(role=>[
      role,{
        role,handle:syntheticNativeHandle(PINNED_FILE_PROTECTED_COMPONENTS[role],
          'protected-'+role),
        aclOwnerSid:'S-1-5-18',daclProtected:true,
        untrustedWriteOrDeleteOrOwnerRights:false,
        ancestorChainChecked:true,descendantsChecked:true,
        provider:'native-verified',
        pinnedPublisherAndDigest:true,
        effectiveAcl:syntheticEffectiveAcl('protected-'+role),
      },
    ]),
  ) as VerifiedFilesystemBoundary['protectedComponents'];
  return {
    pinnedSource:SOURCE,
    source:syntheticNativeHandle(SOURCE,'source-id','file'),
    sourceAclOwnerSid:'S-1-5-18',
    sourceDaclProtected:true,
    sourceUntrustedWriteOrDeleteOrOwnerRights:false,
    sourcePublisherAndDigestVerified:true,
    sourceEffectiveAcl:syntheticEffectiveAcl('source-id'),
    destinationRelativeChain:{
      grantRoot:syntheticNativeHandle(path.win32.dirname(DEST),'dest-parent-id'),
      steps:[],destinationLeaf:path.win32.basename(DEST),
    },
    destinationParent:syntheticNativeHandle(path.win32.dirname(DEST),'dest-parent-id'),
    protectedComponents,
    protectedImportGraph:syntheticImportGraph(protectedComponents,
      syntheticNativeHandle(SOURCE,'source-id','file')),
    grant:{
      ownerId:'trusted-owner',deviceId:'trusted-device',
      scopes:['read','write','delete','move'],
      root:'C:\\Protected\\owner',
      expiresAtMonotonic:1000,observedAtMonotonic:500,
      approvalEpoch:4,currentOwnerEpoch:4,
      volumeGuid:volumeId.volumeGuid,diskId:volumeId.diskId,
      partitionNumber:volumeId.partitionNumber,
      removable:false,usbWriteApproved:false,ownerApprovalVerified:true,
    },
  };
}
