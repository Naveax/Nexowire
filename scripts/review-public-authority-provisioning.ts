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
// Independently read public scope/registration records. These are compared
// for consistency only; their signatures/provenance must be verified by the
// actual provider. Do not synthesize them from the common owner input.
const scope=z.strictObject({ownerAccountId:z.string().min(8).max(128),
  ownerEpoch:z.string().regex(/^[1-9][0-9]{0,15}$/),deviceId:uuid,
  installationLineageId:uuid,directoryHead:digest,authorityId:uuid});
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
  bindings:z.strictObject({
    recovery:scope.extend({storeId:uuid,ackSpkiSha256:digest,observerSpkiSha256:digest}),
    scheduled:scope.extend({storeId:uuid,forwardSpkiSha256:digest,releaseSpkiSha256:digest}),
    core:scope.extend({installationId:uuid,enrollmentId:uuid,issuerSpkiSha256:digest,
      dispatchSpkiSha256:digest,nativeObserverSpkiSha256:digest,helperObserverSpkiSha256:digest,
      directoryGeneration:positive,registrationSha256:digest,approvalAuthorityId:uuid,
      grantGeneration:positive,revokeEpoch:z.number().int().nonnegative().safe(),
      windowsUserSid:z.string().max(184),rpId:z.string().max(253),credentialId:z.string().max(1366),
      authenticatorSpkiSha256:digest}),
  }),
  hostedVerifier:z.strictObject({origin:z.string().max(2048),serverSpkiSha256:digest,
    clientCertificateSha256:digest,caCertificateSha256:digest,principalRegistrationReceiptSha256:receipt,
    responseSignerSpkiSha256:digest,principal:z.strictObject({role:z.literal('independent-enrollment-verifier'),
      ownerAccountId:z.string().min(8).max(128),deviceId:uuid,installationId:uuid})}),
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
  const {recovery,scheduled,core}=r.bindings;
  for(const b of [recovery,scheduled,core]){
    if(b.ownerAccountId!==r.owner.ownerAccountId||b.ownerEpoch!==String(r.owner.ownerEpoch)||
      b.deviceId!==r.owner.deviceId||b.installationLineageId!==r.owner.installationLineageId||
      b.directoryHead!==r.directory.directoryHead)
      return deny('PUBLIC_PROVISIONING_OWNER_SCOPE_MISMATCH');
  }
  if(recovery.authorityId!==r.authority.authorityId||recovery.storeId!==r.authority.storeId||
    scheduled.authorityId!==r.authority.scheduledAuthorityId||scheduled.storeId!==r.authority.scheduledStoreId||
    core.authorityId!==r.authority.authorityId||core.installationId!==r.owner.installationId||
    core.enrollmentId!==r.owner.enrollmentId||core.directoryGeneration!==r.directory.generation||
    core.registrationSha256!==r.directory.registrationSha256||core.approvalAuthorityId!==r.authority.approvalAuthorityId||
    core.grantGeneration!==r.owner.grantGeneration||core.revokeEpoch!==r.owner.revokeEpoch||
    core.windowsUserSid!==r.owner.windowsUserSid||core.rpId!==r.authenticator.rpId||core.credentialId!==r.authenticator.credentialId)
    return deny('PUBLIC_PROVISIONING_REGISTRATION_MISMATCH');
  if(recovery.ackSpkiSha256!==r.signers.recoveryAck.spkiSha256||
    recovery.observerSpkiSha256!==r.signers.recoveryObserver.spkiSha256||
    scheduled.forwardSpkiSha256!==r.signers.scheduledForward.spkiSha256||
    scheduled.releaseSpkiSha256!==r.signers.scheduledRelease.spkiSha256||
    core.issuerSpkiSha256!==r.enrollmentKey.spkiSha256||
    core.dispatchSpkiSha256!==r.signers.coreDispatch.spkiSha256||
    core.nativeObserverSpkiSha256!==r.signers.coreNativeObserver.spkiSha256||
    core.helperObserverSpkiSha256!==r.signers.helperObserver.spkiSha256||
    core.authenticatorSpkiSha256!==r.authenticator.spkiSha256||
    r.hostedVerifier.responseSignerSpkiSha256!==r.signers.hostedVerifier.spkiSha256)
    return deny('PUBLIC_PROVISIONING_REGISTERED_PIN_MISMATCH');
  const principal=r.hostedVerifier.principal;
  if(principal.ownerAccountId!==r.owner.ownerAccountId||principal.deviceId!==r.owner.deviceId||
    principal.installationId!==r.owner.installationId)return deny('PUBLIC_PROVISIONING_HOSTED_SCOPE_MISMATCH');
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
