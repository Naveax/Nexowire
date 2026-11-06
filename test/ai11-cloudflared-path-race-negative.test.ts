import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,readFile,rename,rm,stat,writeFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {loadConfig} from '../src/config.js';
import {startCloudflareConnection} from '../src/mcp/local-first-cloudflare.js';
import {verifyLocalFirstPublicUpstream} from '../src/mcp/local-first-ingress.js';

// POSIX-only disposable reproducer for P1-A. No real Cloudflare credentials,
// DNS, remote network, live owner device, elevated task or installation.
// The first executable is hash-verified before Hub preflight. A controlled
// *local* Hub health response atomically replaces the same path before spawn.
// A witnessed replacement must NEVER execute, even with a matching old hash.
// NOTE: A future official-publisher gate may reject the initial fake binary
// before this race is reached; that alone is not full immutable-image proof.
test('AI-11 P1-A: binary swap after checksum, before spawn never executes replacement', {
  skip:process.platform==='win32',
  timeout:15000,
},async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'nw-ai11-binary-race-'));
  t.after(()=>rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100}));
  const binary=path.join(root,'disposable-cloudflared');
  const replacement=path.join(root,'replacement');
  const marker=path.join(root,'executed.marker');
  await writeFile(binary,'#!/bin/sh\nexit 0\n',{mode:0o700});
  await writeFile(replacement,
    '#!/bin/sh\nprintf "swapped binary executed" > '+JSON.stringify(marker)+'\nexit 0\n',{mode:0o700});
  const digest=createHash('sha256').update(await readFile(binary)).digest('hex');
  const tunnelId=randomUUID();
  const credentialsFile=path.join(root,'fake-tunnel.json');
  await writeFile(credentialsFile,JSON.stringify({
    TunnelID:tunnelId,AccountTag:'a'.repeat(32),
    TunnelSecret:Buffer.alloc(32,7).toString('base64'),
  }),{mode:0o600});

  let armed=false,swapped=false;
  const hub=createServer((req,res)=>{
    void(async()=>{
      res.setHeader('content-type','application/json');
      if(req.url==='/health'){
        if(armed&&!swapped){
          await rename(replacement,binary);
          swapped=true;
        }
        res.end(JSON.stringify({ok:true,service:'nexowire',runtime:{ownerOauthConfigured:true}}));
      }else if(req.url==='/.well-known/oauth-protected-resource/mcp'){
        res.end(JSON.stringify({
          resource:'https://mcp.example.test/mcp',
          authorization_servers:['https://control.example.test'],
        }));
      }else{
        res.writeHead(404);res.end('{}');
      }
    })().catch(()=>{
      if(!res.headersSent)res.writeHead(503);
      res.end('{}');
    });
  });
  await new Promise<void>(r=>hub.listen(0,'127.0.0.1',r));
  t.after(()=>new Promise<void>(r=>hub.close(()=>r())));
  const hubAddress=hub.address();assert.ok(hubAddress&&typeof hubAddress!=='string');
  const probe=createServer();
  await new Promise<void>(r=>probe.listen(0,'127.0.0.1',r));
  const probeAddress=probe.address();assert.ok(probeAddress&&typeof probeAddress!=='string');
  await new Promise<void>(r=>probe.close(()=>r()));

  const config=loadConfig({
    NEXOWIRE_HTTP_PORT:String(hubAddress.port),
    NEXOWIRE_MCP_RESOURCE_URL:'https://mcp.example.test/mcp',
    NEXOWIRE_CONTROL_PLANE_URL:'https://control.example.test',
    NEXOWIRE_CONTROL_PLANE_SERVICE_TOKEN:'disposable-service-token-0123456789',
  });
  // Prove a healthy local Hub before arming the deterministic path replacement.
  await verifyLocalFirstPublicUpstream({
    hubPort:hubAddress.port,expectedResourceUrl:config.mcpResourceUrl!,
  });
  armed=true;
  const profile={version:1,hostname:'mcp.example.test',tunnelId,binary,
    binarySha256:digest,credentialsFile,listenPort:probeAddress.port};
  let handle:Awaited<ReturnType<typeof startCloudflareConnection>>|undefined;
  try{
    handle=await startCloudflareConnection(profile,config);
    await handle.done.catch(()=>{});
  }catch{
    // Rejecting before spawn is allowed. We assert the observable side effect.
  }finally{
    await handle?.close();
  }
  const spawned=await stat(marker).then(()=>true,()=>false);
  if(!swapped)t.diagnostic('Publisher/binary preflight stopped before race; separate trusted-image race proof remains required.');
  assert.equal(spawned,false,'unverified replacement executed after a successful checksum on a different file identity');
});
