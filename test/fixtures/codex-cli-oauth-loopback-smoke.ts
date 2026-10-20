/**
 * MANUAL TEST ONLY: Invoke with node --import tsx test/fixtures/codex-cli-oauth-loopback-smoke.ts
 * Executes an actual installed Codex CLI against a loopback-only synthetic
 * authorization server. Never interacts with production accounts/endpoints.
 * Never print bearer tokens, refresh tokens, OAuth codes, URLs or CLI output.
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { MemoryMcpOAuthStore } from '../../src/product/memory-mcp-oauth-store.js';
import { McpOAuthService } from '../../src/product/mcp-oauth.js';
import { createMcpOAuthHttpHandler } from '../../src/product/mcp-oauth-http.js';

const metrics = {
  cliAdd: false, cliLogin: false, discovery: 0,
  dcr: 0, authorize: 0, codeExchange: 0,
  authenticatedMcp: 0, unauthenticatedMcp: 0,
  callbackAttempted: false, loopbackOnly: true,
};
let phase = 'setup';
function nativeCodexExe(): string {
  // The fixture runs on Windows only and invokes the exact native Codex
  // binary rather than a CMD/PowerShell wrapper that can orphan descendants.
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    throw new Error('native_codex_windows_x64_required');
  }
  const installed = path.join(
    process.env.APPDATA || '',
    'npm','node_modules','@openai','codex','node_modules',
    '@openai','codex-win32-x64','vendor',
    'x86_64-pc-windows-msvc','bin','codex.exe',
  );
  if (!process.env.APPDATA || !existsSync(installed)) {
    throw new Error('native_codex_binary_not_found');
  }
  return installed;
}

const checks = {
  callback: false, resource: false, pkce: false,
  state: false, noSecretOutput: true,
};

async function main() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nexowire-codex-oauth-'));
  const cliHome = path.join(root, 'codex-home');
  await mkdir(cliHome, {recursive: true});
  const browserShim = path.join(root, 'no-browser.cmd');
  await writeFile(browserShim, '@echo off\r\nexit /b 0\r\n', 'utf8');
  // Codex keeps its OAuth client registration/state under CODEX_HOME.
  // Preserve only OS launcher variables; never pass account credentials.
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    'SystemRoot','WINDIR','ComSpec','PATH','PATHEXT',
    'TEMP','TMP','PROCESSOR_ARCHITECTURE','USERPROFILE',
    'APPDATA','LOCALAPPDATA','HOMEDRIVE','HOMEPATH',
    'ProgramFiles','ProgramFiles(x86)','ProgramData',
  ]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  Object.assign(env, {
    CODEX_HOME: cliHome,
    BROWSER: browserShim,
    NO_COLOR: '1',
    CI: '1',
  });
  let origin = '';
  let oauth: McpOAuthService;
  let expectedResource = '';
  let lastTokenUsed = false;
  const listener = createServer(async (req, res) => {
    try {
      if (!req.url) {res.writeHead(400).end();return;}
      const url = new URL(req.url, origin);
      // Bound to loopback only. Never forward authorization material elsewhere.
      if (url.origin !== origin) {res.writeHead(400).end();return;}
      if (url.pathname === '/mcp') {
        const auth = req.headers.authorization;
        const identity = auth?.startsWith('Bearer ')
          ? await oauth.authenticateAccessToken(auth.slice(7)) : null;
        if (!identity) {
          metrics.unauthenticatedMcp++;
          res.writeHead(401, {
            'Content-Type': 'application/json',
            'WWW-Authenticate': 'Bearer resource_metadata="' +
              origin + '/.well-known/oauth-protected-resource/mcp", scope="mcp"',
            'Cache-Control': 'no-store',
          }).end('{"error":"unauthorized"}');
          return;
        }
        metrics.authenticatedMcp++;
        lastTokenUsed = identity.accountId === 'isolated-cli-test-owner';
        const payload = req.method === 'POST'
          ? await readBody(req) : '';
        const rpc = payload ? JSON.parse(payload) : {};
        res.writeHead(200, {'Content-Type': 'application/json',
          'Cache-Control': 'no-store'});
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          id: rpc.id ?? null,
          result: rpc.method === 'initialize'
            ? {protocolVersion:'2025-06-18',
                serverInfo: {name:'isolated-codex-smoke',version:'1.0'},
                capabilities:{tools:{}}}
            : rpc.method === 'tools/list' ? {tools:[]} : {},
        }));
        return;
      }
      if (url.pathname === '/.well-known/oauth-protected-resource' ||
          url.pathname === '/.well-known/oauth-protected-resource/mcp' ||
          url.pathname === '/.well-known/oauth-authorization-server') {
        metrics.discovery++;
      }
      if (url.pathname === '/oauth/register') metrics.dcr++;
      if (url.pathname === '/oauth/authorize') {
        metrics.authorize++;
        const params = url.searchParams;
        checks.resource = params.get('resource') === expectedResource;
        checks.pkce = params.get('code_challenge_method') === 'S256' &&
          /^[A-Za-z0-9_-]{43}$/.test(params.get('code_challenge') || '');
        checks.state = Boolean(params.get('state'));
      }
      if (url.pathname === '/oauth/token') metrics.codeExchange++;
      const body = req.method === 'GET' || req.method === 'HEAD'
        ? undefined : await readBody(req);
      const request = new Request(url.toString(), {
        method: req.method,
        headers: req.headers as Record<string,string>,
        ...(body !== undefined ? {body} : {}),
      });
      const handler = createMcpOAuthHttpHandler(oauth, {
        authenticateSession: async () =>
          ({accountId:'isolated-cli-test-owner', role:'user'} as never),
        loginRedirect: () => '/test-session-only',
      });
      const response = await handler(request);
      if (!response) {
        res.writeHead(404).end();
        return;
      }
      res.statusCode = response.status;
      response.headers.forEach((value, name) => {res.setHeader(name,value);});
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch {
      res.writeHead(500).end('{"error":"fixture_error"}');
    }
  });
  let child: ReturnType<typeof spawn> | undefined;
  try {
    listener.listen(0,'127.0.0.1');
    await once(listener,'listening');
    const address = listener.address();
    assert.ok(address && typeof address !== 'string');
    origin = 'http://127.0.0.1:' + address.port;
    expectedResource = origin + '/mcp';
    oauth = new McpOAuthService(new MemoryMcpOAuthStore(), {
      issuer: origin, resource: expectedResource,
    });
    phase = 'register-codex-server';
    const binary = nativeCodexExe();
    const add = await runCli(binary, [
      'mcp','add','isolated-nexowire-oauth',
      '--url',expectedResource,
      '--oauth-resource',expectedResource,
    ], env, 16_000);
    metrics.cliAdd = add.exitCode === 0;
    assert.equal(metrics.cliAdd,true);

    phase = 'codex-login';
    child = spawn(binary, [
      'mcp','login','isolated-nexowire-oauth','--scopes','mcp,offline_access',
    ], {cwd:process.cwd(),env, windowsHide:true,stdio:['ignore','pipe','pipe']});
    let output = '';
    let sentCallback = false;
    let commandExit: number | null = null;
    const appendBounded = (data:Buffer) => {
      // CLI output may include a local authorization URL. Hold at most 64 KiB
      // in memory; never print, write or reflect it on failure.
      output = (output + data.toString('utf8')).slice(-65_536);
    };
    child.stdout?.on('data',appendBounded);
    child.stderr?.on('data',appendBounded);
    child.on('exit',(code)=>{commandExit=code;});
    const deadline = Date.now()+22_000;
    while(Date.now()<deadline && commandExit === null) {
      await new Promise(resolve=>setTimeout(resolve,120));
      if(sentCallback)continue;
      // Never persist or print captured state, authorization URL, or code.
      const match = output.match(/https?:\/\/(?:127\.0\.0\.1|localhost):\d+\/oauth\/authorize\?[^\s"'<>]+/i);
      if(!match) continue;
      sentCallback=true;
      const url = new URL(match[0].replace(/\u001b\[[0-9;]*m/g,''));
      if(url.origin !== origin) continue;
      const approval = await fetch(url,{redirect:'manual'});
      if(approval.status !== 302)continue;
      const target = approval.headers.get('location');
      if(!target)continue;
      const callback = new URL(target);
      const registered = url.searchParams.get('redirect_uri');
      const expected = registered ? new URL(registered) : null;
      checks.callback =
        expected !== null &&
        callback.protocol === 'http:' &&
        expected.protocol === 'http:' &&
        ['localhost','127.0.0.1'].includes(callback.hostname) &&
        ['localhost','127.0.0.1'].includes(expected.hostname) &&
        callback.port !== '' &&
        callback.port === expected.port &&
        callback.pathname === expected.pathname &&
        callback.searchParams.get('state') === url.searchParams.get('state') &&
        Boolean(callback.searchParams.get('code')) &&
        callback.hash === '';
      if(!checks.callback)continue;
      callback.hostname='127.0.0.1';
      metrics.callbackAttempted = true;
      await fetch(callback,{redirect:'manual'});
    }
    if(commandExit===null){
      child.kill();
      await new Promise(resolve=>setTimeout(resolve,300));
    }
    metrics.cliLogin = commandExit===0;
    // Check only safe counters; no raw token or authorization content goes to logs.
    console.log(JSON.stringify({suite:'codex-cli-isolated-loopback',
      client:'real Codex CLI',authorizationServer:'synthetic-only',
      results:metrics,checks, tokenIssued:metrics.codeExchange>0,
      nativeProductionTouched:false}));
    assert.equal(metrics.cliLogin,true);
    assert.ok(metrics.discovery>0);
    assert.ok(metrics.dcr>0);
    assert.ok(metrics.authorize>0);
    assert.ok(metrics.codeExchange>0);
    assert.equal(checks.resource,true);
    assert.equal(checks.pkce,true);
    assert.equal(checks.state,true);
    assert.equal(checks.callback,true);
    assert.equal(lastTokenUsed || metrics.codeExchange>0,true);
  } finally {
    if(child && child.exitCode===null)child.kill();
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    await rm(root,{recursive:true,force:true,maxRetries:4,retryDelay:100});
  }
}

async function readBody(req: import('node:http').IncomingMessage):Promise<string>{
  let length=0;const bytes:Buffer[]=[];
  for await(const chunk of req){
    const buf=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);
    length+=buf.length;
    if(length>64_000)throw new Error('oversized fixture request');
    bytes.push(buf);
  }
  return Buffer.concat(bytes).toString('utf8');
}
async function runCli(binary:string,args:string[],env:NodeJS.ProcessEnv,timeoutMs:number){
  // Only fixtures and known static arguments. No user secrets in args.
  return new Promise<{exitCode:number|null}>((resolve,reject)=>{
    const proc=spawn(binary,args,
      {cwd:process.cwd(),env, windowsHide:true,stdio:'ignore'});
    const timer=setTimeout(()=>{proc.kill();reject(new Error('cli_timeout'));},timeoutMs);
    proc.on('error',(err)=>{clearTimeout(timer);reject(err);});
    proc.on('exit',(code)=>{clearTimeout(timer);resolve({exitCode:code});});
  });
}
main().catch(()=>{
  console.error(JSON.stringify({suite:'codex-cli-isolated-loopback', phase, counters:metrics, fail:true, secretsEmitted:false}));
  process.exitCode=1;
});
