import {createHash,createPublicKey} from 'node:crypto';
import {readFileSync,statSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import * as z from 'zod';

// Local public-record preflight only. Never import into a production admission
// path. No network, secret reader, signer, registration writer or grant.
const uuid=z.string().uuid().refine(v=>v!=='00000000-0000-0000-0000-000000000000');
const digest=z.string().regex(/^[a-f0-9]{64}$/);
const positive=z.number().int().positive().safe();
const publicId=z.string().min(1).max(128).regex(/^[A-Za-z0-9_.:@/-]+$/);
const receipt=digest;
const spki=z.strictObject({publicSpkiBase64:z.string().min(1).max(512),
  spkiSha256:digest,registrationReceiptSha256:receipt});
const signer=spki.extend({serviceIdentity:publicId,custodyReceiptSha256:receipt});
const domains=['recoveryAck','recoveryObserver','scheduledForward','scheduledRelease',
  'coreDispatch','coreNativeObserver','helperObserver','ownerDirectory',
  'restoreWitness','hostedVerifier'] as const;
const signers=z.strictObject({
  recoveryAck:signer,recoveryObserver:signer,scheduledForward:signer,scheduledRelease:signer,
  coreDispatch:signer,coreNativeObserver:signer,helperObserver:signer,
  ownerDirectory:signer,restoreWitness:signer,hostedVerifier:signer,
});
const publicRecords=z.strictObject({
  version:z.literal(1),
  owner:z.strictObject({ownerAccountId:z.string().min(8).max(128),ownerEpoch:positive,
    deviceId:uuid,installationId:uuid,installationLineageId:uuid,enrollmentId:uuid,
    grantGeneration:positive,revokeEpoch:z.number().int().nonnegative().safe(),
    windowsUserSid:z.string().max(184).regex(/^S-1-[0-9]+(?:-[0-9]+)+$/),
    mappingReceiptSha256:receipt}),
  directory:z.strictObject({directoryId:uuid,generation:positive,directoryHead:digest,
    registrationSha256:digest,restoreEpoch:uuid,continuityReceiptSha256:receipt}),
  authority:z.strictObject({authorityId:uuid,storeId:uuid,scheduledAuthorityId:uuid,
    scheduledStoreId:uuid,approvalAuthorityId:uuid,anchorReceiptSha256:receipt}),
  enrollmentKey:spki,
  authenticator:spki.extend({rpId:z.string().max(253).regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/),
    credentialId:z.string().max(1366).regex(/^[A-Za-z0-9_-]+$/)}),
  signers,
  hostedVerifier:z.strictObject({origin:z.string().max(2048),serverSpkiSha256:digest,
    clientCertificateSha256:digest,caCertificateSha256:digest,principalRegistrationReceiptSha256:receipt}),
  publisher:z.strictObject({
    NEXOWIRE_WINDOWS_JOB_PUBLISHER_THUMBPRINT:z.string().regex(/^[a-f0-9]{40}$/),
    NEXOWIRE_WINDOWS_JOB_SIGNER_SHA256:digest,
    NEXOWIRE_WINDOWS_JOB_PUBLISHER_SUBJECT:z.string().min(1).max(1024),
    NEXOWIRE_WINDOWS_JOB_ARTIFACT_SHA256:digest,
    NEXOWIRE_WINDOWS_SIGNTOOL_PATH:z.string().max(1024).regex(/^[A-Za-z]:\\[^\r\n]+\\signtool\.exe$/i),
    signedArtifactReceiptSha256:receipt,
  }),
});
type RecordSet=z.infer<typeof publicRecords>;
type PublicSpki=z.infer<typeof spki>;
function deny(code:string):never{throw Error(code)}
function verifiedPin(record:PublicSpki,algorithm:'ed25519'|'ec'):string{
  try{
    const der=Buffer.from(record.publicSpkiBase64,'base64');
    if(!der.length||der.toString('base64')!==record.publicSpkiBase64)throw Error();
    const key=createPublicKey({key:der,format:'der',type:'spki'});
    if(key.type!=='public'||key.asymmetricKeyType!==algorithm||
      (algorithm==='ec'&&key.asymmetricKeyDetails?.namedCurve!=='prime256v1')||
      !Buffer.from(key.export({type:'spki',format:'der'})).equals(der))throw Error();
    const actual=createHash('sha256').update(der).digest('hex');
    if(actual!==record.spkiSha256)throw Error();
    return actual;
  }catch{return deny('PUBLIC_PROVISIONING_SPKI_INVALID')}
}
function origin(value:string){
  try{
    const url=new URL(value);
    if(url.protocol!=='https:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash||
      value!==url.origin+'/')throw Error();
    return url.origin;
  }catch{return deny('PUBLIC_PROVISIONING_HOSTED_ORIGIN_INVALID')}
}
function receiptDigest(r:RecordSet):string{
  // This digest is of the validated PUBLIC configuration, not a signed
  // directory record, lifecycle anchor or a proof of custody.
  return createHash('sha256').update(JSON.stringify(r),'utf8').digest('hex');
}
export function reviewPublicProvisioning(raw:unknown){
  const parsed=publicRecords.safeParse(raw);
  // Do not print Zod errors, unknown keys, raw values or input file contents.
  if(!parsed.success)return deny('PUBLIC_PROVISIONING_SCHEMA_INCOMPLETE_OR_INVALID');
  const r=parsed.data;
  const pins=domains.map(d=>verifiedPin(r.signers[d],'ed25519'));
  pins.push(verifiedPin(r.enrollmentKey,'ed25519'),verifiedPin(r.authenticator,'ec'));
  if(new Set(pins).size!==pins.length)return deny('PUBLIC_PROVISIONING_SIGNER_REUSE');
  if(new Set(domains.map(d=>r.signers[d].serviceIdentity)).size!==domains.length)
    return deny('PUBLIC_PROVISIONING_SERVICE_IDENTITY_REUSE');
  if(r.authority.storeId===r.authority.scheduledStoreId)
    return deny('PUBLIC_PROVISIONING_STORE_IDENTITY_REUSE');
  const credential=Buffer.from(r.authenticator.credentialId,'base64url');
  if(!credential.length||credential.length>1024||credential.toString('base64url')!==r.authenticator.credentialId)
    return deny('PUBLIC_PROVISIONING_CREDENTIAL_INVALID');
  origin(r.hostedVerifier.origin);
  // Do not convert directoryHead into #1367 registrationSha256 or infer
  // installationLineageId from installationId. Their authenticated mapping
  // must be verified by the independent provider, not by this local review.
  return Object.freeze({status:'PUBLIC_RECORDS_MATCH_UNVERIFIED' as const,
    publicConfigurationSha256:receiptDigest(r),signingDomains:domains.length,
    ownerEpochDecimal:String(r.owner.ownerEpoch),
    // Only safe metadata; never credentials, raw keys, service endpoints,
    // raw owner identity, or a positive runtime binding/approval object.
    providerVerified:false as const,consentVerified:false as const,
    coreAuthority:false as const,recoveryAuthorized:false as const,
    activationAuthorized:false as const,releaseAuthorized:false as const,
    physicalAcceptance:'NOT_PROVEN' as const});
}
function main(){
  try{
    if(process.argv.length!==3)deny('PUBLIC_PROVISIONING_LOCAL_FILE_REQUIRED');
    const file=process.argv[2]!;
    if(!statSync(file).isFile()||statSync(file).size>131072)deny('PUBLIC_PROVISIONING_FILE_INVALID');
    const input:unknown=JSON.parse(readFileSync(file,'utf8'));
    process.stdout.write(JSON.stringify(reviewPublicProvisioning(input),null,2)+'\n');
  }catch(e){
    const message=e instanceof Error&&/^PUBLIC_PROVISIONING_[A-Z_]+$/.test(e.message)?
      e.message:'PUBLIC_PROVISIONING_FILE_INVALID';
    process.stderr.write(message+'\n');process.exitCode=1;
  }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main();
