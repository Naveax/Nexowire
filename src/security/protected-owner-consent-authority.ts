import * as z from 'zod';
import {CoreNativeProofSchema} from '../protocol/core-native-consent-transport.js';
import {CoreWebAuthnIntentSchema,coreWebAuthnIntentHash} from './core-webauthn-approval.js';
import {CoreApprovalBindingSchema,type PostgresCoreApprovalLedger} from './postgres-core-approval-ledger.js';
import type {NativeCoreConsentAuthority,NativeCoreConsentChallenge} from '../agent/windows-core-console-provider.js';

const issuer=z.string().regex(/^[a-f0-9]{64}$/);
const challengeSchema=CoreNativeProofSchema.pick({version:true,challengeId:true,ownerAccountId:true,
  deviceId:true,installationId:true,enrollmentId:true,ownerEpoch:true,grantGeneration:true,revokeEpoch:true})
  .extend({issuerSpkiSha256:issuer});
const ownerSchema=z.strictObject({binding:CoreApprovalBindingSchema,issuerSpkiSha256:issuer,
  rpId:CoreWebAuthnIntentSchema.shape.rpId,credentialId:CoreWebAuthnIntentSchema.shape.credentialId});
type Owner=Readonly<z.infer<typeof ownerSchema>>;
type Ledger=Pick<PostgresCoreApprovalLedger,'issueChallenge'|'consumeAssertion'|'readOwnerApprovalProof'>;
export interface ProtectedOwnerAssertionLauncher {
  /** Installed Windows service must launch the pinned Authenticode/hash-verified
   * helper in the independently identified interactive owner token/session.
   * It must hold and validate the created process handle and its primary token,
   * bound stdout and deadline, and cancel/terminate on abort.
   * No shell, arbitrary executable, remote-supplied path or JS UI is permitted.
   * Raw assertion is still untrusted: the SQL ledger verifies its signature. */
  runBoundAssertion(input:Readonly<{
    helper:'windows-core-webauthn-approval.exe';
    args:readonly string[];
    owner:Owner;
  }>,signal:AbortSignal):Promise<unknown>;
}

function same(a:object,b:object):boolean{
  const left=a as Record<string,unknown>,right=b as Record<string,unknown>;
  const keys=Object.keys(left);
  return keys.length===Object.keys(right).length&&keys.every(k=>left[k]===right[k]);
}
function sameOwner(a:Owner,b:Owner):boolean{
  return same(a.binding,b.binding)&&a.issuerSpkiSha256===b.issuerSpkiSha256&&
    a.rpId===b.rpId&&a.credentialId===b.credentialId;
}
function snapshotOwner(value:unknown):Owner{
  const parsed=ownerSchema.parse(value);
  Object.freeze(parsed.binding);
  const bytes=Buffer.from(parsed.credentialId,'base64url');
  if(bytes.length<1||bytes.length>1024||bytes.toString('base64url')!==parsed.credentialId||
    parsed.binding.windowsSessionId>0xfffffffe)
    throw Error('CORE_OWNER_PROVISIONING_INVALID');
  return Object.freeze(parsed);
}

/** The local approval service's domain logic. It is deliberately not mounted
 * in the Agent process or the off-host enrollment verifier. A separate
 * protected owner directory supplies CURRENT provisioned identity, key and
 * authenticator, independent of the challenge or receipt supplied by Agent.
 * No production process launcher is manufactured from this JS interface.
 */
