import {createHash,X509Certificate,constants} from 'node:crypto';
import {request} from 'node:https';
import type {ClientRequest} from 'node:http';
import {checkServerIdentity} from 'node:tls';
import {HttpsBrokerDispatchAuthority} from './https-broker-dispatch-authority.js';

export interface ProtectedDispatchTlsOptions {
  endpoint:string;keyPem:string;certificatePem:string;serverCaPem:string;
  serverSpkiSha256:string;timeoutMs?:number;
}
const allowedActions=new Set(['begin','commit','revoke-and-drain','release']);

/** Dispatch-only transport. Explicit client identity, server CA and SPKI pin;
 * no global trust mutation, redirects, shared sockets or automatic replay. */
export function createBrokerDispatchMtlsFetch(config:ProtectedDispatchTlsOptions):typeof fetch{
  const {endpoint,keyPem,certificatePem,serverCaPem,serverSpkiSha256}=config;
  const timeout=config.timeoutMs??3500;
  let base:URL;
  try{base=new URL(endpoint)}catch{throw Error('DISPATCH_MTLS_CONFIGURATION_INVALID')}
  if(base.protocol!=='https:'||base.username||base.password||base.search||base.hash||
    base.pathname!=='/v1/broker-dispatch'||!Number.isSafeInteger(timeout)||timeout<100||timeout>10000||
    typeof keyPem!=='string'||!keyPem.includes('PRIVATE KEY-----')||
    typeof certificatePem!=='string'||!certificatePem.includes('BEGIN CERTIFICATE')||
    typeof serverCaPem!=='string'||!serverCaPem.includes('BEGIN CERTIFICATE')||
    typeof serverSpkiSha256!=='string'||!/^[0-9a-f]{64}$/.test(serverSpkiSha256))
    throw Error('DISPATCH_MTLS_CONFIGURATION_INVALID');
  return async(input,init)=>{
    if(typeof input!=='string'&&!(input instanceof URL))throw Error('DISPATCH_MTLS_REQUEST_INVALID');
    const target=new URL(String(input));
    const action=target.pathname.slice('/v1/broker-dispatch/'.length);
    if(target.origin!==base.origin||target.username||target.password||target.search||target.hash||
      target.pathname!=='/v1/broker-dispatch/'+action||!allowedActions.has(action)||
      init?.method!=='POST'||init.redirect!=='error'||typeof init.body!=='string')
      throw Error('DISPATCH_MTLS_REQUEST_INVALID');
    const headers=new Headers(init.headers),body=Buffer.from(init.body,'utf8');
    const authorization=headers.get('authorization')??'';
    if(body.length>16384||![...headers.keys()].every(k=>k==='authorization'||k==='content-type')||
      !/^Bearer [A-Za-z0-9_-]{32,2048}$/.test(authorization)||
      headers.get('content-type')!=='application/json')throw Error('DISPATCH_MTLS_REQUEST_INVALID');
    const signal=init.signal;
    if(signal?.aborted)throw Error('DISPATCH_MTLS_REQUEST_UNKNOWN');
    return await new Promise<Response>((resolve,reject)=>{
      let settled=false,req:ClientRequest|undefined;
      const started=process.hrtime.bigint();
      const cleanup=()=>{clearTimeout(timer);signal?.removeEventListener('abort',fail)};
      const fail=()=>{
        if(settled)return;settled=true;cleanup();req?.destroy();
        reject(Error('DISPATCH_MTLS_REQUEST_UNKNOWN'));
      };
      const timer=setTimeout(fail,timeout);timer.unref();
      const finish=(response:Response)=>{
        const elapsed=process.hrtime.bigint()-started;
        if(signal?.aborted||elapsed<0n||elapsed>=BigInt(timeout)*1000000n){fail();return}
        if(settled)return;settled=true;cleanup();resolve(response);
      };
      try{
        req=request(target,{method:'POST',agent:false,key:keyPem,cert:certificatePem,
          ca:serverCaPem,rejectUnauthorized:true,minVersion:'TLSv1.3',maxVersion:'TLSv1.3',
          secureOptions:constants.SSL_OP_NO_TICKET|constants.SSL_OP_NO_RENEGOTIATION,
          maxHeaderSize:8192,headers:{authorization,'content-type':'application/json',
            'content-length':body.length,connection:'close'},
          checkServerIdentity(host,cert){
            const error=checkServerIdentity(host,cert);if(error)return error;
            try{
              const spki=new X509Certificate(cert.raw).publicKey.export({type:'spki',format:'der'});
              if(createHash('sha256').update(spki).digest('hex')===serverSpkiSha256)return;
            }catch{}
            return Error('DISPATCH_MTLS_SERVER_IDENTITY_INVALID');
          },
        },res=>{
          const status=res.statusCode??0;
          const expected=action==='release'?204:200;
          if(status!==expected){
            // Never follow redirects or buffer untrusted error bodies.
            if(status<200||status>599){res.destroy();fail();return}
            finish(new Response(null,{status}));res.destroy();return;
          }
          const types=res.headersDistinct['content-type'],encoding=res.headersDistinct['content-encoding'];
          if(encoding!==undefined&&(encoding.length!==1||encoding[0]!=='identity')){
            res.destroy();fail();return;
          }
          if(expected===200&&(types?.length!==1||
            !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(types[0]??''))){
            res.destroy();fail();return;
          }
          if(expected===204&&(res.headersDistinct['content-length']!==undefined||
            res.headersDistinct['transfer-encoding']!==undefined)){
            res.destroy();fail();return;
          }
          let size=0;const chunks:Buffer[]=[];
          res.on('data',(chunk:Buffer)=>{
            size+=chunk.length;
            if(size>(expected===200?8192:0)){res.destroy();fail();return}
            chunks.push(Buffer.from(chunk));
          });
          res.once('error',fail);res.once('aborted',fail);
          res.once('end',()=>{
            if(!res.complete){fail();return}
            finish(expected===204?new Response(null,{status:204}):
              new Response(Buffer.concat(chunks),{status:200,
                headers:{'content-type':'application/json','cache-control':'no-store'}}));
          });
        });
      }catch{fail();return}
      req.once('error',fail);
      signal?.addEventListener('abort',fail,{once:true});
      if(signal?.aborted){fail();return}
      req.end(body);
    });
  };
}

/** Explicit protected client composition. Not an enrollment mechanism or a
 * native evidence provider. Caller must provision credentials independently. */
export function createProtectedHttpsBrokerDispatchAuthority(config:ProtectedDispatchTlsOptions&{
  brokerCredential:()=>Promise<string|undefined>;
}):HttpsBrokerDispatchAuthority{
  const {endpoint,timeoutMs,brokerCredential}=config;
  const transport=createBrokerDispatchMtlsFetch(config);
  return new HttpsBrokerDispatchAuthority({endpoint,timeoutMs,brokerCredential,transport});
}
