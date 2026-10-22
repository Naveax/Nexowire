/**
 * Staged #11 source-only acceptance contract. NEVER consume worker-supplied
 * JSON or a transfer RPC result as a trusted completion. The caller must
 * supply separately pinned off-host transport and owner-grant authorities.
 * No Agent/Hub, Artifact Store or ProcessManager mutation occurs here.
 */
import { createHash, verify, type KeyObject } from 'node:crypto';
import * as z from 'zod';

const sha = z.string().regex(/^[a-f0-9]{64}$/);
const id = z.string().min(1).max(128);
const when = z.string().datetime({offset:true});
const statementSchema = z.object({
  version:z.literal(1),
  ownerAccountId:id,deviceId:id,projectId:id,runId:id,sessionId:id,
  requestId:z.string().uuid(),grantId:id,ownerGrantEpoch:z.number().int().positive(),
  role:z.literal('CORE'), jobId:z.string().uuid(),
  sourceDeviceId:id,targetDeviceId:id,targetPath:z.string().min(1).max(4096),
  resultSetSha256:sha, immutableObjectSha256:sha, outputProofSha256:sha,
  completedCount:z.number().int().nonnegative().max(1000),
  pendingCount:z.literal(0), failureCount:z.literal(0),
  exitCode:z.literal(0),exitObservedAt:when,committedAt:when,
}).strict();
export type CompletionStatement = z.infer<typeof statementSchema>;
export interface SignedCompletion {
  statement:CompletionStatement;
  signatureBase64:string;
}
export interface OwnerGrantView {
  ownerAccountId:string;projectId:string;deviceId:string;grantId:string;
  epoch:number;role:'CORE'|'ROOT'|'FULL';
  state:'ACTIVE'|'CANCEL_REQUESTED'|'CANCELED'|'REVOKED'|'UNKNOWN';
}
export interface TransferView {
  id:string;state:string;sourceDeviceId:string;targetDeviceId:string;
  targetPath:string;bytesTotal:number;bytesConfirmed:number;sha256:string;
  /** #725 preserves typed native mutation provenance; never hide this. */
  errorCode?:string;
}
export interface OffhostRead {
  offset:number;totalBytes:number;contentBase64:string;
}
export interface SignedImmutableSeal {
  version:1;
  ownerAccountId:string;projectId:string;targetDeviceId:string;
  targetPath:string;jobId:string;ownerGrantEpoch:number;
  immutableObjectSha256:string;sealedAt:string;
  signatureBase64:string;
}
export function canonicalImmutableSeal(seal:Omit<SignedImmutableSeal,'signatureBase64'>):Buffer {
  return Buffer.from('NEXOWIRE_OFFHOST_IMMUTABLE_SEAL_V1\n'+
    JSON.stringify([seal.version,seal.ownerAccountId,seal.projectId,
      seal.targetDeviceId,seal.targetPath,seal.jobId,seal.ownerGrantEpoch,
      seal.immutableObjectSha256,seal.sealedAt])+'\n','utf8');
}
/** #754 final publication proof, obtained ONLY after an independently
 * protected verifier authenticates the Native publisher's original receipt.
 * This staging format is not a shipped Agent v1.0.5 signing protocol. */
export interface SignedFinalPublicationWitness {
  version:1; publicationRequestId:string; jobId:string;
  ownerAccountId:string;projectId:string;targetDeviceId:string;
  targetPath:string;bytesTotal:number;sha256:string;
  writerEpoch:number;publishedAt:string;signatureBase64:string;
}
export function canonicalFinalPublicationWitness(
  p:Omit<SignedFinalPublicationWitness,'signatureBase64'>):Buffer {
  return Buffer.from('NEXOWIRE_VERIFIED_FINAL_NATIVE_PUBLICATION_V1\\n'+
    JSON.stringify([p.version,p.publicationRequestId,p.jobId,
      p.ownerAccountId,p.projectId,p.targetDeviceId,p.targetPath,
      p.bytesTotal,p.sha256,p.writerEpoch,p.publishedAt])+'\\n','utf8');
}
/** Source-only #768 rollback-external atomic publication commit attestation.
 * Native final receipt and local WAL COMPLETED do not supply this proof. */
