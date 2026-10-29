import {Pool} from 'pg';
import type {DispatchStorePool} from './postgres-broker-dispatch-authority.js';

/** Explicit protected service configuration only. Never reads Agent env/URLs. */
export function createProtectedPostgresDispatchPool(config:{
  host:string;port:number;database:string;user:string;password:string;
  caPem:string;clientCertificatePem:string;clientKeyPem:string;
}):{pool:DispatchStorePool;close:()=>Promise<void>}{
  const {host,port,database,user,password,caPem,clientCertificatePem,clientKeyPem}=config;
  if(!/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/i.test(host)||
    !Number.isInteger(port)||port<1||port>65535||
    !/^[a-z0-9_]{1,63}$/i.test(database)||!/^[a-z0-9_]{1,63}$/i.test(user)||
    !password||password.length>2048||/[\r\n\0]/.test(password)||
    !caPem.includes('-----BEGIN CERTIFICATE-----')||
    !clientCertificatePem.includes('-----BEGIN CERTIFICATE-----')||
    !/-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/.test(clientKeyPem))
    throw new Error('DISPATCH_PG_PROTECTED_CONFIGURATION_REQUIRED');
  // Deliberately no connectionString: URL sslmode/sslcert options must not
  // override CA, peer-name verification or the explicit client identity.
  const pg=new Pool({host,port,database,user,password,max:8,
    connectionTimeoutMillis:3000,idleTimeoutMillis:10000,
    application_name:'nexowire-protected-dispatch-authority',
    enableChannelBinding:true,
    ssl:{rejectUnauthorized:true,servername:host,minVersion:'TLSv1.3',
      ca:caPem,cert:clientCertificatePem,key:clientKeyPem}});
  let unavailable=false;
  pg.on('error',()=>{unavailable=true;});
  return {
    pool:{async connect(){
      if(unavailable)throw new Error('DISPATCH_PG_RECONCILIATION_REQUIRED');
      const client=await pg.connect();
      if(unavailable){client.release(true);throw new Error('DISPATCH_PG_RECONCILIATION_REQUIRED');}
      return {query:async(sql,values=[])=>({rows:(await client.query(sql,values)).rows as Record<string,unknown>[]}),
        release:(destroy=false)=>client.release(destroy)};
    }},
    close:async()=>{unavailable=true;await pg.end();},
  };
}
