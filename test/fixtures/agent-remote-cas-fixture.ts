import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {createServer as createHttpsServer} from 'node:https';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {
  createIndependentCasHandler,provisionIndependentCasDatabase,
  type IndependentCasCredential,
} from '../../src/agent/remote-mutation-cas.js';

function opensslBinary():string{
  for(const bin of ['openssl','C:\\Program Files\\Git\\usr\\bin\\openssl.exe']){
    try{execFileSync(bin,['version'],{stdio:'ignore'});return bin}catch{}
  }
  throw new Error('OpenSSL required for isolated HTTPS CAS tests');
}
/**
 * Tests only. Remote DB and TLS key are in their own disposable directory
 * OUTSIDE the journal backups. Never use for production provisioning.
 */
export async function isolatedRemoteCas(root:string,deviceId=randomUUID(),maxPageGrowthForTest?:number){
  const remote=path.join(root,'remote-cas-host');
  await fs.mkdir(remote,{recursive:true});
  const certificate=path.join(remote,'cas.crt');
  const privateKey=path.join(remote,'cas.key');
  execFileSync(opensslBinary(),[
    'req','-x509','-newkey','rsa:2048','-sha256','-nodes',
    '-keyout',privateKey,'-out',certificate,
    '-days','1','-subj','/CN=localhost',
    '-addext','subjectAltName=DNS:localhost,IP:127.0.0.1',
    '-addext','basicConstraints=critical,CA:TRUE',
  ],{stdio:'ignore',timeout:30000});
  const authorityId=randomUUID(),epoch=randomUUID();
  const credentials:IndependentCasCredential[]=[{
    token:randomUUID()+randomUUID(),deviceId,epoch,
  }];
  const dbFile=path.join(remote,'persistent-reservations.sqlite');
  await provisionIndependentCasDatabase(dbFile,authorityId);
  const backend=await createIndependentCasHandler({
    dbFile,authorityId,credentials:()=>credentials,maxPageGrowthForTest,
  });
  const server=createHttpsServer({
    key:await fs.readFile(privateKey),cert:await fs.readFile(certificate),
  },backend.handler);
  await new Promise<void>(resolve=>server.listen(0,'localhost',resolve));
  const address=server.address();
  if(!address||typeof address==='string')throw new Error('No isolated HTTPS port');
  let stopped=false;
  return {
    root:remote,dbFile,authorityId,epoch,deviceId,credentials,
    certificate,
    url:'https://localhost:'+address.port+'/v1/reservations',
    settings:{
      endpoint:'https://localhost:'+address.port+'/v1/reservations',
      token:credentials[0]!.token,deviceId,epoch,authorityId,
    },
    env:{
      NEXOWIRE_AGENT_RESERVATION_CAS_URL:
        'https://localhost:'+address.port+'/v1/reservations',
      NEXOWIRE_AGENT_RESERVATION_CAS_TOKEN:credentials[0]!.token,
      NEXOWIRE_AGENT_RESERVATION_CAS_AUTHORITY_ID:authorityId,
      NEXOWIRE_AGENT_RESERVATION_CAS_EPOCH:epoch,
      NODE_EXTRA_CA_CERTS:certificate,
    },
    async stop(){
      if(stopped)return;
      stopped=true;
      server.closeAllConnections();
      await new Promise<void>(resolve=>server.close(()=>resolve()));
      backend.close();
    },
  };
}