export function createProtectedOwnerConsentAuthority(config:{
  ledger:Ledger;
  readCurrentOwner:(signal:AbortSignal)=>Promise<unknown>;
  launcher:ProtectedOwnerAssertionLauncher;
}):NativeCoreConsentAuthority{
  if(typeof config.ledger?.issueChallenge!=='function'||typeof config.ledger.consumeAssertion!=='function'||
    typeof config.ledger.readOwnerApprovalProof!=='function'||typeof config.readCurrentOwner!=='function'||
    typeof config.launcher?.runBoundAssertion!=='function')throw Error('CORE_OWNER_AUTHORITY_REQUIRED');
  const issue=config.ledger.issueChallenge.bind(config.ledger);
  const consume=config.ledger.consumeAssertion.bind(config.ledger);
  const read=config.ledger.readOwnerApprovalProof.bind(config.ledger);
  const current=config.readCurrentOwner,launch=config.launcher.runBoundAssertion.bind(config.launcher);
  let busy=false;
  const live=async(signal:AbortSignal)=>{
    signal.throwIfAborted();
    const owner=snapshotOwner(await current(signal));
    signal.throwIfAborted();return owner;
  };
  const unchanged=async(owner:Owner,signal:AbortSignal)=>{
    if(!sameOwner(owner,await live(signal)))throw Error('CORE_OWNER_BINDING_CHANGED');
  };
  // The caller's cancellation cannot become an approval even if an injected
  // provider ignores AbortSignal. Keep the prompt latch until work settles.
  const bounded=async<T>(signal:AbortSignal,ms:number,work:(signal:AbortSignal)=>Promise<T>):Promise<T|null>=>{
    const active=AbortSignal.any([signal,AbortSignal.timeout(ms)]);
    if(active.aborted)return null;
    let onAbort:()=>void=()=>{};
    const aborted=new Promise<null>(resolve=>{onAbort=()=>resolve(null);});
    active.addEventListener('abort',onAbort,{once:true});
    try{return await Promise.race([work(active),aborted]);}
    catch{return null}finally{active.removeEventListener('abort',onAbort);}
  };
  return Object.freeze({
    async approveAndConsume(challenge:NativeCoreConsentChallenge,signal:AbortSignal){
      const parsed=challengeSchema.safeParse(challenge);
      if(!parsed.success||busy||signal.aborted)return null;
      const wanted=Object.freeze(parsed.data);
      busy=true;
      const result=await bounded(signal,110000,async active=>{
        try{
          const owner=await live(active);
          const {issuerSpkiSha256,challengeId,...scope}=wanted;
          if(issuerSpkiSha256!==owner.issuerSpkiSha256||
            !(Object.keys(scope) as Array<keyof typeof scope>).every(k=>scope[k]===owner.binding[k]))
            return null;
          const prepared=await issue({...owner.binding,issuerSpkiSha256,challengeId,
            rpId:owner.rpId,credentialId:owner.credentialId});
          const intent=Object.freeze(CoreWebAuthnIntentSchema.parse(prepared.intent));
          if(intent.challengeId!==challengeId||intent.issuerSpkiSha256!==issuerSpkiSha256||
            intent.rpId!==owner.rpId||intent.credentialId!==owner.credentialId||
            !same(CoreApprovalBindingSchema.parse(Object.fromEntries(Object.keys(CoreApprovalBindingSchema.shape)
              .map(k=>[k,(intent as Record<string,unknown>)[k]]))),owner.binding)||
            prepared.challengeHex!==coreWebAuthnIntentHash(intent)||intent.expiresAtMs<=Date.now())
            return null;
          await unchanged(owner,active);
          const args=Object.freeze(['--assert-bound',intent.rpId,prepared.challengeHex,
            Buffer.from(intent.credentialId,'base64url').toString('hex'),owner.binding.windowsUserSid,
            String(owner.binding.windowsSessionId),owner.binding.windowsLogonLuid.toLowerCase()]);
          const assertion=await launch(Object.freeze({helper:'windows-core-webauthn-approval.exe' as const,
            args,owner}),active);
          // No post-cancellation consume, no success from an obsolete token,
          // issuer, credential pin or enrollment. A consume that already started
          // may commit after cancellation; that tombstone is never retried.
          await unchanged(owner,active);
          if(intent.expiresAtMs<=Date.now())return null;
          const receipt=await consume(assertion,intent);
          active.throwIfAborted();
          if(receipt.challengeId!==challengeId||receipt.intentSha256!==prepared.challengeHex||
            receipt.consumed!==true)return null;
          const proof=Object.freeze(CoreNativeProofSchema.parse(await read(receipt.receiptId,
            owner.binding,issuerSpkiSha256)));
          await unchanged(owner,active);
          if(proof.challengeId!==challengeId||proof.receiptId!==receipt.receiptId||
            proof.approvedAtMs!==receipt.consumedAtMs||proof.approvedAtMs>Date.now()+2000||
            proof.approvedAtMs<Date.now()-120000||
            !(Object.keys(owner.binding) as Array<keyof typeof owner.binding>).every(k=>proof[k]===owner.binding[k]))
            return null;
          active.throwIfAborted();return proof;
        }finally{busy=false;}
      });
      // If the work never started (caller aborted between checks), clear only
      // when there was no active prompt. Normal work owns the latch until settled.
      return result;
    },
    async currentReadback(receiptId:string,signal:AbortSignal){
      if(!z.string().uuid().safeParse(receiptId).success)return null;
      return bounded(signal,3500,async active=>{
        const owner=await live(active);
        const proof=Object.freeze(CoreNativeProofSchema.parse(await read(receiptId,owner.binding,owner.issuerSpkiSha256)));
        await unchanged(owner,active);
        if(proof.receiptId!==receiptId||
          !(Object.keys(owner.binding) as Array<keyof typeof owner.binding>).every(k=>proof[k]===owner.binding[k]))
          return null;
        active.throwIfAborted();return proof;
      });
    }
  });
}
