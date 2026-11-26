import {createHash} from 'node:crypto';

/** Exact authenticated evidence bytes supplied by the independent provider.
 * This is a commitment codec, not a verifier, signer, or authorization API.
 * No OS effect or production admission may depend on this digest alone.
 */
export interface RecoveryEvidenceBinding {
  readonly purpose:'rollback'|'coordinated-uninstall';
  /** Canonical independently observed transaction identity, stable across retries. */
  readonly transactionIdentity:Uint8Array;
  readonly scope:Uint8Array;
  readonly ownerApproval:Uint8Array;
  readonly sqliteContinuity:Uint8Array;
  readonly writerFence:Uint8Array;
  readonly recoveryTaskAbsence:Uint8Array;
  readonly activationFence:Uint8Array;
  readonly runtimeManifest:Uint8Array;
  readonly releaseAnchor:Uint8Array;
  readonly runtimeHeldIdentity:Uint8Array;
  readonly helperHeldIdentity:Uint8Array;
  readonly terminalReceipt?:Uint8Array;
}
const fields=['scope','ownerApproval','sqliteContinuity','writerFence',
  'recoveryTaskAbsence','activationFence','runtimeManifest','releaseAnchor',
  'runtimeHeldIdentity','helperHeldIdentity'] as const;
function deny():never{throw Error('RECOVERY_EVIDENCE_BINDING_INVALID')}
function bytes(value:unknown):Buffer{
  if(!(value instanceof Uint8Array)||value.byteLength<1||value.byteLength>1024*1024)deny();
  return Buffer.from(value);
}
function digest(domain:string,parts:readonly Buffer[]):string{
  const hash=createHash('sha256').update(domain+'\0','utf8');
  for(const part of parts){
    const length=Buffer.alloc(4);length.writeUInt32BE(part.length);
    hash.update(length).update(part);
  }
  return hash.digest('hex');
}
/** No canonicalization of external evidence. Providers must agree on exact
 * authenticated encodings. The stable transaction must not contain request
 * nonces or fresh observations; those belong in scope/evidence instead.
 * A changed evidence packet changes the binding, never the transaction key.
 * Missing terminal evidence prevents an uninstall commitment.
 */
export function bindRecoveryEvidence(input:RecoveryEvidenceBinding):Readonly<{
  transactionSha256:string;bindingSha256:string;
}>{
  const purpose=input.purpose;
  if(purpose!=='rollback'&&purpose!=='coordinated-uninstall')deny();
  const transaction=bytes(input.transactionIdentity);
  const packets=fields.map(field=>bytes(input[field]));
  const receipt=input.terminalReceipt;
  if(purpose==='coordinated-uninstall'&&receipt===undefined)deny();
  const terminal=receipt===undefined?Buffer.alloc(0):bytes(receipt);
  const transactionSha256=digest('nexowire.recovery.transaction.v1',[transaction]);
  const bindingSha256=digest('nexowire.recovery.evidence-binding.v1',[
    Buffer.from(purpose,'utf8'),Buffer.from(transactionSha256,'hex'),...packets,terminal,
  ]);
  return Object.freeze({transactionSha256,bindingSha256});
}
