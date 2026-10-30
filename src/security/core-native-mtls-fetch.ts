import {createHash,X509Certificate,constants} from 'node:crypto';
import {request} from 'node:https';
import {checkServerIdentity} from 'node:tls';
import type {ClientRequest} from 'node:http';

/** Narrow fetch adapter for the independent native enrollment verifier only.
 * All credentials/pins are provisioned by the protected host, never the Agent.
 * No listener, enrollment, retry, TLS bypass or production default is created. */
export function createCoreNativeMtlsFetch(config:{
  origin:string;keyPem:string;certificatePem:string;serverCaPem:string;
  serverSpkiSha256:string;timeoutMs?:number;
}):typeof fetch {
  const {origin,keyPem,certificatePem,serverCaPem,serverSpkiSha256}=config;
  const timeout=config.timeoutMs??3500;
  let allowed:URL;
  try{allowed=new URL(origin)}catch{throw Error('CORE_MTLS_CONFIGURATION_INVALID')}
  if(allowed.protocol!=='https:'||allowed.username||allowed.password||allowed.pathname!=='/'||
    allowed.search||allowed.hash||!Number.isSafeInteger(timeout)||timeout<100||timeout>10000||
    !/^[a-f0-9]{64}$/.test(serverSpkiSha256)||
    typeof keyPem!=='string'||!keyPem.includes('PRIVATE KEY-----')||
    typeof certificatePem!=='string'||!certificatePem.includes('BEGIN CERTIFICATE')||
    typeof serverCaPem!=='string'||!serverCaPem.includes('BEGIN CERTIFICATE'))
    throw Error('CORE_MTLS_CONFIGURATION_INVALID');
  const endpoint=allowed.origin+'/v1/core-native-consent';
  return async(input,init)=>{
    // Request objects/streaming bodies can carry mutable or hidden options.
    if((typeof input!=='string'&&!(input instanceof URL))||String(input)!==endpoint||
      init?.method!=='POST'||init.redirect!=='error'||typeof init.body!=='string')
      throw Error('CORE_MTLS_REQUEST_INVALID');
    const headers=new Headers(init.headers),body=Buffer.from(init.body,'utf8');
    if(body.length>16384||![...headers.keys()].every(k=>k==='authorization'||k==='content-type')||
      !/^Bearer [^\s,]{16,2048}$/.test(headers.get('authorization')??'')||
      headers.get('content-type')!=='application/json')throw Error('CORE_MTLS_REQUEST_INVALID');
    const authorization=headers.get('authorization')!;
    const signal=init.signal;
    if(signal?.aborted)throw Error('CORE_MTLS_REQUEST_UNKNOWN');
    return await new Promise<Response>((resolve,reject)=>{
      let settled=false;
      let req:ClientRequest|undefined;
      const started=process.hrtime.bigint();
      const fail=()=>{
        if(settled)return;settled=true;cleanup();req?.destroy();
        reject(Error('CORE_MTLS_REQUEST_UNKNOWN'));
      };
      const timer=setTimeout(fail,timeout);timer.unref();
      const cleanup=()=>{clearTimeout(timer);signal?.removeEventListener('abort',fail)};
      try{req=request(endpoint,{method:'POST',agent:false,key:keyPem,cert:certificatePem,
        ca:serverCaPem,rejectUnauthorized:true,minVersion:'TLSv1.3',maxVersion:'TLSv1.3',
        secureOptions:constants.SSL_OP_NO_TICKET|constants.SSL_OP_NO_RENEGOTIATION,
        maxHeaderSize:8192,headers:{authorization,'content-type':'application/json',
          'content-length':body.length,'connection':'close'},
        checkServerIdentity(host,cert){
          const identityError=checkServerIdentity(host,cert);if(identityError)return identityError;
          try{
            const spki=new X509Certificate(cert.raw).publicKey.export({type:'spki',format:'der'});
            if(createHash('sha256').update(spki).digest('hex')===serverSpkiSha256)return;
          }catch{}
          return Error('CORE_MTLS_SERVER_IDENTITY_INVALID');
        },
      },res=>{
        if(res.statusCode!==200||res.headers['content-encoding']&&res.headers['content-encoding']!=='identity'){
          res.destroy();fail();return;
        }
        const chunks:Buffer[]=[];let length=0;
        res.on('data',(chunk:Buffer)=>{
          length+=chunk.length;if(length>32768){res.destroy();fail();return}
          chunks.push(Buffer.from(chunk));
        });
        res.once('error',fail);res.once('aborted',fail);
        res.once('end',()=>{
          if(settled)return;
          const elapsed=process.hrtime.bigint()-started;
          if(signal?.aborted||elapsed<0n||elapsed>=BigInt(timeout)*1000000n){fail();return}
          settled=true;cleanup();resolve(new Response(Buffer.concat(chunks),{status:200,
            headers:{'content-type':'application/json','cache-control':'no-store'}}));
        });
      });}catch{fail();return}
      req.once('error',fail);
      signal?.addEventListener('abort',fail,{once:true});
      if(signal?.aborted){fail();return}
      req.end(body);
    });
  };
}
