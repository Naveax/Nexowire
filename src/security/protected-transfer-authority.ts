import {createHash,createPublicKey,createPrivateKey,randomBytes,sign,verify,X509Certificate,constants,type KeyObject} from 'node:crypto';
import {request,createServer,type ServerOptions} from 'node:https';
import type {ClientRequest,IncomingMessage} from 'node:http';
import {checkServerIdentity,type TLSSocket} from 'node:tls';
import path from 'node:path';
import {verifyNativeTransferReceipt,type NativeTransferAdmission} from '../agent/native-transfer-publisher.js';
import type {LargeTransferScope,LargeTransferBinding,LargeTransferLease,LargeTransferIntent,LargeTransferFinalReceipt,LargeTransferCommit,LargeTransferAuthority} from '../mcp/durable-large-transfer.js';

const MAX=32768,DOMAIN='nexowire.large-transfer-authority.v1',ROUTE='/v1/large-transfer-authority';
const hex=/^[a-f0-9]{64}$/,uuid=/^[a-f0-9]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const actions=['grant','acquire','current','no-effect','verify-final','commit','recover-commit','recover-native','commit-recovered','claim-native','settle-native','cancel'] as const;
type Action=typeof actions[number];
type Role='hub'|'native';
const nativeActions=new Set<Action>(['claim-native','settle-native']);
const fail=(code:string):never=>{throw Error(code);};
const digest=(v:Buffer|string)=>createHash('sha256').update(v).digest('hex');
const safe=(n:unknown):n is number=>typeof n==='number'&&Number.isSafeInteger(n)&&n>=0;
const str=(s:unknown,max:number,min=1):s is string=>typeof s==='string'&&s.length>=min&&s.length<=max&&!s.includes('\0');
const keys=['ownerId','projectId','sourceDeviceId','targetDeviceId'] as const;
const eqScope=(a:LargeTransferScope,b:LargeTransferScope)=>keys.every(k=>a[k]===b[k]);
function obj(raw:unknown,expected:readonly string[]):Record<string,unknown>{
  if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).length!==expected.length||expected.some(k=>!Object.hasOwn(raw,k)))return fail('TRANSFER_AUTHORITY_SCHEMA_INVALID');
  return raw as Record<string,unknown>;
}
function scope(raw:unknown):LargeTransferScope{
  const x=obj(raw,keys);if(!keys.every(k=>str(x[k],256))||x.sourceDeviceId===x.targetDeviceId)return fail('TRANSFER_AUTHORITY_SCOPE_INVALID');
  return Object.freeze({ownerId:x.ownerId as string,projectId:x.projectId as string,sourceDeviceId:x.sourceDeviceId as string,targetDeviceId:x.targetDeviceId as string});
}
function bind(raw:unknown):LargeTransferBinding{
  const x=obj(raw,[...keys,'id','sourcePath','targetPath','stagePath','size','sha256']),s=scope(Object.fromEntries(keys.map(k=>[k,x[k]])));
  if(!str(x.id,36)||!uuid.test(x.id)||!str(x.sourcePath,4096)||!str(x.targetPath,4000)||!str(x.stagePath,4096)||x.stagePath!==x.targetPath+'.nexowire-upload-'+x.id+'.part'||!safe(x.size)||!str(x.sha256,64)||!hex.test(x.sha256)||x.size===0&&x.sha256!==digest(Buffer.alloc(0)))return fail('TRANSFER_AUTHORITY_BINDING_INVALID');
  return Object.freeze({...s,id:x.id,sourcePath:x.sourcePath,targetPath:x.targetPath,stagePath:x.stagePath,size:x.size,sha256:x.sha256});
}
function lease(raw:unknown):LargeTransferLease{
  const x=obj(raw,['epoch','token']);
  if(!safe(x.epoch)||x.epoch<1||!str(x.token,256,32)||!/^[A-Za-z0-9_-]+$/.test(x.token))return fail('TRANSFER_AUTHORITY_LEASE_INVALID');
  return Object.freeze({epoch:x.epoch,token:x.token});
}
function intent(raw:unknown,b:LargeTransferBinding):LargeTransferIntent{
  const x=obj(raw,['kind','requestId','epoch','offset','length','sha256','dispatched']);
  if((x.kind!=='write'&&x.kind!=='publish')||!str(x.requestId,36)||!uuid.test(x.requestId)||!safe(x.epoch)||x.epoch<1||!safe(x.offset)||x.offset>b.size||!safe(x.length)||x.length>65536||x.length>b.size-x.offset||!str(x.sha256,64)||!hex.test(x.sha256)||typeof x.dispatched!=='boolean'||(x.kind==='publish'&&(x.offset!==b.size||x.length!==0||x.sha256!==b.sha256))||(x.kind==='write'&&x.length===0&&(b.size!==0||x.offset!==0||x.sha256!==b.sha256)))return fail('TRANSFER_AUTHORITY_INTENT_INVALID');
  return Object.freeze({kind:x.kind,requestId:x.requestId,epoch:x.epoch,offset:x.offset,length:x.length,sha256:x.sha256,dispatched:x.dispatched});
}
function receipt(raw:unknown,b:LargeTransferBinding,p?:LargeTransferIntent):LargeTransferFinalReceipt{
  const x=obj(raw,['jobId','requestId','epoch','targetDeviceId','targetPath','size','sha256','proof']);
  if(x.jobId!==b.id||!str(x.requestId,36)||!uuid.test(x.requestId)||!safe(x.epoch)||x.epoch<1||x.targetDeviceId!==b.targetDeviceId||x.targetPath!==b.targetPath||x.size!==b.size||x.sha256!==b.sha256||!str(x.proof,86,86)||!/^[A-Za-z0-9_-]{86}$/.test(x.proof)||p&&(p.kind!=='publish'||!p.dispatched||x.requestId!==p.requestId||x.epoch!==p.epoch))return fail('TRANSFER_AUTHORITY_RECEIPT_INVALID');
  return Object.freeze({jobId:b.id,requestId:x.requestId,epoch:x.epoch,targetDeviceId:b.targetDeviceId,targetPath:b.targetPath,size:b.size,sha256:b.sha256,proof:x.proof});
}
function commit(raw:unknown,b:LargeTransferBinding,r:LargeTransferFinalReceipt):LargeTransferCommit{
  const x=obj(raw,['jobId','requestId','epoch','sha256','commitId']);
  if(x.jobId!==b.id||x.requestId!==r.requestId||x.epoch!==r.epoch||x.sha256!==b.sha256||!str(x.commitId,256,32))return fail('TRANSFER_AUTHORITY_COMMIT_INVALID');
  return Object.freeze({jobId:b.id,requestId:r.requestId,epoch:r.epoch,sha256:b.sha256,commitId:x.commitId});
}
export interface TransferNativeClaim {claimId:string;jobId:string;requestId:string;epoch:number;intentSha256:string}
export function transferNativeClaimDigest(raw:LargeTransferBinding,l:LargeTransferLease,p:LargeTransferIntent):string{
  const b=bind(raw);return digest(JSON.stringify([DOMAIN,'claim',b,lease(l),intent(p,b)]));
}
function claim(raw:unknown,b:LargeTransferBinding,l:LargeTransferLease,p:LargeTransferIntent):TransferNativeClaim{
  const x=obj(raw,['claimId','jobId','requestId','epoch','intentSha256']);
  if(!str(x.claimId,36)||!uuid.test(x.claimId)||x.jobId!==b.id||x.requestId!==p.requestId||x.epoch!==l.epoch||x.intentSha256!==transferNativeClaimDigest(b,l,p))return fail('TRANSFER_AUTHORITY_NATIVE_CLAIM_INVALID');
  return Object.freeze({claimId:x.claimId,jobId:b.id,requestId:p.requestId,epoch:l.epoch,intentSha256:x.intentSha256 as string});
}
function ack(raw:unknown){if(obj(raw,['accepted']).accepted!==true)fail('TRANSFER_AUTHORITY_DENIED');}
function keyPublic(pem:string){const k=createPublicKey(pem);if(k.asymmetricKeyType!=='ed25519')return fail('TRANSFER_AUTHORITY_KEY_INVALID');return k;}
function keyPrivate(pem:string){const k=createPrivateKey(pem);if(k.asymmetricKeyType!=='ed25519')return fail('TRANSFER_AUTHORITY_KEY_INVALID');return k;}
function encode(x:unknown){const b=Buffer.from(JSON.stringify(x),'utf8');if(b.length>MAX)fail('TRANSFER_AUTHORITY_MESSAGE_TOO_LARGE');return b;}
function json(b:Buffer):unknown{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(b));}
function proofBytes(value:unknown):Buffer{if(!str(value,86,86)||!/^[A-Za-z0-9_-]+$/.test(value))return fail('TRANSFER_AUTHORITY_SIGNATURE_INVALID');const b=Buffer.from(value,'base64url');if(b.length!==64||b.toString('base64url')!==value)return fail('TRANSFER_AUTHORITY_SIGNATURE_INVALID');return b;}
type Wire={domain:typeof DOMAIN;authorityId:string;role:Role;scope:LargeTransferScope;action:Action;nonce:string;args:Record<string,unknown>};
function parseWire(raw:unknown):Wire{
  const x=obj(raw,['domain','authorityId','role','scope','action','nonce','args']);
  if(x.domain!==DOMAIN||!str(x.authorityId,128)||!str(x.nonce,64)||!hex.test(x.nonce)||(x.role!=='hub'&&x.role!=='native')||!actions.includes(x.action as Action)||nativeActions.has(x.action as Action)!==(x.role==='native')||!x.args||typeof x.args!=='object'||Array.isArray(x.args))return fail('TRANSFER_AUTHORITY_WIRE_INVALID');
  return Object.freeze({domain:DOMAIN,authorityId:x.authorityId,role:x.role,scope:scope(x.scope),action:x.action as Action,nonce:x.nonce,args:x.args as Record<string,unknown>});
}
export interface ProtectedTransferAuthorityTlsConfig {
  endpoint:string;authorityId:string;role:Role;scope:LargeTransferScope;
  certificatePem:string;keyPem:string;serverCaPem:string;serverSpkiSha256:string;
  authorityPublicKeyPem:string;enrolledTargetPublicKeyPem:string;
  /** Read independently provisioned credential, never from tool inputs. */
  credential:()=>Promise<string|undefined>;timeoutMs?:number;
}
/** Actual bounded pinned mTLS + challenge-bound signed replies. No default
 * fetch, redirect, retry, caller-supplied transport or local authority fallback. */
