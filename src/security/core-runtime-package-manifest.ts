import {createHash,createPublicKey,verify} from 'node:crypto';
import {constants,type BigIntStats} from 'node:fs';
import {lstat,open,readdir,realpath} from 'node:fs/promises';
import path from 'node:path';
import * as z from 'zod';

const hash=z.string().regex(/^[a-f0-9]{64}$/);
const safePath=z.string().min(1).max(240).refine(value=>{
  if(!/^[A-Za-z0-9._/-]+$/.test(value)||value.startsWith('/')||value.includes('//'))return false;
  return value.split('/').every(part=>part!=='.'&&part!=='..'&&part.length>0&&
    !part.endsWith('.')&&!/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));
});
export const CoreRuntimeManifestSchema=z.strictObject({
  version:z.literal(1),kind:z.literal('nexowire_core_runtime_manifest_v1'),
  sourceRepository:z.literal('Naveax/Nexowire'),sourceCommit:z.string().regex(/^[a-f0-9]{40}$/),
  releaseVersion:z.string().regex(/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/),
  releaseSequence:z.number().int().positive().safe(),previousManifestSha256:hash.nullable(),
  entrypoint:safePath,
  files:z.array(z.strictObject({path:safePath,sha256:hash,
    bytes:z.number().int().nonnegative().max(268435456)})).min(1).max(4096),
});
export type CoreRuntimeManifest=z.infer<typeof CoreRuntimeManifestSchema>;
const anchorSchema=z.strictObject({authorityId:z.string().uuid(),
  publisherSpkiSha256:hash,acceptedSequence:z.number().int().nonnegative().safe(),
  acceptedManifestSha256:hash.nullable()});
export type CoreRuntimeReleaseAnchor=z.infer<typeof anchorSchema>;
function fail(code:string):never{throw new Error('CORE_RELEASE_'+code)}
function canonical(value:CoreRuntimeManifest):Buffer{
  const parsed=CoreRuntimeManifestSchema.parse(value);
  let previous='';const seen=new Set<string>();
  for(const file of parsed.files){
    const folded=file.path.toLowerCase();
    if(seen.has(folded)||previous&&previous>=file.path)fail('PATH_ALIAS_OR_ORDER');
    seen.add(folded);previous=file.path;
  }
  if(!parsed.files.some(f=>f.path===parsed.entrypoint))fail('ENTRYPOINT_NOT_COVERED');
  const bytes=Buffer.from(JSON.stringify(parsed),'utf8');
  if(bytes.length>1048576)fail('MANIFEST_TOO_LARGE');
  return bytes;
}
export function coreRuntimeManifestSigningBytes(value:CoreRuntimeManifest):Buffer{
  return Buffer.concat([Buffer.from('nexowire.core.runtime.package.manifest.v1\0'),canonical(value)]);
}
export function coreRuntimeManifestBytes(value:CoreRuntimeManifest):Buffer{return canonical(value)}
function sameIdentity(a:BigIntStats,b:BigIntStats):boolean{
  return a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtimeNs===b.mtimeNs&&a.ctimeNs===b.ctimeNs;
}
function samePath(a:string,b:string):boolean{
  return process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;
}

/**
 * Verify a candidate payload against a separately pinned Nexowire manifest
 * signer and release anchor. This reads files; it does NOT install, elevate,
 * update the anchor, establish Authenticode/ACL or authorize production CORE.
 */
