import {createHash,createPublicKey,timingSafeEqual} from 'node:crypto';
import {isIP} from 'node:net';
import {createProtectedNativeDrainVerifier,type ProtectedNativeDrainReadback} from './protected-native-completion-reader.js';
import type {DispatchClaim,DispatchRevokeRequest} from './broker-external-dispatch-fence.js';
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

/** Actual authority work is tracked until its promise settles, not until a
 * socket closes. A shutdown timeout is UNKNOWN; the gate never reopens. */
export class ProtectedDispatchWorkGate {
  private accepting=true;
  private readonly pending=new Set<Promise<unknown>>();
  constructor(private readonly capacity=16){
    if(!Number.isSafeInteger(capacity)||capacity<1||capacity>64)
      throw Error('DISPATCH_SERVICE_WORK_LIMIT_INVALID');
  }
  run<T>(work:()=>Promise<T>):Promise<T>{
    if(!this.accepting||this.pending.size>=this.capacity)
      return Promise.reject(Error('DISPATCH_SERVICE_ADMISSION_CLOSED'));
    const task=Promise.resolve().then(work);
    this.pending.add(task);
    void task.then(()=>{this.pending.delete(task)},()=>{this.pending.delete(task)});
    return task;
  }
  fence(){this.accepting=false;}
  async drain(timeoutMs:number):Promise<void>{
    this.fence();
    if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>30000)
      throw Error('DISPATCH_SERVICE_DRAIN_DEADLINE_INVALID');
    let timer:ReturnType<typeof setTimeout>|undefined;
    try{
      await Promise.race([
        Promise.allSettled([...this.pending]).then(()=>undefined),
        new Promise<never>((_,reject)=>{
          timer=setTimeout(()=>reject(Error('DISPATCH_SERVICE_SHUTDOWN_UNKNOWN')),timeoutMs);
        }),
      ]);
    }finally{clearTimeout(timer)}
    if(this.pending.size)throw Error('DISPATCH_SERVICE_SHUTDOWN_UNKNOWN');
  }
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
  /** Supplemental composition check (including transfer-runtime drain). */
  readonly verifyNativeDrain:AuthorityOptions['verifyNativeDrain'];
  /** Independent native observer, mandatory in protected startup. No fixture fallback. */
  readonly readNativeDrainProof?:ProtectedNativeDrainReadback;
  /** Required before a production listener opens; absent policy denies startup. */
  readonly nativeCompletion?:AuthorityOptions['nativeCompletion'];
  readonly permitMs?:number;readonly drainTimeoutMs?:number;
  readonly shutdownTimeoutMs?:number;
}

/** Explicit off-host composition. Uses only the shared bounded TLS listener
 * primitive; dispatch routes, signer and receipts remain distinct from the
 * native enrollment verifier. No default listener, grant, schema migration,
 * automatic retry, native provider or CORE enablement is installed. The
 * returned recovery function is for the protected composition root only;
 * it is deliberately NOT a public HTTP route. */
