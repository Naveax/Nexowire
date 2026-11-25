import {createHash,createPublicKey,timingSafeEqual} from 'node:crypto';
import {isIP} from 'node:net';
import * as z from 'zod';
import {createProtectedPostgresDispatchPool} from './protected-postgres-dispatch-pool.js';
import {PostgresBrokerDispatchAuthority} from './postgres-broker-dispatch-authority.js';
import {createBrokerDispatchAuthorityHandler} from './broker-dispatch-authority-handler.js';
import {createCoreNativeVerifierServer,type CoreNativeVerifierServerOptions}
  from '../security/core-native-verifier-server.js';

const uuid=z.string().uuid(),sha256=z.string().regex(/^[a-f0-9]{64}$/);
const record=z.strictObject({
  credentialSha256:sha256,certificateSha256:sha256,
  brokerId:uuid,ownerId:uuid,deviceId:uuid,installationId:uuid,
  deviceEpoch:uuid,sessionEpoch:uuid,state:z.literal('ACTIVE'),
  notBeforeMs:z.number().int().nonnegative().safe(),
  expiresAtMs:z.number().int().positive().safe(),
}).refine(v=>v.expiresAtMs>v.notBeforeMs);
export type ProtectedDispatchCredentialRecord=Readonly<z.infer<typeof record>>;
type HandlerOptions=Parameters<typeof createBrokerDispatchAuthorityHandler>[0];
type AuthorityOptions=ConstructorParameters<typeof PostgresBrokerDispatchAuthority>[0];

export interface ProtectedDispatchCredentialStore {
  /** Live independent lookup; revoked, unknown and expired records must deny.
   * The store receives a digest, not the bearer credential. */
  lookup(credentialSha256:string):Promise<unknown>;
  /** Independently verify the current installation, owner and Broker binding.
   * A record or certificate is not native owner consent or token evidence. */
  verifyLiveBinding(record:ProtectedDispatchCredentialRecord):Promise<boolean>;
}

export function createScopedDispatchBrokerResolver(store:ProtectedDispatchCredentialStore):
  HandlerOptions['authenticateBroker']{
  if(typeof store?.lookup!=='function'||typeof store.verifyLiveBinding!=='function')
    throw Error('DISPATCH_CREDENTIAL_STORE_REQUIRED');
  const lookup=store.lookup.bind(store),verifyLiveBinding=store.verifyLiveBinding.bind(store);
  return async(credential,peer)=>{
    if(typeof credential!=='string'||!/^[A-Za-z0-9_-]{32,2048}$/.test(credential)||
      !sha256.safeParse(peer?.certificateSha256).success)return undefined;
    const digest=createHash('sha256').update(credential,'utf8').digest('hex');
    const peerHash=peer!.certificateSha256;
    try{
      const parsed=record.safeParse(await lookup(digest));
      if(!parsed.success)return undefined;
      const current=Object.freeze(parsed.data);
      if(!timingSafeEqual(Buffer.from(digest,'hex'),Buffer.from(current.credentialSha256,'hex'))||
        !timingSafeEqual(Buffer.from(peerHash,'hex'),Buffer.from(current.certificateSha256,'hex')))
        return undefined;
      const valid=()=>{const now=Date.now();return Number.isSafeInteger(now)&&
        now>=current.notBeforeMs&&now<current.expiresAtMs};
      if(!valid()||await verifyLiveBinding(current)!==true||!valid())return undefined;
      const {brokerId,ownerId,deviceId,deviceEpoch,sessionEpoch}=current;
      return Object.freeze({brokerId,ownerId,deviceId,deviceEpoch,sessionEpoch});
    }catch{return undefined}
  };
}

export interface ProtectedBrokerDispatchServiceOptions {
  readonly host:string;readonly port:number;readonly authorityId:string;
  readonly privateKeyPem:string;
  readonly database:Parameters<typeof createProtectedPostgresDispatchPool>[0];
  readonly tls:Omit<CoreNativeVerifierServerOptions,'handler'>;
  readonly credentials:ProtectedDispatchCredentialStore;
  readonly verifyProvenance:AuthorityOptions['verifyProvenance'];
  readonly readProtectedBroker:AuthorityOptions['readProtectedBroker'];
  readonly verifyOwnerRevocation:AuthorityOptions['verifyOwnerRevocation'];
  readonly verifyNativeDrain:AuthorityOptions['verifyNativeDrain'];
  /** Required for any production reservation/commit; absent policy denies. */
  readonly nativeCompletion?:AuthorityOptions['nativeCompletion'];
  readonly permitMs?:number;readonly drainTimeoutMs?:number;
}

/** Explicit off-host composition. Uses only the shared bounded TLS listener
 * primitive; dispatch routes, signer and receipts remain distinct from the
 * native enrollment verifier. No default listener, grant, schema migration,
 * automatic retry, native provider or CORE enablement is installed. */
export async function startProtectedBrokerDispatchService(config:ProtectedBrokerDispatchServiceOptions):
  Promise<Readonly<{address:string;port:number;physicalAcceptance:'NOT_PROVEN';close:()=>Promise<void>}>>{
  const {host,port,authorityId,privateKeyPem,database,tls,credentials,verifyProvenance,
    readProtectedBroker,verifyOwnerRevocation,verifyNativeDrain,nativeCompletion,permitMs,drainTimeoutMs}=config;
  if(typeof host!=='string'||isIP(host)===0||!Number.isInteger(port)||port<0||port>65535||
    !uuid.safeParse(authorityId).success||typeof verifyProvenance!=='function'||
    typeof readProtectedBroker!=='function'||typeof verifyOwnerRevocation!=='function'||
    typeof verifyNativeDrain!=='function')throw Error('DISPATCH_SERVICE_CONFIGURATION_REQUIRED');
  const authenticateBroker=createScopedDispatchBrokerResolver(credentials);
  const publicKey=createPublicKey(privateKeyPem);
  if(publicKey.asymmetricKeyType!=='ed25519')throw Error('DISPATCH_SERVICE_SIGNER_INVALID');
  const publicKeyPem=publicKey.export({type:'spki',format:'pem'}).toString();
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
      }finally{await db.close()}
    })();
    return closing;
  };
  try{
    const authority=new PostgresBrokerDispatchAuthority({pool:db.pool,authorityId,
      privateKeyPem,verifyProvenance,readProtectedBroker,verifyOwnerRevocation,
      verifyNativeDrain,permitMs,drainTimeoutMs,requireCredentialFence:true,
      requireNativeCompletion:true,nativeCompletion});
    const handler=createBrokerDispatchAuthorityHandler({authorityId,publicKeyPem,
      authority,authenticateBroker,requireMutualTls:true,
      readProtectedBroker:(_principal,operation)=>readProtectedBroker(operation),
      verifyOwnerRevocation});
    const listener=createCoreNativeVerifierServer({...tls,handler});
    server=listener;
    await new Promise<void>((resolve,reject)=>{
      const failed=()=>reject(Error('DISPATCH_SERVICE_LISTEN_FAILED'));
      listener.once('error',failed);
      listener.listen({host,port,exclusive:true},()=>{
        listener.off('error',failed);resolve();
      });
    });
    listener.on('error',()=>{void close().catch(()=>{})});
    const addr=listener.address();
    if(!addr||typeof addr==='string')throw Error('DISPATCH_SERVICE_LISTEN_FAILED');
    return Object.freeze({address:addr.address,port:addr.port,
      physicalAcceptance:'NOT_PROVEN' as const,close});
  }catch{
    await close().catch(()=>{});
    throw Error('DISPATCH_SERVICE_START_FAILED');
  }
}
