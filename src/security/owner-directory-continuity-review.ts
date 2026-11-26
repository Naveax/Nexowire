import {createHash,createPublicKey,randomBytes,verify,type KeyObject} from 'node:crypto';
import * as z from 'zod';
import {CoreApprovalBindingSchema} from './postgres-core-approval-ledger.js';
import {CoreWebAuthnIntentSchema} from './core-webauthn-approval.js';

const hash=z.string().regex(/^[a-f0-9]{64}$/);
const positive=z.number().int().positive().safe();
const scope=CoreApprovalBindingSchema.pick({ownerAccountId:true,deviceId:true,installationId:true});
const registration=z.strictObject({
  version:z.literal(1),kind:z.literal('core_owner_directory_registration_v1'),
  authorityId:z.string().uuid(),directoryId:z.string().uuid(),nonce:hash,
  generation:positive,restoreEpoch:z.string().uuid(),state:z.literal('REGISTERED'),
  binding:CoreApprovalBindingSchema,issuerSpkiSha256:hash,
  rpId:CoreWebAuthnIntentSchema.shape.rpId,credentialId:CoreWebAuthnIntentSchema.shape.credentialId,
  observedAtMs:positive,
});
const continuity=z.strictObject({
  version:z.literal(1),kind:z.literal('core_owner_directory_continuity_v1'),
  authorityId:z.string().uuid(),directoryId:z.string().uuid(),nonce:hash,
  scope,generation:positive,restoreEpoch:z.string().uuid(),registrationSha256:hash,
  observedAtMs:positive,
});
const envelope=z.strictObject({payload:z.string().min(1).max(16384),signature:z.string().length(86)});
type Scope=z.infer<typeof scope>;
type Query=Readonly<{authorityId:string;directoryId:string;scope:Readonly<Scope>;nonce:string}>;
const denied=()=>Error('CORE_OWNER_DIRECTORY_REVIEW_UNVERIFIED');

function publicPin(pem:string):KeyObject{
  if(typeof pem!=='string'||!/^-----BEGIN PUBLIC KEY-----\r?\n[A-Za-z0-9+/=\r\n]+-----END PUBLIC KEY-----\s*$/.test(pem))
    throw denied();
  const k=createPublicKey(pem);
  if(k.asymmetricKeyType!=='ed25519')throw denied();
  return k;
}
function bytes(value:string,max:number):Buffer{
  if(!/^[A-Za-z0-9_-]+$/.test(value))throw denied();
  const b=Buffer.from(value,'base64url');
  if(!b.length||b.length>max||b.toString('base64url')!==value)throw denied();
  return b;
}
function authenticated(raw:unknown,key:KeyObject,domain:string){
  const e=envelope.parse(raw),payload=bytes(e.payload,12288),sig=bytes(e.signature,64);
  if(sig.length!==64||!verify(null,Buffer.concat([Buffer.from(domain+'\0'),payload]),key,sig))throw denied();
  return {payload,value:JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(payload)) as unknown};
}
const sameScope=(a:Scope,b:Scope)=>a.ownerAccountId===b.ownerAccountId&&
  a.deviceId===b.deviceId&&a.installationId===b.installationId;

/**
 * Read-only provisioning review. Not an issuer, registration writer, or
 * NativeCoreConsentAuthority. No binding or proof suitable for admission is
 * returned. Both roots must be installed independently of the caller and
 * restorable directory. A matching signed snapshot is NOT owner consent.
 *
 * The continuity service must freshly read its own independently durable
 * latest record, not sign a digest supplied by the directory or reviewer.
 * A compromised/rolled-back pair of signers is outside this check's trust
 * assumptions. There is no local-file fallback.
 */