export interface SignedMonotonicPublicationCommit {
  version:1; durableCommitId:string; publicationRequestId:string;
  jobId:string;ownerAccountId:string;projectId:string;
  targetDeviceId:string;targetPath:string;sha256:string;
  bytesTotal:number;writerEpoch:number;ownerGrantEpoch:number;
  committedAt:string;signatureBase64:string;
}
export function canonicalMonotonicPublicationCommit(
  c:Omit<SignedMonotonicPublicationCommit,'signatureBase64'>):Buffer {
  return Buffer.from('NEXOWIRE_EXTERNAL_MONOTONIC_PUBLISH_COMMIT_V1\n'+
    JSON.stringify([c.version,c.durableCommitId,c.publicationRequestId,
      c.jobId,c.ownerAccountId,c.projectId,c.targetDeviceId,c.targetPath,
      c.sha256,c.bytesTotal,c.writerEpoch,c.ownerGrantEpoch,c.committedAt])+
      '\n','utf8');
}
export interface TrustedCompletionPorts {
  /** Independently authenticated readback from rollback-external #768 CAS. */
  readMonotonicPublicationCommit():Promise<SignedMonotonicPublicationCommit>;
  /** Only independently authenticated and witnessed #754 final Native publish. */
  readFinalPublicationWitness():Promise<SignedFinalPublicationWitness>;
  /** Signed by independently pinned immutable off-host storage authority. */
  readImmutableSeal():Promise<SignedImmutableSeal>;
  /** Trusted authority separate from worker and from mutable result files. */
  readGrant():Promise<OwnerGrantView>;
  /** Authenticated #616 status, never an authority for completion by itself. */
  readTransfer():Promise<TransferView>;
  /** Authenticated read from a DIFFERENT device than the worker's host. */
  readOffhost(offset:number,maxBytes:number):Promise<OffhostRead>;
}
export interface CompletionExpected {
  ownerAccountId:string;deviceId:string;projectId:string;runId:string;
  sessionId:string;requestId:string;grantId:string;ownerGrantEpoch:number;
  /** Pinned from authenticated durable #754 journal, NOT a worker ACK. */
  publicationRequestId:string;writerEpoch:number;
  sourceDeviceId:string;targetDeviceId:string;targetPath:string;
  resultSetSha256:string;outputProofSha256:string;completedCount:number;
  exitObservedAt:string;
}
const DOMAIN='NEXOWIRE_TRUSTED_COMPLETION_V1\n';
/** Canonical order independent of object property order or JSON additions. */
export function canonicalCompletionStatement(statement:CompletionStatement):Buffer {
  const s=statementSchema.parse(statement);
  return Buffer.from(DOMAIN+JSON.stringify([
    s.version,s.ownerAccountId,s.deviceId,s.projectId,s.runId,s.sessionId,
    s.requestId,s.grantId,s.ownerGrantEpoch,s.role,s.jobId,
    s.sourceDeviceId,s.targetDeviceId,s.targetPath,
    s.resultSetSha256,s.immutableObjectSha256,s.outputProofSha256,
    s.completedCount,s.pendingCount,s.failureCount,s.exitCode,
    s.exitObservedAt,s.committedAt,
  ])+'\n','utf8');
}
const validProofs = new WeakSet<object>();
const proofBrand:unique symbol=Symbol('verified-offhost-completion');
export interface VerifiedCompletionPermit {
  readonly [proofBrand]:true;
  readonly statement:CompletionStatement;
  readonly verifiedAt:number;
}
export function isVerifiedCompletionPermit(value:unknown):value is VerifiedCompletionPermit {
  return typeof value==='object'&&value!==null&&validProofs.has(value);
}
function matchesGrant(v:OwnerGrantView,s:CompletionStatement):boolean {
  return v.ownerAccountId===s.ownerAccountId&&v.projectId===s.projectId&&
    v.deviceId===s.deviceId&&v.grantId===s.grantId&&
    v.epoch===s.ownerGrantEpoch&&v.role==='CORE'&&v.state==='ACTIVE';
}
function matchesTransfer(v:TransferView,s:CompletionStatement):boolean {
  return v.id===s.jobId&&v.state==='COMPLETED'&&
    v.errorCode===undefined&&
    v.sourceDeviceId===s.sourceDeviceId&&v.targetDeviceId===s.targetDeviceId&&
    v.targetPath===s.targetPath&&v.sha256===s.immutableObjectSha256&&
    Number.isSafeInteger(v.bytesTotal)&&v.bytesTotal>=1&&v.bytesTotal<=131072&&
    v.bytesConfirmed===v.bytesTotal;
}
function refuse():null{return null;}
/**
 * Strict fail-closed. No signed declaration is sufficient without actual
 * second-device content readback. The off-host object must contain an exact
 * structured description of the independently hashed result-set digest,
 * output SHA, owner grant/epoch, process exit and counts.
 */