export async function verifyCoreRuntimePackageCandidate(options:{
  payloadRoot:string;manifestUtf8:Uint8Array;signatureBase64:string;
  publisherSpkiBase64:string;expectedSourceCommit:string;expectedEntrypoint:string;
  authorityId:string;
  /** Protected authenticated independent readback, not a manifest/UI field. */
  readReleaseAnchor:()=>Promise<CoreRuntimeReleaseAnchor|undefined>;
}):Promise<{
  manifestSha256:string;sourceCommit:string;releaseSequence:number;verifiedFiles:number;
  verifiedPayloadBytes:number;candidateFilesMatch:true;
  releaseAnchorAdvanced:false;authenticodePublisherVerified:false;protectedAclVerified:false;
  runtimeInstalled:false;canAuthorizeCore:false;physicalAcceptance:'NOT_PROVEN';productionCore:'NO_GO';
}>{
  const {payloadRoot,publisherSpkiBase64,expectedSourceCommit,expectedEntrypoint,authorityId,
    readReleaseAnchor,signatureBase64}=options;
  const raw=Buffer.from(options.manifestUtf8);
  if(!raw.length||raw.length>1048576)fail('MANIFEST_TOO_LARGE');
  let parsed:unknown;
  try{parsed=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw))}
  catch{return fail('MANIFEST_INVALID')}
  const manifest=CoreRuntimeManifestSchema.parse(parsed),canonicalBytes=canonical(manifest);
  if(!canonicalBytes.equals(raw))fail('MANIFEST_NONCANONICAL');
  if(!/^[a-f0-9]{40}$/.test(expectedSourceCommit)||
    manifest.sourceCommit!==expectedSourceCommit||manifest.entrypoint!==safePath.parse(expectedEntrypoint))
    fail('SOURCE_OR_ENTRYPOINT_MISMATCH');
  const der=Buffer.from(publisherSpkiBase64,'base64');
  if(der.length!==44||der.toString('base64')!==publisherSpkiBase64)fail('PUBLISHER_PIN_REQUIRED');
  const key=createPublicKey({key:der,format:'der',type:'spki'});
  const signature=Buffer.from(signatureBase64,'base64');
  if(key.asymmetricKeyType!=='ed25519'||signature.length!==64||signature.toString('base64')!==signatureBase64||
    !verify(null,coreRuntimeManifestSigningBytes(manifest),key,signature))fail('NEXOWIRE_MANIFEST_SIGNATURE_REQUIRED');
  const publisherHash=createHash('sha256').update(der).digest('hex');
  const manifestHash=createHash('sha256').update(raw).digest('hex');
  const readAnchor=async()=>{
    let value;
    try{value=anchorSchema.safeParse(await readReleaseAnchor())}catch{return fail('ANCHOR_UNAVAILABLE')}
    if(!value.success||value.data.authorityId!==authorityId||value.data.publisherSpkiSha256!==publisherHash||
      (value.data.acceptedSequence===0)!==(value.data.acceptedManifestSha256===null))
      fail('ANCHOR_UNVERIFIED');
    return Object.freeze(value.data);
  };
  const anchor=await readAnchor();
  const already=manifest.releaseSequence===anchor.acceptedSequence&&manifestHash===anchor.acceptedManifestSha256;
  if(!already&&(manifest.releaseSequence!==anchor.acceptedSequence+1||
    manifest.previousManifestSha256!==anchor.acceptedManifestSha256))fail('ROLLBACK_OR_CHAIN_MISMATCH');

  const root=path.resolve(payloadRoot),rootStat=await lstat(root,{bigint:true});
  if(rootStat.isSymbolicLink()||!rootStat.isDirectory()||!samePath(await realpath(root),root))fail('PAYLOAD_ROOT_UNSAFE');
  const directories=new Map<string,BigIntStats>([[root,rootStat]]),found=new Map<string,BigIntStats>();
  const pending=[root];let entries=0;
  while(pending.length){
    const directory=pending.pop()!;
    for(const name of await readdir(directory)){
      if(++entries>8192)fail('PAYLOAD_ENTRY_LIMIT');
      const absolute=path.join(directory,name),relative=path.relative(root,absolute).split(path.sep).join('/');
      if(!safePath.safeParse(relative).success)fail('PAYLOAD_PATH_UNSAFE');
      const stat=await lstat(absolute,{bigint:true});
      if(stat.isSymbolicLink()||!samePath(await realpath(absolute),absolute))fail('PAYLOAD_LINK_DENIED');
      if(stat.isDirectory()){
        directories.set(absolute,stat);pending.push(absolute);
      }else if(stat.isFile()&&stat.nlink===1n)found.set(relative,stat);
      else fail('PAYLOAD_LINK_OR_TYPE_DENIED');
    }
  }
  if(found.size!==manifest.files.length||manifest.files.some(file=>!found.has(file.path)))
    fail('PAYLOAD_COVERAGE_MISMATCH');
  let total=0;
  for(const file of manifest.files){
    total+=file.bytes;if(total>536870912)fail('PAYLOAD_BYTE_LIMIT');
    const absolute=path.join(root,...file.path.split('/')),before=found.get(file.path)!;
    if(before.size!==BigInt(file.bytes))fail('PAYLOAD_DIGEST_MISMATCH');
    const handle=await open(absolute,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
    try{
      const held=await handle.stat({bigint:true});
      if(!held.isFile()||held.nlink!==1n||!sameIdentity(before,held))fail('PAYLOAD_IDENTITY_CHANGED');
      const hasher=createHash('sha256'),buffer=Buffer.alloc(65536);let offset=0;
      for(;;){
        const {bytesRead}=await handle.read(buffer,0,buffer.length,offset);
        if(!bytesRead)break;
        offset+=bytesRead;if(offset>file.bytes)fail('PAYLOAD_SIZE_CHANGED');
        hasher.update(buffer.subarray(0,bytesRead));
      }
      if(offset!==file.bytes||hasher.digest('hex')!==file.sha256)fail('PAYLOAD_DIGEST_MISMATCH');
      const after=await handle.stat({bigint:true}),current=await lstat(absolute,{bigint:true});
      if(!sameIdentity(held,after)||!sameIdentity(held,current)||current.isSymbolicLink()||
        current.nlink!==1n)fail('PAYLOAD_IDENTITY_CHANGED');
    }finally{await handle.close();}
  }
  for(const [directory,before] of directories){
    const after=await lstat(directory,{bigint:true});
    if(!after.isDirectory()||after.isSymbolicLink()||!sameIdentity(before,after))fail('PAYLOAD_DIRECTORY_CHANGED');
  }
  const latest=await readAnchor();
  if((Object.keys(anchor) as Array<keyof typeof anchor>).some(k=>latest[k]!==anchor[k]))
    fail('ANCHOR_CHANGED_DURING_VERIFICATION');
  // The final external readback can itself wait. Reinspect every identity
  // afterwards. This is still a candidate snapshot, not an atomic OS loader
  // admission; protected ACLs and a held native launch identity remain needed.
  for(const [relative,before] of found){
    const current=await lstat(path.join(root,...relative.split('/')),{bigint:true});
    if(!current.isFile()||current.isSymbolicLink()||current.nlink!==1n||!sameIdentity(before,current))
      fail('PAYLOAD_IDENTITY_CHANGED');
  }
  for(const [directory,before] of directories){
    if(!sameIdentity(before,await lstat(directory,{bigint:true})))fail('PAYLOAD_DIRECTORY_CHANGED');
  }
  return {manifestSha256:manifestHash,sourceCommit:manifest.sourceCommit,
    releaseSequence:manifest.releaseSequence,verifiedFiles:found.size,verifiedPayloadBytes:total,
    candidateFilesMatch:true,releaseAnchorAdvanced:false,authenticodePublisherVerified:false,
    protectedAclVerified:false,runtimeInstalled:false,canAuthorizeCore:false,
    physicalAcceptance:'NOT_PROVEN',productionCore:'NO_GO'};
}