export async function startProtectedBrokerDispatchService(config:ProtectedBrokerDispatchServiceOptions):
  Promise<Readonly<{address:string;port:number;physicalAcceptance:'NOT_PROVEN';
    reconcileRevoking:(request:DispatchRevokeRequest,nonce:string)=>Promise<DispatchClaim>;
    close:()=>Promise<void>}>>{
  const {host,port,authorityId,privateKeyPem,database,tls,credentials,verifyProvenance,
    readProtectedBroker,verifyOwnerRevocation,verifyNativeDrain,nativeCompletion,permitMs,drainTimeoutMs}=config;
  const shutdownMs=config.shutdownTimeoutMs??15000;
  if(typeof host!=='string'||isIP(host)===0||!Number.isInteger(port)||port<0||port>65535||
    !uuid.safeParse(authorityId).success||typeof verifyProvenance!=='function'||
    typeof readProtectedBroker!=='function'||typeof verifyOwnerRevocation!=='function'||
    typeof verifyNativeDrain!=='function'||typeof config.readNativeDrainProof!=='function'||!nativeCompletion||
    !Number.isSafeInteger(shutdownMs)||shutdownMs<100||shutdownMs>30000)
    throw Error('DISPATCH_SERVICE_CONFIGURATION_REQUIRED');
  const capabilities=Object.freeze(Object.keys(nativeCompletion.evidenceByCapability));
  const verifySignedDrain=createProtectedNativeDrainVerifier({authorityId,
    observerPublicKeyPem:nativeCompletion.observerPublicKeyPem,readback:config.readNativeDrainProof});
  const work=new ProtectedDispatchWorkGate(tls.maxActiveRequests??16);
  const authenticateBroker=createScopedDispatchBrokerResolver(credentials);
  const publicKey=createPublicKey(privateKeyPem);
  if(publicKey.asymmetricKeyType!=='ed25519')throw Error('DISPATCH_SERVICE_SIGNER_INVALID');
  const publicKeyPem=publicKey.export({type:'spki',format:'pem'}).toString();
  const db=createProtectedPostgresDispatchPool(database);
  let server:ReturnType<typeof createCoreNativeVerifierServer>|undefined;
  let closing:Promise<void>|undefined,listenerClosed:Promise<void>|undefined;
  const close=():Promise<void>=>{
    if(closing)return closing;
    work.fence();
    if(!listenerClosed){
      const active=server;
      listenerClosed=active?.listening?new Promise<void>((resolve,reject)=>{
        active.close(error=>error?reject(error):resolve());
        active.closeAllConnections();
      }):Promise.resolve();
    }
    // Never destroy the DB pool while a detached HTTP or recovery operation
    // may still own a transaction. Timeout keeps admission closed and is not
    // a successful shutdown or native/lease drain. Explicit close may later
    // recheck settlement; it cannot retry an effect.
    const pendingClose=(async()=>{
      let timer:ReturnType<typeof setTimeout>|undefined;
      try{
        await Promise.race([
          Promise.all([listenerClosed,work.drain(shutdownMs)]),
          new Promise<never>((_,reject)=>{
            timer=setTimeout(()=>reject(Error('DISPATCH_SERVICE_SHUTDOWN_UNKNOWN')),shutdownMs);
          }),
        ]);
      }finally{clearTimeout(timer)}
      await db.close();
    })();
    closing=pendingClose;
    void pendingClose.catch(()=>{if(closing===pendingClose)closing=undefined});
    return pendingClose;
  };
  try{
    const authority=new PostgresBrokerDispatchAuthority({pool:db.pool,authorityId,
      privateKeyPem,verifyProvenance,readProtectedBroker,verifyOwnerRevocation,
      verifyNativeDrain:async(request,signal)=>{
        if(signal?.aborted||await verifyNativeDrain(request,signal)!==true||signal?.aborted)return false;
        return verifySignedDrain(request,signal);
      },permitMs,drainTimeoutMs,requireCredentialFence:true,
      requireNativeCompletion:true,nativeCompletion});
    await authority.assertNativeCompletionPolicy(capabilities);
    const handler=createBrokerDispatchAuthorityHandler({authorityId,publicKeyPem,
      authority,authenticateBroker,requireMutualTls:true,
      readProtectedBroker:(_principal,operation)=>readProtectedBroker(operation),
      verifyOwnerRevocation});
    const listener=createCoreNativeVerifierServer({...tls,handler:(req,res)=>{
      void work.run(()=>handler(req,res)).catch(()=>{
        if(res.destroyed||res.headersSent){res.destroy();return}
        res.writeHead(503,{'content-type':'application/json','cache-control':'no-store',connection:'close'});
        res.end('{"error":"unavailable"}');
      });
    }});
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
      physicalAcceptance:'NOT_PROVEN' as const,
      reconcileRevoking:(request:DispatchRevokeRequest,nonce:string)=>
        work.run(()=>authority.reconcileRevoking(request,nonce)),close});
  }catch{
    await close().catch(()=>{});
    throw Error('DISPATCH_SERVICE_START_FAILED');
  }
}