export async function verifyOffhostCompletion(
  signed:SignedCompletion,
  expected:CompletionExpected,
  pinnedPublicKey:KeyObject,
  pinnedStoragePublicKey:KeyObject,
  pinnedPublicationPublicKey:KeyObject,
  pinnedMonotonicCommitPublicKey:KeyObject,
  ports:TrustedCompletionPorts,
  now:()=>number=Date.now,
):Promise<VerifiedCompletionPermit|null>{
  try {
    const parsed=statementSchema.safeParse(signed?.statement);
    if(!parsed.success||!pinnedPublicKey||pinnedPublicKey.type!=='public'||
       pinnedPublicKey.asymmetricKeyType!=='ed25519'||
       pinnedStoragePublicKey?.type!=='public'||
       pinnedStoragePublicKey.asymmetricKeyType!=='ed25519'||
       pinnedPublicationPublicKey?.type!=='public'||
       pinnedPublicationPublicKey.asymmetricKeyType!=='ed25519'||
       pinnedMonotonicCommitPublicKey?.type!=='public'||
       pinnedMonotonicCommitPublicKey.asymmetricKeyType!=='ed25519'||
       pinnedPublicKey.export({type:'spki',format:'der'}).equals(
         pinnedStoragePublicKey.export({type:'spki',format:'der'}))||
       pinnedPublicationPublicKey.export({type:'spki',format:'der'}).equals(
         pinnedStoragePublicKey.export({type:'spki',format:'der'}))||
       pinnedPublicationPublicKey.export({type:'spki',format:'der'}).equals(
         pinnedPublicKey.export({type:'spki',format:'der'}))||
       [pinnedPublicKey,pinnedStoragePublicKey,pinnedPublicationPublicKey].some(
         k=>pinnedMonotonicCommitPublicKey.export({type:'spki',format:'der'}).equals(
           k.export({type:'spki',format:'der'}))))return refuse();
    const s=parsed.data;
    const keys=['ownerAccountId','deviceId','projectId','runId','sessionId',
      'requestId','grantId','ownerGrantEpoch','sourceDeviceId','targetDeviceId',
      'targetPath','resultSetSha256','outputProofSha256','completedCount',
      'exitObservedAt'] as const;
    if(keys.some(k=>s[k]!==expected[k])||s.sourceDeviceId===s.targetDeviceId||
       s.pendingCount!==0||s.failureCount!==0||s.exitCode!==0)return refuse();
    const exit=Date.parse(s.exitObservedAt),commit=Date.parse(s.committedAt),t=now();
    if(!Number.isFinite(exit)||!Number.isFinite(commit)||commit>exit+2000||
       commit>t+2000||exit>t+2000||t-commit>30000||
       !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(signed.signatureBase64))return refuse();
    const sig=Buffer.from(signed.signatureBase64,'base64');
    if(sig.length!==64||sig.toString('base64')!==signed.signatureBase64||
       !verify(null,canonicalCompletionStatement(s),pinnedPublicKey,sig))return refuse();
    const [g0,t0]=await Promise.all([ports.readGrant(),ports.readTransfer()]);
    if(!matchesGrant(g0,s)||!matchesTransfer(t0,s))return refuse();
    const hasher=createHash('sha256');
    const buffers:Buffer[]=[];
    let position=0,wholeSize:number|null=null;
    while(wholeSize===null||position<wholeSize){
      if(position>=131072)return refuse();
      const chunk=await ports.readOffhost(position,Math.min(65536,131072-position));
      if(!chunk||!Number.isSafeInteger(chunk.totalBytes)||
         chunk.totalBytes<1||chunk.totalBytes>131072||
         (wholeSize!==null&&chunk.totalBytes!==wholeSize)||
         chunk.offset!==position||
         typeof chunk.contentBase64!=='string'||chunk.contentBase64.length>87384||
         !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(chunk.contentBase64))
        return refuse();
      wholeSize=chunk.totalBytes;
      const bytes=Buffer.from(chunk.contentBase64,'base64');
      if(bytes.length===0||bytes.length>65536||
         bytes.length>wholeSize-position||
         bytes.toString('base64')!==chunk.contentBase64)return refuse();
      hasher.update(bytes);buffers.push(bytes);position+=bytes.length;
    }
    if(wholeSize===null||position!==wholeSize||
       hasher.digest('hex')!==s.immutableObjectSha256)return refuse();
    const bytes=Buffer.concat(buffers,wholeSize);
    const signedObject=JSON.parse(bytes.toString('utf8')) as unknown;
    const {immutableObjectSha256:_remoteDigest,...attestedContents}=s;
    if(!signedObject||typeof signedObject!=='object'||Array.isArray(signedObject)||
       JSON.stringify(signedObject)!==JSON.stringify(attestedContents))return refuse();
    // Independent immutable-storage seal: result signer cannot sign this.
    const seal=await ports.readImmutableSeal();
    const sig64=seal?.signatureBase64;
    if(!seal||seal.version!==1||seal.ownerAccountId!==s.ownerAccountId||
       seal.projectId!==s.projectId||seal.targetDeviceId!==s.targetDeviceId||
       seal.targetPath!==s.targetPath||seal.jobId!==s.jobId||
       seal.ownerGrantEpoch!==s.ownerGrantEpoch||
       seal.immutableObjectSha256!==s.immutableObjectSha256||
       Date.parse(seal.sealedAt)<commit-2000 || Date.parse(seal.sealedAt)>now()+2000||
       typeof sig64!=='string'||
       !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(sig64))return refuse();
    const sealSig=Buffer.from(sig64,'base64');
    if(sealSig.length!==64||sealSig.toString('base64')!==sig64||
       !verify(null,canonicalImmutableSeal({
         version:1,ownerAccountId:seal.ownerAccountId,projectId:seal.projectId,
         targetDeviceId:seal.targetDeviceId,targetPath:seal.targetPath,
         jobId:seal.jobId,ownerGrantEpoch:seal.ownerGrantEpoch,
         immutableObjectSha256:seal.immutableObjectSha256,sealedAt:seal.sealedAt,
       }),pinnedStoragePublicKey,sealSig))return refuse();
    // Metadata seal is NOT the final Native publication ACK. #754 requires
    // another independent, cryptographically authenticated publisher witness.
    const final=await ports.readFinalPublicationWitness();
    if(!final||final.version!==1||
       !z.string().uuid().safeParse(final.publicationRequestId).success||
       final.jobId!==s.jobId||final.ownerAccountId!==s.ownerAccountId||
       final.projectId!==s.projectId||final.targetDeviceId!==s.targetDeviceId||
       final.publicationRequestId!==expected.publicationRequestId||
       final.writerEpoch!==expected.writerEpoch||
       final.targetPath!==s.targetPath||
       final.sha256!==s.immutableObjectSha256||final.bytesTotal!==wholeSize||
       !Number.isSafeInteger(final.writerEpoch)||final.writerEpoch<1||
       typeof final.publishedAt!=='string'||
       !Number.isFinite(Date.parse(final.publishedAt))||
       Date.parse(final.publishedAt)<commit-2000||
       Date.parse(final.publishedAt)>now()+2000||
       now()-Date.parse(final.publishedAt)>30000||
       typeof final.signatureBase64!=='string'||
       !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(final.signatureBase64))return refuse();
    const publicationSig=Buffer.from(final.signatureBase64,'base64');
    const {signatureBase64:_signature,...finalBody}=final;
    if(publicationSig.length!==64||
       publicationSig.toString('base64')!==final.signatureBase64||
       !verify(null,canonicalFinalPublicationWitness(finalBody),
         pinnedPublicationPublicKey,publicationSig))return refuse();
    // Signed Native publication is only a side-effect receipt. #768 requires
    // independently durable, monotonic commitPublished before COMPLETED.
    const commitWitness=await ports.readMonotonicPublicationCommit();
    if(!commitWitness||commitWitness.version!==1||
       !z.string().uuid().safeParse(commitWitness.durableCommitId).success||
       commitWitness.publicationRequestId!==final.publicationRequestId||
       commitWitness.publicationRequestId!==expected.publicationRequestId||
       commitWitness.jobId!==s.jobId||commitWitness.ownerAccountId!==s.ownerAccountId||
       commitWitness.projectId!==s.projectId||
       commitWitness.targetDeviceId!==s.targetDeviceId||
       commitWitness.targetPath!==s.targetPath||
       commitWitness.sha256!==s.immutableObjectSha256||
       commitWitness.bytesTotal!==wholeSize||
       commitWitness.writerEpoch!==expected.writerEpoch||
       commitWitness.writerEpoch!==final.writerEpoch||
       commitWitness.ownerGrantEpoch!==s.ownerGrantEpoch||
       commitWitness.ownerGrantEpoch!==expected.ownerGrantEpoch||
       typeof commitWitness.committedAt!=='string'||
       !Number.isFinite(Date.parse(commitWitness.committedAt))||
       Date.parse(commitWitness.committedAt)<Date.parse(final.publishedAt)-2000||
       Date.parse(commitWitness.committedAt)>now()+2000||
       now()-Date.parse(commitWitness.committedAt)>30000||
       typeof commitWitness.signatureBase64!=='string'||
       !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(commitWitness.signatureBase64))return refuse();
    const commitSig=Buffer.from(commitWitness.signatureBase64,'base64');
    const {signatureBase64:_commitSignature,...commitBody}=commitWitness;
    if(commitSig.length!==64||
       commitSig.toString('base64')!==commitWitness.signatureBase64||
       !verify(null,canonicalMonotonicPublicationCommit(commitBody),
         pinnedMonotonicCommitPublicKey,commitSig))return refuse();
    // Recheck owner epoch/cancellation and remote final state AFTER readback.
    const [g1,t1]=await Promise.all([ports.readGrant(),ports.readTransfer()]);
    if(!matchesGrant(g1,s)||!matchesTransfer(t1,s)||now()-t>30000)return refuse();
    const permit=Object.freeze({
      [proofBrand]:true as const,statement:Object.freeze({...s}),verifiedAt:now(),
    });
    validProofs.add(permit);
    return permit;
  }catch{return refuse();}
}