export class ProtectedTransferAuthorityClient implements LargeTransferAuthority {
  private readonly c:Readonly<ProtectedTransferAuthorityTlsConfig>;
  private readonly url:URL;private readonly targetKey:KeyObject;private readonly authorityKey:KeyObject;private readonly timeout:number;
  constructor(config:ProtectedTransferAuthorityTlsConfig){
    this.url=new URL(config.endpoint);this.timeout=config.timeoutMs??5000;
    if(this.url.protocol!=='https:'||this.url.username||this.url.password||this.url.search||this.url.hash||this.url.pathname!==ROUTE||
      !str(config.authorityId,128)||(config.role!=='hub'&&config.role!=='native')||!hex.test(config.serverSpkiSha256)||!config.certificatePem.includes('BEGIN CERTIFICATE')||!config.keyPem.includes('PRIVATE KEY-----')||!config.serverCaPem.includes('BEGIN CERTIFICATE')||typeof config.credential!=='function'||!Number.isSafeInteger(this.timeout)||this.timeout<250||this.timeout>30000)fail('TRANSFER_AUTHORITY_CONFIGURATION_INVALID');
    this.c=Object.freeze({...config,scope:scope(config.scope)});
    this.targetKey=keyPublic(config.enrolledTargetPublicKeyPem);this.authorityKey=keyPublic(config.authorityPublicKeyPem);
  }
  private scoped(b:LargeTransferBinding){const v=bind(b);if(!eqScope(v,this.c.scope))return fail('TRANSFER_AUTHORITY_SCOPE_DENIED');return v;}
  private verified(b:LargeTransferBinding,r:unknown,p?:LargeTransferIntent){const v=receipt(r,b,p);if(!verifyNativeTransferReceipt(b,v,this.targetKey))return fail('TRANSFER_AUTHORITY_NATIVE_SIGNATURE_INVALID');return v;}
  private async call(action:Action,args:Record<string,unknown>):Promise<unknown>{
    if(nativeActions.has(action)!==(this.c.role==='native'))return fail('TRANSFER_AUTHORITY_ROLE_DENIED');
    const nonce=randomBytes(32).toString('hex'),wire:Wire={domain:DOMAIN,authorityId:this.c.authorityId,role:this.c.role,scope:this.c.scope,action,nonce,args};
    const body=encode(wire),bodySha256=digest(body),started=process.hrtime.bigint();
    let req:ClientRequest|undefined,timer:NodeJS.Timeout|undefined,expired=false;
    const deadline=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{expired=true;req?.destroy();reject(Error('TRANSFER_AUTHORITY_TRANSPORT_UNKNOWN'));},this.timeout);});
    try{
      const token=await Promise.race([Promise.resolve().then(()=>this.c.credential()),deadline]);
      if(expired||!str(token,2048,32)||!/^[A-Za-z0-9_-]+$/.test(token))return fail('TRANSFER_AUTHORITY_CREDENTIAL_DENIED');
      const response=await Promise.race([new Promise<Buffer>((resolve,reject)=>{
        const abort=()=>{req?.destroy();reject(Error('TRANSFER_AUTHORITY_TRANSPORT_UNKNOWN'));};
        req=request(this.url,{method:'POST',agent:false,key:this.c.keyPem,cert:this.c.certificatePem,ca:this.c.serverCaPem,rejectUnauthorized:true,minVersion:'TLSv1.3',maxVersion:'TLSv1.3',
          secureOptions:constants.SSL_OP_NO_TICKET|constants.SSL_OP_NO_RENEGOTIATION,maxHeaderSize:8192,
          headers:{authorization:'Bearer '+token,'content-type':'application/json','content-length':body.length,connection:'close'},
          checkServerIdentity:(host,cert)=>{const e=checkServerIdentity(host,cert);if(e)return e;try{if(digest(new X509Certificate(cert.raw).publicKey.export({type:'spki',format:'der'}))===this.c.serverSpkiSha256)return;}catch{}return Error('TRANSFER_AUTHORITY_TLS_PIN_MISMATCH');},
        },res=>{
          const type=res.headersDistinct['content-type'],encoding=res.headersDistinct['content-encoding'];
          if(res.statusCode!==200||type?.length!==1||type[0]!=='application/json'||encoding!==undefined&&(encoding.length!==1||encoding[0]!=='identity')){res.destroy();abort();return;}
          const chunks:Buffer[]=[];let size=0;
          res.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>MAX){res.destroy();abort();return;}chunks.push(Buffer.from(chunk));});
          res.once('error',abort);res.once('aborted',abort);res.once('end',()=>{if(!res.complete){abort();return;}resolve(Buffer.concat(chunks));});
        });
        req.once('error',abort);req.end(body);
      }),deadline]);
      if(expired||process.hrtime.bigint()-started>=BigInt(this.timeout)*1000000n)return fail('TRANSFER_AUTHORITY_TRANSPORT_UNKNOWN');
      const envelope=obj(json(response),['payload','proof']);
      if(!str(envelope.payload,MAX)||!verify(null,Buffer.from(envelope.payload,'utf8'),this.authorityKey,proofBytes(envelope.proof)))return fail('TRANSFER_AUTHORITY_SIGNATURE_INVALID');
      const p=obj(JSON.parse(envelope.payload),['domain','authorityId','nonce','action','requestSha256','result']);
      if(p.domain!==DOMAIN||p.authorityId!==this.c.authorityId||p.nonce!==nonce||p.action!==action||p.requestSha256!==bodySha256)return fail('TRANSFER_AUTHORITY_RESPONSE_SCOPE_INVALID');
      return p.result;
    }finally{clearTimeout(timer);req?.destroy();}
  }
  async assertGrant(s:LargeTransferScope){if(!eqScope(scope(Object.fromEntries(keys.map(k=>[k,s[k]]))),this.c.scope))return fail('TRANSFER_AUTHORITY_SCOPE_DENIED');ack(await this.call('grant',{}));}
  async acquire(raw:LargeTransferBinding,previousEpoch:number){const b=this.scoped(raw);if(!safe(previousEpoch))return fail('TRANSFER_AUTHORITY_LEASE_INVALID');const l=lease(await this.call('acquire',{binding:b,previousEpoch}));if(l.epoch<=previousEpoch)return fail('TRANSFER_AUTHORITY_LEASE_INVALID');return l;}
  async assertCurrent(raw:LargeTransferBinding,l:LargeTransferLease,offset:number){const b=this.scoped(raw);if(!safe(offset)||offset>b.size)return fail('TRANSFER_AUTHORITY_OFFSET_INVALID');ack(await this.call('current',{binding:b,lease:lease(l),offset}));}
  async proveWriteNoEffect(raw:LargeTransferBinding,p:LargeTransferIntent,l:LargeTransferLease){const b=this.scoped(raw),i=intent(p,b),next=lease(l);if(i.kind!=='write'||next.epoch<=i.epoch)return fail('TRANSFER_AUTHORITY_INTENT_INVALID');return obj(await this.call('no-effect',{binding:b,intent:i,lease:next}),['proved']).proved===true;}
  async verifyFinal(raw:LargeTransferBinding,r:LargeTransferFinalReceipt){const b=this.scoped(raw);let v:LargeTransferFinalReceipt;try{v=this.verified(b,r);}catch{return false;}return obj(await this.call('verify-final',{binding:b,receipt:v}),['verified']).verified===true;}
  async commitPublished(raw:LargeTransferBinding,l:LargeTransferLease,r:LargeTransferFinalReceipt){const b=this.scoped(raw),current=lease(l),v=this.verified(b,r);if(v.epoch!==current.epoch)return fail('TRANSFER_AUTHORITY_LEASE_INVALID');return commit(await this.call('commit',{binding:b,lease:current,receipt:v}),b,v);}
  async recoverPublished(raw:LargeTransferBinding,p:LargeTransferIntent){const b=this.scoped(raw),i=intent(p,b),v=await this.call('recover-commit',{binding:b,intent:i});if(v===null)return undefined;const x=obj(v,['receipt','commit']),r=this.verified(b,x.receipt,i);return {receipt:r,commit:commit(x.commit,b,r)};}
  async recoverNativeReceipt(raw:LargeTransferBinding,p:LargeTransferIntent){const b=this.scoped(raw),i=intent(p,b),v=await this.call('recover-native',{binding:b,intent:i});return v===null?undefined:this.verified(b,v,i);}
  async commitRecoveredPublication(raw:LargeTransferBinding,p:LargeTransferIntent,r:LargeTransferFinalReceipt){const b=this.scoped(raw),i=intent(p,b),v=this.verified(b,r,i);return commit(await this.call('commit-recovered',{binding:b,intent:i,receipt:v}),b,v);}
  async cancelTransfer(raw:LargeTransferBinding,l:LargeTransferLease){const b=this.scoped(raw);ack(await this.call('cancel',{binding:b,lease:lease(l)}));}
  async claimNativeEffect(raw:LargeTransferBinding,l:LargeTransferLease,p:LargeTransferIntent){const b=this.scoped(raw),current=lease(l),i=intent(p,b);if(!i.dispatched||i.epoch!==current.epoch)return fail('TRANSFER_AUTHORITY_INTENT_INVALID');return claim(await this.call('claim-native',{binding:b,lease:current,intent:i}),b,current,i);}
  async settleNativeEffect(raw:LargeTransferBinding,l:LargeTransferLease,p:LargeTransferIntent,c:TransferNativeClaim,outcome:'completed'|'unknown'){
    const b=this.scoped(raw),current=lease(l),i=intent(p,b);if(!i.dispatched||i.epoch!==current.epoch||(outcome!=='completed'&&outcome!=='unknown'))return fail('TRANSFER_AUTHORITY_INTENT_INVALID');
    ack(await this.call('settle-native',{binding:b,lease:current,intent:i,claim:claim(c,b,current,i),outcome}));
  }
}
/** Protected Hub bootstrap composition; caller must independently verify the
 * journal root and provision the fixed owner/project/device pair. */