export function createOwnerDirectoryContinuityReview(config:{
  authorityId:string;directoryId:string;scope:Scope;
  directoryPublicKeyPem:string;continuityPublicKeyPem:string;
  readDirectory:(query:Query,signal:AbortSignal)=>Promise<unknown>;
  readContinuity:(query:Query,signal:AbortSignal)=>Promise<unknown>;
}){
  const authorityId=z.string().uuid().parse(config.authorityId),
    directoryId=z.string().uuid().parse(config.directoryId),expected=Object.freeze(scope.parse(config.scope));
  const directoryKey=publicPin(config.directoryPublicKeyPem),continuityKey=publicPin(config.continuityPublicKeyPem);
  if(directoryKey.export({type:'spki',format:'der'}).equals(continuityKey.export({type:'spki',format:'der'}))||
    typeof config.readDirectory!=='function'||typeof config.readContinuity!=='function')throw denied();
  const readDirectory=config.readDirectory,readContinuity=config.readContinuity;
  // Process-local extra fence ONLY. Cross-restart continuity relies on the
  // independently durable witness, not on this value.
  let watermark:{generation:number;restoreEpoch:string;stateSha256:string}|undefined,busy=false;
  return async(signal:AbortSignal):Promise<Readonly<{
    generation:number;restoreEpoch:string;registrationSha256:string;
    status:'REVIEW_MATCH';coreAuthority:false;physicalAcceptance:'NOT_PROVEN';
  }>>=>{
    if(busy||signal.aborted)throw denied();
    busy=true;
    const start=Date.now(),ticks=process.hrtime.bigint();
    const active=AbortSignal.any([signal,AbortSignal.timeout(1800)]);
    let onAbort=()=>{};
    const cancelled=new Promise<never>((_,reject)=>{onAbort=()=>reject(denied());});
    active.addEventListener('abort',onAbort,{once:true});
    const check=()=>{
      if(active.aborted||Date.now()<start||Date.now()-start>=1800||
        process.hrtime.bigint()-ticks>=1800000000n)throw denied();
    };
    try{
      check();
      const q=Object.freeze({authorityId,directoryId,scope:expected,nonce:randomBytes(32).toString('hex')});
      // Neither query contains an enrollment ID, key, generation or digest
      // chosen by the requesting Agent. Each source reads its own latest state.
      const [d,w]=await Promise.race([Promise.all([
        Promise.resolve().then(()=>readDirectory(q,active)),
        Promise.resolve().then(()=>readContinuity(q,active))
      ]),cancelled]);
      check();
      const dr=authenticated(d,directoryKey,'nexowire.owner-directory.registration.v1'),
        wr=authenticated(w,continuityKey,'nexowire.owner-directory.continuity.v1');
      const record=registration.parse(dr.value),witness=continuity.parse(wr.value);
      const credential=bytes(record.credentialId,1024);
      if(!credential.length||record.binding.windowsSessionId>0xfffffffe)throw denied();
      // Digest stable state, not the fresh transport nonce or observation time.
      const {nonce:_nonce,observedAtMs:_time,...state}=record;
      const stateSha256=createHash('sha256').update(JSON.stringify(state),'utf8').digest('hex');
      const fresh=(v:{authorityId:string;directoryId:string;nonce:string;observedAtMs:number})=>
        v.authorityId===authorityId&&v.directoryId===directoryId&&v.nonce===q.nonce&&
        v.observedAtMs>=start&&v.observedAtMs<=Date.now();
      if(!fresh(record)||!fresh(witness)||!sameScope(record.binding,expected)||
        !sameScope(witness.scope,expected)||witness.generation!==record.generation||
        witness.restoreEpoch!==record.restoreEpoch||witness.registrationSha256!==stateSha256||
        (watermark&&(record.generation<watermark.generation||
          (record.generation===watermark.generation&&(record.restoreEpoch!==watermark.restoreEpoch||
            stateSha256!==watermark.stateSha256)))))throw denied();
      check();
      watermark={generation:record.generation,restoreEpoch:record.restoreEpoch,stateSha256};
      return Object.freeze({generation:record.generation,restoreEpoch:record.restoreEpoch,
        registrationSha256:stateSha256,status:'REVIEW_MATCH' as const,coreAuthority:false as const,
        physicalAcceptance:'NOT_PROVEN' as const});
    }catch{throw denied();}
    finally{active.removeEventListener('abort',onAbort);busy=false;}
  };
}
