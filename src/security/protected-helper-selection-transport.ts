import {createHash,createPrivateKey,createPublicKey,randomBytes,sign,verify,X509Certificate,constants,type KeyObject} from 'node:crypto';
import {createServer,request,type ServerOptions} from 'node:https';
import type {IncomingMessage,ClientRequest} from 'node:http';
import {checkServerIdentity,type TLSSocket} from 'node:tls';
import * as z from 'zod';
import type {HelperRequest,HelperCommit,HelperSelection} from '../installer/protected-transfer-helper-lifecycle.js';
import {PostgresHelperSelectionAuthority,type HelperAuthorityScope,type HelperLease,type HelperSelectionLeaseTransport} from './postgres-helper-selection-authority.js';

const DOMAIN='nexowire.helper-selection.v1',ROUTE='/v1/helper-selection',MAX=32768;
const uuid=z.string().uuid().transform(s=>s.toLowerCase());
const hex=z.string().length(64).regex(/^[a-f0-9]{64}$/);
const role=z.enum(['runtime','deployment']);
type Role=z.infer<typeof role>;
const scope=z.strictObject({authorityId:uuid,deviceId:uuid,ownerId:uuid,deviceEpoch:uuid,sessionEpoch:uuid,
  ownerEpoch:z.number().int().positive().safe(),generation:z.number().int().positive().safe(),brokerId:uuid});
const pin=z.strictObject({sha256:hex,signerSha256:hex});
const selection=z.strictObject({revision:uuid,pin:pin.nullable()});
const deployment=z.strictObject({requestId:uuid,operation:z.enum(['clean-install','upgrade','uninstall','rollback']),
  expected:selection,desired:pin.nullable(),sourcePath:z.string().min(1).max(4096).optional()});
const lease=z.strictObject({id:uuid,requestId:uuid,kind:z.enum(['RUNTIME','DEPLOYMENT']),expectedRevision:uuid});
const token=z.string().min(32).max(2048).regex(/^[A-Za-z0-9_-]+$/);
const action=z.enum(['begin-runtime','begin-deployment','read','commit','release']);
type Action=z.infer<typeof action>;
const base={domain:z.literal(DOMAIN),scope,role,nonce:hex};
const wire=z.discriminatedUnion('action',[
  z.strictObject({...base,action:z.literal('begin-runtime'),args:z.strictObject({requestId:uuid})}),
  z.strictObject({...base,action:z.literal('begin-deployment'),args:z.strictObject({request:deployment})}),
  z.strictObject({...base,action:z.literal('read'),args:z.strictObject({leaseId:uuid})}),
  z.strictObject({...base,action:z.literal('commit'),args:z.strictObject({leaseId:uuid,request:deployment})}),
  z.strictObject({...base,action:z.literal('release'),args:z.strictObject({leaseId:uuid})}),
]);
type Wire=z.infer<typeof wire>;
const ack=z.strictObject({accepted:z.literal(true)});
const envelope=z.strictObject({payload:z.string().min(1).max(MAX),proof:z.string().length(86).regex(/^[A-Za-z0-9_-]+$/)});
const payload=z.strictObject({domain:z.literal(DOMAIN),authorityId:uuid,nonce:hex,action,requestSha256:hex,result:z.unknown()});
const deny=(code:string):never=>{throw Error(code);};
const digest=(value:Buffer)=>createHash('sha256').update(value).digest('hex');
const sameScope=(a:HelperAuthorityScope,b:HelperAuthorityScope)=>JSON.stringify(a)===JSON.stringify(b);
const allowed=(r:Role,a:Action)=>a==='read'||a==='release'||(r==='runtime'?a==='begin-runtime':a==='begin-deployment'||a==='commit');
function key(k:KeyObject){if(k.asymmetricKeyType!=='ed25519')return deny('HELPER_SELECTION_SIGNING_KEY_INVALID');return k;}
function encode(value:unknown){const b=Buffer.from(JSON.stringify(value),'utf8');if(b.length>MAX)return deny('HELPER_SELECTION_MESSAGE_TOO_LARGE');return b;}
function decode(bytes:Buffer):unknown{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}
function proof(value:string){const b=Buffer.from(value,'base64url');if(b.length!==64||b.toString('base64url')!==value)return deny('HELPER_SELECTION_SIGNATURE_INVALID');return b;}
function exactHeaders(req:IncomingMessage){
  const h=req.headersDistinct,n=h['content-length'];
  if(n?.length!==1||!/^[1-9]\d{0,4}$/.test(n[0]??'')||Number(n[0])>MAX||
    h['transfer-encoding']||h['content-encoding']||h['content-type']?.length!==1||h['content-type']?.[0]!=='application/json')
    return deny('HELPER_SELECTION_HEADERS_INVALID');
  return Number(n[0]);
}
async function readRequest(req:IncomingMessage){
  const expected=exactHeaders(req);const chunks:Buffer[]=[];let size=0;
  const timer=setTimeout(()=>req.destroy(),10000);
  try{for await(const raw of req){const b=Buffer.from(raw);size+=b.length;if(size>expected)return deny('HELPER_SELECTION_MESSAGE_TOO_LARGE');chunks.push(b);}
    if(!req.complete||size!==expected)return deny('HELPER_SELECTION_REQUEST_INCOMPLETE');return Buffer.concat(chunks);
  }finally{clearTimeout(timer);}
}
export interface HelperSelectionTlsConfig {
  endpoint:string;scope:HelperAuthorityScope;role:Role;certificatePem:string;keyPem:string;
  serverCaPem:string;serverSpkiSha256:string;authorityPublicKeyPem:string;
  credential:()=>Promise<string|undefined>;timeoutMs?:number;
}
/** Real pinned TLS 1.3 transport. No redirects/retries, local DB, ambient
 * credentials or alternate transport. Any lost reply is UNKNOWN to caller. */
