import {randomUUID} from 'node:crypto';
import {CoreNativeProofSchema,callProtectedCoreNativeAuthority,
  type CoreNativeProof,type CoreNativeWireRequest} from '../protocol/core-native-consent-transport.js';
import type {NativeCoreConsentAuthority,NativeCoreConsentChallenge,
  NativeCoreConsentProof} from './windows-core-console-provider.js';

/** Transport to a SEPARATELY INSTALLED native Windows approval service.
 * This module does not implement the service, display UI or establish human
 * presence. The service must have a protected signer, owner SID provisioning,
 * WTS/AuthenticationId readback and durable atomic one-use receipt ledger.
 * Never instantiate from an Agent-controlled URL, key, or fixture flag. */
export class ProtectedWindowsCoreConsentClient implements NativeCoreConsentAuthority {
  constructor(private readonly trusted:{
    origin:string;credential:string;pinnedSpkiBase64:string;
    fetchImpl?:typeof fetch;timeoutMs?:number;
  }){}
  private async call(operation:CoreNativeWireRequest['operation'],expected:unknown,signal:AbortSignal){
    if(signal.aborted)throw new Error('CORE_NATIVE_CALL_ABORTED');
    return callProtectedCoreNativeAuthority({...this.trusted,loopbackOnly:true},
      {version:1,operation,nonce:randomUUID(),expected},signal);
  }
  async approveAndConsume(challenge:NativeCoreConsentChallenge,
    signal:AbortSignal):Promise<NativeCoreConsentProof|null>{
    const response=await this.call('approve-and-consume',challenge,signal);
    const proof=CoreNativeProofSchema.parse(response.proof);
    if((Object.keys(challenge) as Array<keyof NativeCoreConsentChallenge>)
      .some(k=>proof[k]!==challenge[k])||
      proof.approvedAtMs>Date.now()+2000||proof.approvedAtMs<Date.now()-120000)
      throw new Error('CORE_NATIVE_APPROVAL_SCOPE_MISMATCH');
    return proof;
  }
  async currentReadback(receiptId:string,signal:AbortSignal):Promise<NativeCoreConsentProof|null>{
    const response=await this.call('current-readback',{receiptId},signal);
    const proof:CoreNativeProof=CoreNativeProofSchema.parse(response.proof);
    if(proof.receiptId!==receiptId)throw new Error('CORE_NATIVE_READBACK_RECEIPT_CHANGED');
    return proof;
  }
}
