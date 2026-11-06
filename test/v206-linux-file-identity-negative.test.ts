import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {createServer,type Server} from 'node:http';
import {copyFile,chmod,link,mkdtemp,readFile,rm,symlink,writeFile} from 'node:fs/promises';
import type {AddressInfo} from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {loadConfig} from '../src/config.js';
import {startCloudflareConnection} from '../src/mcp/local-first-cloudflare.js';

/** Linux filesystem tests use real inodes/modes, never security decision mocks. */
async function listen(server:Server):Promise<number>{
  await new Promise<void>((resolve,reject)=>{
    server.once('error',reject);
    server.listen(0,'127.0.0.1',()=>{server.off('error',reject);resolve();});
  });
  const address=server.address();assert.ok(address&&typeof address!=='string');
  return (address as AddressInfo).port;
}
async function close(server:Server):Promise<void>{
  server.closeAllConnections();
  await new Promise<void>((resolve,reject)=>server.close(err=>err?reject(err):resolve()));
}
async function fixture(t:import('node:test').TestContext){
  const root=await mkdtemp(path.join(os.tmpdir(),'nw-v206-custody-'));
  t.after(()=>rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100}));
  await chmod(root,0o700);
  const binary=path.join(root,'disposable-node-copy');
  await copyFile(process.execPath,binary);
  await chmod(binary,0o700);
  const binarySha256=createHash('sha256').update(await readFile(binary)).digest('hex');
  const credentialsFile=path.join(root,'synthetic-tunnel.json');
  const tunnelId=randomUUID();
  await writeFile(credentialsFile,JSON.stringify({
    TunnelID:tunnelId,AccountTag:'a'.repeat(32),
    TunnelSecret:Buffer.alloc(32,7).toString('base64'),
  }),{mode:0o600});
  const hub=createServer((req,res)=>{
    res.setHeader('content-type','application/json');
    if(req.url==='/health'){
      res.end(JSON.stringify({ok:true,service:'nexowire',runtime:{ownerOauthConfigured:true}}));
    }else if(req.url==='/.well-known/oauth-protected-resource/mcp'){
      res.end(JSON.stringify({resource:'https://mcp.example.test/mcp',
        authorization_servers:['https://control.example.test']}));
    }else{res.writeHead(404);res.end('{}');}
  });
  const hubPort=await listen(hub);
  t.after(()=>close(hub));
  const portReservation=createServer();
  const listenPort=await listen(portReservation);
  await close(portReservation);
  return {
    root,binary,credentialsFile,
    profile:{version:1,hostname:'mcp.example.test',tunnelId,binary,binarySha256,
      credentialsFile,listenPort},
    config:loadConfig({
      NEXOWIRE_HTTP_PORT:String(hubPort),
      NEXOWIRE_MCP_RESOURCE_URL:'https://mcp.example.test/mcp',
      NEXOWIRE_CONTROL_PLANE_URL:'https://control.example.test',
      NEXOWIRE_CONTROL_PLANE_SERVICE_TOKEN:'disposable-service-token-only-0123456789',
    }),
  };
}
async function rejectForReason(input:Awaited<ReturnType<typeof fixture>>,
  reason:RegExp):Promise<void>{
  let handle:Awaited<ReturnType<typeof startCloudflareConnection>>|undefined;
  try{
    await assert.rejects(async()=>{handle=await startCloudflareConnection(input.profile,input.config);},
      reason,'deny for the named custody/identity violation, NOT an unrelated publisher/network failure');
  }finally{await handle?.close();}
}
const linuxOnly={skip:process.platform!=='linux',timeout:15000};

test('V2-06 P1-D real hardlinked credential must fail owner-only custody',linuxOnly,async t=>{
  const f=await fixture(t);
  await link(f.credentialsFile,path.join(f.root,'credential-alias.json'));
  await rejectForReason(f,/credential.{0,120}(custody|unsafe|hardlink|link)/i);
});
test('V2-06 P1-D real writable parent directory must fail credential custody',linuxOnly,async t=>{
  const f=await fixture(t);
  await chmod(f.root,0o777);
  await rejectForReason(f,/credential.{0,120}(custody|unsafe|parent|permission)/i);
});
test('V2-06 P1-A real hardlinked executable path cannot enter launch admission',linuxOnly,async t=>{
  const f=await fixture(t);
  await link(f.binary,path.join(f.root,'binary-alias'));
  await rejectForReason(f,/binary.{0,120}(hardlink|unsafe|path)|hardlink.{0,120}binary/i);
});
test('V2-06 P1-D symlink credential file fails before connector launch',linuxOnly,async t=>{
  const f=await fixture(t);
  const linked=path.join(f.root,'credential-symlink.json');
  await symlink(f.credentialsFile,linked);
  f.profile.credentialsFile=linked;
  await rejectForReason(f,/credential.{0,120}(custody|unsafe)|bounded regular file/i);
});
