import {createHash,timingSafeEqual} from 'node:crypto';
import {isIP} from 'node:net';
import * as z from 'zod';
import {createProtectedPostgresDispatchPool} from '../agent/protected-postgres-dispatch-pool.js';
import {PostgresCoreApprovalLedger} from './postgres-core-approval-ledger.js';
import {createCoreNativeEnrollmentVerifierHandler,type CoreNativeVerifierPrincipal}
  from './core-native-enrollment-verifier-handler.js';
import {createCoreNativeVerifierServer,type CoreNativeVerifierServerOptions}
  from './core-native-verifier-server.js';

const sha256=z.string().regex(/^[a-f0-9]{64}$/);
const recordSchema=z.strictObject({
  credentialSha256:sha256,certificateSha256:sha256,
  ownerAccountId:z.string().min(8).max(128),
  deviceId:z.string().min(8).max(128),installationId:z.string().uuid(),
  notBeforeMs:z.number().int().nonnegative().safe(),
  expiresAtMs:z.number().int().positive().safe(),
}).refine(v=>v.expiresAtMs>v.notBeforeMs);
export type ProtectedVerifierCredentialRecord=z.infer<typeof recordSchema>;
type VerifierHandlerOptions=Parameters<typeof createCoreNativeEnrollmentVerifierHandler>[0];
type LedgerOptions=ConstructorParameters<typeof PostgresCoreApprovalLedger>[0];

/** Provisioning belongs to the independent operator, never the Agent or HTTP
 * body. Credential records contain only hashes and exact scoped identities.
 * Rotation/revocation requires replacing this protected configuration and
 * restarting the service; every ledger operation still checks live binding.
 */
export function createScopedNativeVerifierResolver(
  records:readonly ProtectedVerifierCredentialRecord[],
):VerifierHandlerOptions['authenticateVerifier']{
  const parsed=z.array(recordSchema).min(1).max(4096).safeParse(records);
  if(!parsed.success)throw Error('CORE_NATIVE_VERIFIER_PROVISIONING_INVALID');
  const pinned=new Map<string,Readonly<ProtectedVerifierCredentialRecord>>();
  for(const value of parsed.data){
    if(pinned.has(value.credentialSha256))
      throw Error('CORE_NATIVE_VERIFIER_CREDENTIAL_DUPLICATE');
    pinned.set(value.credentialSha256,Object.freeze({...value}));
  }
  return async(credential,peer,signal):Promise<CoreNativeVerifierPrincipal|null>=>{
    if(signal.aborted||typeof credential!=='string'||
      !/^[A-Za-z0-9_-]{32,2048}$/.test(credential)||
      !sha256.safeParse(peer.certificateSha256).success)return null;
    const digest=createHash('sha256').update(credential,'utf8').digest('hex');
    const record=pinned.get(digest),now=Date.now();
    if(!record||!Number.isSafeInteger(now)||now<record.notBeforeMs||
      now>=record.expiresAtMs||!timingSafeEqual(
        Buffer.from(record.certificateSha256,'hex'),
        Buffer.from(peer.certificateSha256,'hex')))return null;
    return Object.freeze({role:'independent-enrollment-verifier',
      ownerAccountId:record.ownerAccountId,deviceId:record.deviceId,
      installationId:record.installationId});
  };
}

export interface CoreNativeVerifierServiceOptions {
  readonly host:string;readonly port:number;
  readonly authorityId:string;
  readonly database:Parameters<typeof createProtectedPostgresDispatchPool>[0];
  readonly tls:Omit<CoreNativeVerifierServerOptions,'handler'>;
  readonly credentialRecords:readonly ProtectedVerifierCredentialRecord[];
  readonly verifyProvenance:LedgerOptions['verifyProvenance'];
  readonly readProtectedNativeBinding:LedgerOptions['readProtectedNativeBinding'];
  readonly signer:VerifierHandlerOptions['signer'];
  readonly verifierTimeoutMs?:number;
}

/** Explicit off-host deployment composition. No environment-derived grants,
 * default listener, synthetic ledger, automatic migration or enrollment.
 * The only HTTP operations are the existing verify/consume and readback
 * handler; the native provider, signer and restore witness are provisioned
 * independently. Binding the socket proves neither DB nor native readiness.
 */
export async function startCoreNativeVerifierService(config:CoreNativeVerifierServiceOptions):
  Promise<Readonly<{address:string;port:number;physicalAcceptance:'NOT_PROVEN';close:()=>Promise<void>}>>{
  const {host,port,authorityId,database,tls,credentialRecords,
    verifyProvenance,readProtectedNativeBinding,signer,verifierTimeoutMs}=config;
  // Port zero is useful for isolated tests, never an implicit port default.
  // Explicit IP bind avoids DNS-dependent listen semantics.
  if(typeof host!=='string'||isIP(host)===0||
    !Number.isInteger(port)||port<0||port>65535||
    !z.string().uuid().safeParse(authorityId).success||
    typeof verifyProvenance!=='function'||typeof readProtectedNativeBinding!=='function'||
    typeof signer?.sign!=='function')throw Error('CORE_NATIVE_VERIFIER_SERVICE_CONFIGURATION_REQUIRED');
  const authenticateVerifier=createScopedNativeVerifierResolver(credentialRecords);
  const db=createProtectedPostgresDispatchPool(database);
  let server:ReturnType<typeof createCoreNativeVerifierServer>|undefined;
  let closing:Promise<void>|undefined;
  const close=():Promise<void>=>{
    if(closing)return closing;
    closing=(async()=>{
      try{
        if(server?.listening){
          const active=server;
          await new Promise<void>((resolve,reject)=>{
            active.close(error=>error?reject(error):resolve());
            active.closeAllConnections();
          });
        }
      }finally{await db.close();}
    })();
    return closing;
  };
  try{
    const ledger=new PostgresCoreApprovalLedger({authorityId,pool:db.pool,
      verifyProvenance,readProtectedNativeBinding});
    const handler=createCoreNativeEnrollmentVerifierHandler({ledger,
      authenticateVerifier,signer,timeoutMs:verifierTimeoutMs});
    const listener=createCoreNativeVerifierServer({...tls,handler});
    server=listener;
    await new Promise<void>((resolve,reject)=>{
      const failed=()=>reject(Error('CORE_NATIVE_VERIFIER_LISTEN_FAILED'));
      listener.once('error',failed);
      listener.listen({host,port,exclusive:true},()=>{
        listener.off('error',failed);resolve();
      });
    });
    // A later listener error fences this service instead of leaving an
    // unhandled event or restarting it without independent reconciliation.
    listener.on('error',()=>{void close().catch(()=>{});});
    const addr=listener.address();
    if(!addr||typeof addr==='string')throw Error('CORE_NATIVE_VERIFIER_LISTEN_FAILED');
    return Object.freeze({address:addr.address,port:addr.port,
      physicalAcceptance:'NOT_PROVEN' as const,close});
  }catch{
    await close().catch(()=>{});
    throw Error('CORE_NATIVE_VERIFIER_SERVICE_START_FAILED');
  }
}
