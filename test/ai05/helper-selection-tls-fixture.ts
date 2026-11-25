import {execFileSync} from 'node:child_process';
import {createHash,generateKeyPairSync,X509Certificate} from 'node:crypto';
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Disposable fixture only. Never install these certificates in OS trust. */
export function createHelperSelectionTlsFixture(){
  const root=mkdtempSync(path.join(os.tmpdir(),'nx-ai05-tls-'));
  const run=(args:string[])=>execFileSync('openssl',args,{cwd:root,stdio:'pipe',timeout:30000});
  const read=(file:string)=>readFileSync(path.join(root,file),'utf8');
  try{
    run(['req','-x509','-newkey','rsa:2048','-nodes','-keyout','ca.key','-out','ca.pem','-days','1','-subj','/CN=AI05 disposable CA','-addext','basicConstraints=critical,CA:TRUE','-addext','keyUsage=critical,keyCertSign,cRLSign']);
    const issue=(name:string,extensions:string)=>{
      run(['req','-new','-newkey','rsa:2048','-nodes','-keyout',name+'.key','-out',name+'.csr','-subj','/CN='+name]);
      writeFileSync(path.join(root,name+'.ext'),extensions);
      run(['x509','-req','-in',name+'.csr','-CA','ca.pem','-CAkey','ca.key','-CAcreateserial','-out',name+'.pem','-days','1','-extfile',name+'.ext']);
      const cert=read(name+'.pem'),key=read(name+'.key'),x=new X509Certificate(cert);
      return {cert,key,certSha256:createHash('sha256').update(x.raw).digest('hex'),spkiSha256:createHash('sha256').update(x.publicKey.export({type:'spki',format:'der'})).digest('hex')};
    };
    const server=issue('server','basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=IP:127.0.0.1\n');
    const runtime=issue('runtime','basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=clientAuth\n');
    const deployment=issue('deployment','basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=clientAuth\n');
    const signer=generateKeyPairSync('ed25519'),other=generateKeyPairSync('ed25519');
    return {ca:read('ca.pem'),server,runtime,deployment,privateKey:signer.privateKey.export({type:'pkcs8',format:'pem'}).toString(),
      publicKey:signer.publicKey.export({type:'spki',format:'pem'}).toString(),wrongPublicKey:other.publicKey.export({type:'spki',format:'pem'}).toString(),
      close(){rmSync(root,{recursive:true,force:true});}};
  }catch(error){rmSync(root,{recursive:true,force:true});throw error;}
}