export function createProtectedHubTransferRuntime(config:ProtectedTransferAuthorityTlsConfig&{journalPath:string}){
  if(config.role!=='hub'||!path.isAbsolute(config.journalPath))return fail('TRANSFER_AUTHORITY_HUB_CONFIGURATION_INVALID');
  return Object.freeze({journalPath:config.journalPath,projectId:scope(config.scope).projectId,authority:new ProtectedTransferAuthorityClient(config)});
}
/** Additional lease/offset gate inside the existing protected native effect
 * admission. The off-host claim must block new epochs/revocation completion
 * until this original claim is settled and independently drained.
 * The protected OS callback is mandatory; a signed RPC ACK alone is NOT
 * authority to execute a Windows effect. */
export function createProtectedNativeTransferAdmission(client:ProtectedTransferAuthorityClient,
  withProtectedEffect:(binding:Readonly<LargeTransferBinding>,lease:Readonly<LargeTransferLease>,intent:Readonly<LargeTransferIntent>,claim:Readonly<TransferNativeClaim>,effect:()=>Promise<void>)=>Promise<void>):Pick<NativeTransferAdmission,'admit'>{
  if(typeof withProtectedEffect!=='function')return fail('TRANSFER_AUTHORITY_NATIVE_GUARD_REQUIRED');
  return {async admit(raw,l,p,effect){
    const b=bind(raw),current=lease(l),i=intent(p,b),c=await client.claimNativeEffect(b,current,i);
    let active=true,called=false,done=false;
    try{
      await withProtectedEffect(b,current,i,c,async()=>{if(!active||called)fail('TRANSFER_AUTHORITY_NATIVE_CALLBACK_INVALID');called=true;await effect();done=true;});
      if(!called||!done)fail('TRANSFER_AUTHORITY_NATIVE_EFFECT_UNCONFIRMED');
    }catch(e){
      active=false;
      // Never retry, never turn UNKNOWN into no-effect proof or a fresh claim.
      await client.settleNativeEffect(b,current,i,c,'unknown').catch(()=>undefined);
      throw e;
    }finally{active=false;}
    await client.settleNativeEffect(b,current,i,c,'completed');
  }};
}
export interface ProtectedTransferAuthorityBackend extends LargeTransferAuthority {
  cancelTransfer(b:LargeTransferBinding,l:LargeTransferLease):Promise<void>;
  /** Atomically reserve the immutable request UUID and pin the current lease,
   * exact offset, source/destination grant and protected namespace. Durable
   * active claims participate in the same revoke/drain boundary. */
  claimNativeEffect(b:LargeTransferBinding,l:LargeTransferLease,i:LargeTransferIntent):Promise<TransferNativeClaim>;
  /** Exact original claim only. Never erase tombstones or treat unknown as
   * no effect. Revoked grants may settle but cannot authorize new work. */
  settleNativeEffect(b:LargeTransferBinding,l:LargeTransferLease,i:LargeTransferIntent,c:TransferNativeClaim,outcome:'completed'|'unknown'):Promise<void>;
}
export interface ProtectedTransferPrincipal {role:Role;scope:LargeTransferScope}
export function createProtectedTransferAuthorityServer(config:{
  tls:Pick<ServerOptions,'key'|'cert'|'ca'>;authorityId:string;authorityPrivateKeyPem:string;
  resolvePrincipal:(certificateSha256:string,credential:string)=>Promise<ProtectedTransferPrincipal|undefined>;
  verifyIndependentProvenance:()=>Promise<boolean>;
  backend:ProtectedTransferAuthorityBackend;
}){
  if(!config.tls.key||!config.tls.cert||!config.tls.ca||!str(config.authorityId,128)||typeof config.resolvePrincipal!=='function'||typeof config.verifyIndependentProvenance!=='function'||!config.backend||!['assertGrant','acquire','assertCurrent','proveWriteNoEffect','verifyFinal','commitPublished','recoverPublished','recoverNativeReceipt','commitRecoveredPublication','claimNativeEffect','settleNativeEffect','cancelTransfer'].every(k=>typeof (config.backend as unknown as Record<string,unknown>)[k]==='function'))return fail('TRANSFER_AUTHORITY_SERVER_CONFIG_INVALID');
  const key=keyPrivate(config.authorityPrivateKeyPem),backend=config.backend;
  const dispatch=async(w:Wire)=>{
    const a=w.args;
    if(w.action==='grant'){obj(a,[]);await backend.assertGrant(w.scope);return {accepted:true};}
    const b=bind(a.binding);if(!eqScope(b,w.scope))return fail('TRANSFER_AUTHORITY_SCOPE_DENIED');
    // Settlement only of already admitted original claim remains possible
    // after revoke; the backend must NOT use it as a new grant.
    if(w.action!=='settle-native')await backend.assertGrant(w.scope);
    switch(w.action){
      case 'acquire':{obj(a,['binding','previousEpoch']);if(!safe(a.previousEpoch))return fail('TRANSFER_AUTHORITY_LEASE_INVALID');const l=lease(await backend.acquire(b,a.previousEpoch));if(l.epoch<=a.previousEpoch)return fail('TRANSFER_AUTHORITY_LEASE_INVALID');return l;}
      case 'current':{obj(a,['binding','lease','offset']);if(!safe(a.offset)||a.offset>b.size)return fail('TRANSFER_AUTHORITY_OFFSET_INVALID');await backend.assertCurrent(b,lease(a.lease),a.offset);return {accepted:true};}
      case 'no-effect':{obj(a,['binding','lease','intent']);const i=intent(a.intent,b),l=lease(a.lease);if(i.kind!=='write'||l.epoch<=i.epoch)return fail('TRANSFER_AUTHORITY_INTENT_INVALID');return {proved:await backend.proveWriteNoEffect(b,i,l)===true};}
      case 'verify-final':{obj(a,['binding','receipt']);return {verified:await backend.verifyFinal(b,receipt(a.receipt,b))===true};}
      case 'commit':{obj(a,['binding','lease','receipt']);const l=lease(a.lease),r=receipt(a.receipt,b);if(l.epoch!==r.epoch||await backend.verifyFinal(b,r)!==true)return fail('TRANSFER_AUTHORITY_RECEIPT_INVALID');return commit(await backend.commitPublished(b,l,r),b,r);}
      case 'recover-commit':{obj(a,['binding','intent']);const i=intent(a.intent,b);if(i.kind!=='publish'||!i.dispatched)return fail('TRANSFER_AUTHORITY_INTENT_INVALID');const value=await backend.recoverPublished(b,i);if(!value)return null;const r=receipt(value.receipt,b,i);if(await backend.verifyFinal(b,r)!==true)return fail('TRANSFER_AUTHORITY_RECEIPT_INVALID');return {receipt:r,commit:commit(value.commit,b,r)};}
      case 'recover-native':{obj(a,['binding','intent']);const i=intent(a.intent,b);if(i.kind!=='publish'||!i.dispatched)return fail('TRANSFER_AUTHORITY_INTENT_INVALID');const v=await backend.recoverNativeReceipt!(b,i);if(!v)return null;const r=receipt(v,b,i);if(await backend.verifyFinal(b,r)!==true)return fail('TRANSFER_AUTHORITY_RECEIPT_INVALID');return r;}
      case 'commit-recovered':{obj(a,['binding','intent','receipt']);const i=intent(a.intent,b),r=receipt(a.receipt,b,i);if(await backend.verifyFinal(b,r)!==true)return fail('TRANSFER_AUTHORITY_RECEIPT_INVALID');return commit(await backend.commitRecoveredPublication!(b,i,r),b,r);}
      case 'cancel':{obj(a,['binding','lease']);await backend.cancelTransfer(b,lease(a.lease));return {accepted:true};}
      case 'claim-native':{obj(a,['binding','lease','intent']);const l=lease(a.lease),i=intent(a.intent,b);if(!i.dispatched||i.epoch!==l.epoch)return fail('TRANSFER_AUTHORITY_INTENT_INVALID');return claim(await backend.claimNativeEffect(b,l,i),b,l,i);}
      case 'settle-native':{obj(a,['binding','lease','intent','claim','outcome']);const l=lease(a.lease),i=intent(a.intent,b);if(!i.dispatched||i.epoch!==l.epoch||a.outcome!=='completed'&&a.outcome!=='unknown')return fail('TRANSFER_AUTHORITY_INTENT_INVALID');await backend.settleNativeEffect(b,l,i,claim(a.claim,b,l,i),a.outcome);return {accepted:true};}
      default:return fail('TRANSFER_AUTHORITY_ACTION_INVALID');
    }
  };
  const read=async(req:IncomingMessage)=>{
    const n=req.headersDistinct['content-length'];
    if(n?.length!==1||!/^\d{1,6}$/.test(n[0]??'')||Number(n[0])>MAX||Number(n[0])<1||req.headersDistinct['transfer-encoding']||req.headersDistinct['content-encoding']||req.headersDistinct['content-type']?.length!==1||req.headersDistinct['content-type']?.[0]!=='application/json')return fail('TRANSFER_AUTHORITY_REQUEST_INVALID');
    const chunks:Buffer[]=[];let size=0;
    const timer=setTimeout(()=>req.destroy(),10000);
    try{for await(const raw of req){const chunk=Buffer.from(raw);size+=chunk.length;if(size>MAX)return fail('TRANSFER_AUTHORITY_REQUEST_INVALID');chunks.push(chunk);}if(!req.complete||size!==Number(n[0]))return fail('TRANSFER_AUTHORITY_REQUEST_INVALID');return Buffer.concat(chunks);}
    finally{clearTimeout(timer);}
  };
  return createServer({...config.tls,requestCert:true,rejectUnauthorized:true,minVersion:'TLSv1.3',maxVersion:'TLSv1.3',secureOptions:constants.SSL_OP_NO_TICKET|constants.SSL_OP_NO_RENEGOTIATION,maxHeaderSize:8192,requestTimeout:10000,headersTimeout:5000,keepAliveTimeout:1000},(req,res)=>{
    void(async()=>{
      const socket=req.socket as TLSSocket,cert=socket.getPeerCertificate();
      const authorization=req.headersDistinct.authorization;
      if(req.method!=='POST'||req.url!==ROUTE||!socket.authorized||!cert.raw||authorization?.length!==1||!/^Bearer [A-Za-z0-9_-]{32,2048}$/.test(authorization[0]??''))return fail('TRANSFER_AUTHORITY_PEER_DENIED');
      const raw=await read(req),wire=parseWire(json(raw));
      const principal=await config.resolvePrincipal(digest(cert.raw),authorization[0]!.slice(7));
      if(!principal||principal.role!==wire.role||!eqScope(scope(principal.scope),wire.scope)||wire.authorityId!==config.authorityId||await config.verifyIndependentProvenance()!==true)return fail('TRANSFER_AUTHORITY_PEER_DENIED');
      const result=await dispatch(wire);
      const payload=JSON.stringify({domain:DOMAIN,authorityId:config.authorityId,nonce:wire.nonce,action:wire.action,requestSha256:digest(raw),result});
      const body=encode({payload,proof:sign(null,Buffer.from(payload,'utf8'),key).toString('base64url')});
      res.writeHead(200,{'content-type':'application/json','content-length':body.length,'cache-control':'no-store','connection':'close'});res.end(body);
    })().catch(()=>{if(res.headersSent){res.destroy();return;}res.writeHead(403,{'content-type':'application/json','cache-control':'no-store','connection':'close'});res.end('{"error":"TRANSFER_AUTHORITY_DENIED"}');});
  });
}