export class ProtectedHelperSelectionClient implements HelperSelectionLeaseTransport {
  private readonly c:Readonly<HelperSelectionTlsConfig>;
  private readonly url:URL;private readonly authorityKey:KeyObject;private readonly timeout:number;
  constructor(c:HelperSelectionTlsConfig){
    this.url=new URL(c.endpoint);this.timeout=c.timeoutMs??12000;
    if(this.url.protocol!=='https:'||this.url.username||this.url.password||this.url.search||this.url.hash||this.url.pathname!==ROUTE||
       !role.safeParse(c.role).success||!hex.safeParse(c.serverSpkiSha256).success||typeof c.credential!=='function'||
       !c.certificatePem?.includes('BEGIN CERTIFICATE')||!c.keyPem?.includes('PRIVATE KEY-----')||!c.serverCaPem?.includes('BEGIN CERTIFICATE')||
       !Number.isSafeInteger(this.timeout)||this.timeout<250||this.timeout>30000)throw Error('HELPER_SELECTION_TLS_CONFIG_INVALID');
    this.c=Object.freeze({...c,scope:Object.freeze(scope.parse(c.scope))});
    this.authorityKey=key(createPublicKey(c.authorityPublicKeyPem));
  }
  private async call(a:Action,args:unknown):Promise<unknown>{
    if(!allowed(this.c.role,a))return deny('HELPER_SELECTION_ROLE_DENIED');
    const nonce=randomBytes(32).toString('hex');
    const body=encode(wire.parse({domain:DOMAIN,scope:this.c.scope,role:this.c.role,nonce,action:a,args}));
    const started=process.hrtime.bigint();let req:ClientRequest|undefined,timer:ReturnType<typeof setTimeout>|undefined,expired=false;
    const deadline=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{expired=true;req?.destroy();reject(Error('HELPER_SELECTION_TRANSPORT_UNKNOWN'));},this.timeout);});
    try{
      const credential=token.parse(await Promise.race([Promise.resolve().then(()=>this.c.credential()),deadline]));
      if(expired)return deny('HELPER_SELECTION_TRANSPORT_UNKNOWN');
      const result=await Promise.race([new Promise<Buffer>((resolve,reject)=>{
        const abort=()=>{req?.destroy();reject(Error('HELPER_SELECTION_TRANSPORT_UNKNOWN'));};
        req=request(this.url,{method:'POST',agent:false,key:this.c.keyPem,cert:this.c.certificatePem,ca:this.c.serverCaPem,
          rejectUnauthorized:true,minVersion:'TLSv1.3',maxVersion:'TLSv1.3',secureOptions:constants.SSL_OP_NO_TICKET|constants.SSL_OP_NO_RENEGOTIATION,
          maxHeaderSize:8192,headers:{authorization:'Bearer '+credential,'content-type':'application/json','content-length':body.length,connection:'close'},
          checkServerIdentity:(host,cert)=>{const err=checkServerIdentity(host,cert);if(err)return err;
            try{if(digest(new X509Certificate(cert.raw).publicKey.export({type:'spki',format:'der'}))===this.c.serverSpkiSha256)return;}catch{}
            return Error('HELPER_SELECTION_TLS_PIN_MISMATCH');
          },
        },res=>{
          let expected:number;
          try{if(res.statusCode!==200)throw Error('denied');expected=exactHeaders(res);}catch{res.destroy();abort();return;}
          const chunks:Buffer[]=[];let size=0;
          res.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>expected){res.destroy();abort();return;}chunks.push(Buffer.from(chunk));});
          res.once('error',abort);res.once('aborted',abort);
          res.once('end',()=>{if(!res.complete||size!==expected){abort();return;}resolve(Buffer.concat(chunks));});
        });
        req.once('error',abort);req.end(body);
      }),deadline]);
      if(expired||process.hrtime.bigint()-started>=BigInt(this.timeout)*1000000n)return deny('HELPER_SELECTION_TRANSPORT_UNKNOWN');
      const e=envelope.parse(decode(result));
      if(!verify(null,Buffer.from(e.payload,'utf8'),this.authorityKey,proof(e.proof)))return deny('HELPER_SELECTION_SIGNATURE_INVALID');
      const p=payload.parse(JSON.parse(e.payload));
      if(p.domain!==DOMAIN||p.authorityId!==this.c.scope.authorityId||p.nonce!==nonce||p.action!==a||p.requestSha256!==digest(body))
        return deny('HELPER_SELECTION_RESPONSE_SCOPE_INVALID');
      return p.result;
    }finally{if(timer)clearTimeout(timer);req?.destroy();}
  }
  async beginRuntime(requestId:string):Promise<HelperLease>{
    const id=uuid.parse(requestId),l=lease.parse(await this.call('begin-runtime',{requestId:id}));
    if(l.kind!=='RUNTIME'||l.requestId!==id)return deny('HELPER_SELECTION_LEASE_RESPONSE_INVALID');return Object.freeze(l);
  }
  async beginDeployment(input:Readonly<HelperRequest>):Promise<HelperLease>{
    const request=deployment.parse(input),l=lease.parse(await this.call('begin-deployment',{request}));
    if(l.kind!=='DEPLOYMENT'||l.requestId!==request.requestId||l.expectedRevision!==request.expected.revision)
      return deny('HELPER_SELECTION_LEASE_RESPONSE_INVALID');return Object.freeze(l);
  }
  async read(leaseId:string):Promise<HelperSelection>{
    const v=selection.parse(await this.call('read',{leaseId:uuid.parse(leaseId)}));
    if(v.pin)Object.freeze(v.pin);return Object.freeze(v);
  }
  async commit(leaseId:string,input:Readonly<HelperRequest>):Promise<HelperCommit>{
    return z.enum(['COMMITTED','REJECTED','UNKNOWN']).parse(await this.call('commit',{leaseId:uuid.parse(leaseId),request:deployment.parse(input)}));
  }
  async release(leaseId:string):Promise<void>{ack.parse(await this.call('release',{leaseId:uuid.parse(leaseId)}));}
}
export interface HelperSelectionPrincipal {role:Role;scope:HelperAuthorityScope}
export function createProtectedHelperSelectionServer(config:{
  tls:Pick<ServerOptions,'key'|'cert'|'ca'>;scope:HelperAuthorityScope;authorityPrivateKeyPem:string;
  resolvePrincipal:(certificateSha256:string,credential:string)=>Promise<HelperSelectionPrincipal|undefined>;
  backend:PostgresHelperSelectionAuthority;
}){
  if(!config.tls?.key||!config.tls.cert||!config.tls.ca||typeof config.resolvePrincipal!=='function'||
    !(config.backend instanceof PostgresHelperSelectionAuthority))return deny('HELPER_SELECTION_SERVER_CONFIG_INVALID');
  const bound=Object.freeze(scope.parse(config.scope)),signer=key(createPrivateKey(config.authorityPrivateKeyPem)),backend=config.backend;
  if(!backend.matchesScope(bound))return deny('HELPER_SELECTION_BACKEND_SCOPE_MISMATCH');
  async function dispatch(w:Wire){
    const kind=w.role==='runtime'?'RUNTIME':'DEPLOYMENT';
    switch(w.action){
      case 'begin-runtime':return backend.beginRuntime(w.args.requestId);
      case 'begin-deployment':return backend.beginDeployment(w.args.request);
      case 'read':return backend.read(w.args.leaseId,kind);
      case 'commit':return backend.commit(w.args.leaseId,w.args.request);
      case 'release':await backend.release(w.args.leaseId,kind);return {accepted:true};
    }
  }
  return createServer({...config.tls,requestCert:true,rejectUnauthorized:true,minVersion:'TLSv1.3',maxVersion:'TLSv1.3',
    secureOptions:constants.SSL_OP_NO_TICKET|constants.SSL_OP_NO_RENEGOTIATION,maxHeaderSize:8192,requestTimeout:10000,headersTimeout:5000,keepAliveTimeout:1000},
    (req,res)=>{void(async()=>{
      const socket=req.socket as TLSSocket,cert=socket.getPeerCertificate(),auth=req.headersDistinct.authorization;
      if(req.method!=='POST'||req.url!==ROUTE||!socket.authorized||!cert.raw||auth?.length!==1||!auth[0]?.startsWith('Bearer '))
        return deny('HELPER_SELECTION_PEER_DENIED');
      const credential=token.parse(auth[0].slice(7));
      const raw=await readRequest(req),w=wire.parse(decode(raw));
      if(!sameScope(w.scope,bound)||!allowed(w.role,w.action))return deny('HELPER_SELECTION_PEER_DENIED');
      let timer:ReturnType<typeof setTimeout>|undefined;
      try{
        const principal=await Promise.race([config.resolvePrincipal(digest(cert.raw),credential),new Promise<undefined>(resolve=>{timer=setTimeout(()=>resolve(undefined),4000);})]);
        if(!principal||principal.role!==w.role||!sameScope(scope.parse(principal.scope),bound)||req.socket.destroyed)
          return deny('HELPER_SELECTION_PEER_DENIED');
      }finally{if(timer)clearTimeout(timer);}
      // Backend repeats the current grant, provenance, exact lease and
      // independent evidence checks under the shared revoke row lock.
      const result=await dispatch(w);
      const p=JSON.stringify({domain:DOMAIN,authorityId:bound.authorityId,nonce:w.nonce,action:w.action,requestSha256:digest(raw),result});
      const body=encode({payload:p,proof:sign(null,Buffer.from(p,'utf8'),signer).toString('base64url')});
      res.writeHead(200,{'content-type':'application/json','content-length':body.length,'cache-control':'no-store','connection':'close'});res.end(body);
    })().catch(()=>{if(res.headersSent){res.destroy();return;}res.writeHead(403,{'content-type':'application/json','cache-control':'no-store','connection':'close'});res.end('{"error":"HELPER_SELECTION_DENIED"}');});});
}
