import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {mkdtemp,copyFile,chmod,writeFile,readFile,stat,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {loadConfig} from '../src/config.js';
import {cloudflareConnectionConfig,startCloudflareConnection} from '../src/mcp/local-first-cloudflare.js';

// AI-11: all fixtures are disposable. Nothing reaches Cloudflare or the
// Internet; no real tunnel secret, owner token, PC, DNS, UAC or ACL is changed.
function config(authority='https://control.example.test',hubPort=43110){
  return loadConfig({
    NEXOWIRE_HTTP_PORT:String(hubPort),
    NEXOWIRE_MCP_RESOURCE_URL:'https://mcp.example.test/mcp',
    NEXOWIRE_CONTROL_PLANE_URL:authority,
    NEXOWIRE_CONTROL_PLANE_SERVICE_TOKEN:'disposable-service-token-0123456789',
  });
}
function profile(){
  return {version:1,hostname:'mcp.example.test',tunnelId:randomUUID(),
    binary:path.resolve('disposable-binary'),binarySha256:'a'.repeat(64),
    credentialsFile:path.resolve('disposable-credential.json'),listenPort:43111};
}

test('AI-11 P1-C: mapped IPv6, compact/octal IPv4, reserved networks and metadata authorities cannot be public control-plane targets',()=>{
  const forbidden=[
    'https://[::ffff:127.0.0.1]',
    'https://[::ffff:169.254.169.254]',
    'https://[::ffff:192.168.1.20]',
    'https://[fc00::1]',
    'https://[fe80::1]',
    'https://[::]',
    'https://[2001:db8::1]',
    'https://127.1',
    'https://2130706433',
    'https://0177.0.0.1',
    'https://0',
    'https://100.64.0.1',
    'https://198.18.0.1',
    'https://224.0.0.1',
    'https://metadata.google.internal',
    'https://metadata.azure.internal',
  ];
  const accepted:string[]=[];
  for(const authority of forbidden){
    try{cloudflareConnectionConfig(profile(),config(authority));accepted.push(authority);}
    catch{/* expected denial */}
  }
  assert.deepEqual(accepted,[],
    'Cloudflare public control-plane admission must deny every non-public or metadata target');
});

// P1-D owner-only custody test: file permissions must be checked BEFORE
// consuming a tunnel credential or contacting Hub/spawning cloudflared.
// The root is intentionally traversable to avoid private-parent masking of
// group/world readable fake secrets. No real credentials are ever used.
// Once P1-B publisher gating exists, use an independently trusted, disposable
// signed connector fixture to reach this boundary; an unrelated binary refusal
// must never be recorded as a P1-D PASS.
async function fixture(t:import('node:test').TestContext,mode:number){
  const root=await mkdtemp(path.join(os.tmpdir(),'nw-ai11-credential-mode-'));
  t.after(()=>rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100}));
  if(process.platform!=='win32')await chmod(root,0o755);
  const binary=path.join(root,'untrusted-native-executable');
  await copyFile(process.execPath,binary);
  if(process.platform!=='win32')await chmod(binary,0o700);
  const binarySha256=createHash('sha256').update(await readFile(binary)).digest('hex');
  const tunnelId=randomUUID();
  const credentialsFile=path.join(root,'disposable-tunnel.json');
  await writeFile(credentialsFile,JSON.stringify({
    TunnelID:tunnelId,AccountTag:'a'.repeat(32),
    TunnelSecret:Buffer.alloc(32,7).toString('base64'),
  }),{mode:0o600});
  await chmod(credentialsFile,mode);
  assert.equal((await stat(credentialsFile)).mode&0o777,mode,'test mode applied');

  const hub=createServer((req,res)=>{
    res.setHeader('content-type','application/json');
    if(req.url==='/health'){
      res.end(JSON.stringify({ok:true,service:'nexowire',
        runtime:{ownerOauthConfigured:true}}));
    }else if(req.url==='/.well-known/oauth-protected-resource/mcp'){
      res.end(JSON.stringify({resource:'https://mcp.example.test/mcp',
        authorization_servers:['https://control.example.test']}));
    }else{res.writeHead(404);res.end('{}');}
  });
  await new Promise<void>(r=>hub.listen(0,'127.0.0.1',r));
  t.after(()=>new Promise<void>(r=>hub.close(()=>r())));
  const address=hub.address();assert.ok(address&&typeof address!=='string');
  const reservation=createServer();
  await new Promise<void>(r=>reservation.listen(0,'127.0.0.1',r));
  const free=reservation.address();assert.ok(free&&typeof free!=='string');
  await new Promise<void>(r=>reservation.close(()=>r()));
  return {c:config('https://control.example.test',address.port),
    p:{version:1,hostname:'mcp.example.test',tunnelId,binary,
      binarySha256,credentialsFile,listenPort:free.port}};
}

test('AI-11 P1-D: POSIX group/world-readable tunnel credentials fail custody admission, not only later network checks',{
  skip:process.platform==='win32',
  timeout:20000,
},async t=>{
  for(const [name,mode] of [['group-readable',0o640],['world-readable',0o644]] as const){
    await t.test(name,async caseContext=>{
      const {c,p}=await fixture(caseContext,mode);
      let handle:Awaited<ReturnType<typeof startCloudflareConnection>>|undefined;
      try{
        await assert.rejects(async()=>{handle=await startCloudflareConnection(p,c);},
          /(?:credential|tunnel).{0,120}(?:owner|permission|mode|access|custody|private|unsafe|ACL|DACL)/i,
          'insecure credential access must be rejected for the custody violation');
      }finally{
        await handle?.close();
      }
    });
  }
});
