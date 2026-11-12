import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request, type Server } from 'node:http';
import type { Request, Response, NextFunction } from 'express';
import {
  createNexowireMcpExpressApp,
  NEXOWIRE_MCP_JSON_BODY_LIMIT_BYTES,
} from '../src/mcp/http-app.js';
import { resolveMcpAuthorization, type BearerAuthorization } from '../src/security/auth.js';
import { deniedMcpToolNames } from '../src/security/tool-authorization.js';
import { classifyMcpAuthFailure } from '../src/mcp/http.js';
import { ControlPlaneMcpClient } from '../src/hub/control-plane-mcp-auth.js';

/**
 * #598 child acceptance. The real parser and auth/authorization primitives
 * are wired into an isolated HTTP server in production middleware order.
 * This is NOT the full runHttpServer / actual hosted Worker, nor staging login.
 * All credentials are invented in-process; do not output tokens or bodies.
 */
const token = (suffix: string) => 'Bearer nwx_mcp_fixture_' + suffix;
const secretSentinel = 'not-for-logs-fixture-secret';
const resourceMetadata = 'https://mcp.example.test/.well-known/oauth-protected-resource/mcp';
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const largePayload = JSON.stringify({payload: 'p'.repeat(221 * 1024)});

type Metrics = {
  verifierCalls: number;
  dispatches: number;
  authorized: number;
};

function safeAuthReply() {
  return {
    authenticated: true,
    accountId: 'fixture-owner',
    role: 'user',
    scopes: ['mcp'],
    allowedDeviceIds: ['owned-device'],
    deviceAccessModes: {
      'owned-device': 'safe',
      'foreign-device': 'full',
    },
    ownerDevices: [
      {id: 'owned-device', name: 'Own Device', folderId: null},
      {id: 'foreign-device', name: 'Other Owner', folderId: null},
    ],
  };
}

async function isolatedHarness() {
  const metrics: Metrics = {verifierCalls: 0, dispatches: 0, authorized: 0};
  const client = new ControlPlaneMcpClient({
    controlPlaneUrl: 'https://auth.example.test',
    serviceToken: 'isolated-fixture-service-token',
    fetchImpl: async (_url, init) => {
      metrics.verifierCalls += 1;
      const body = JSON.parse(String(init?.body)) as {accessToken: string};
      if (body.accessToken.endsWith('_network_error')) {
        throw new Error(secretSentinel);
      }
      if (body.accessToken.endsWith('_upstream_503')) {
        return new Response(secretSentinel, {status: 503});
      }
      if (body.accessToken.endsWith('_upstream_401')) {
        return new Response(secretSentinel, {status: 401});
      }
      if (body.accessToken.endsWith('_bad_json')) {
        return new Response(secretSentinel, {
          status: 200, headers: {'content-type': 'application/json'},
        });
      }
      if (body.accessToken.endsWith('_nonobject_list')) {
        return Response.json([]);
      }
      if (body.accessToken.endsWith('_nonobject_null')) {
        return Response.json(null);
      }
      if (body.accessToken.endsWith('_invalid_auth_flag')) {
        return Response.json({authenticated: 'false'});
      }
      if (body.accessToken.endsWith('_wrong_scope')) {
        return Response.json({...safeAuthReply(), scopes: ['offline_access']});
      }
      if (body.accessToken.endsWith('_wrong_audience')) {
        return Response.json({authenticated:false});
      }
      if (body.accessToken.endsWith('_valid')) {
        return Response.json(safeAuthReply());
      }
      return Response.json({authenticated:false});
    },
  });
  const app = createNexowireMcpExpressApp({
    host: '127.0.0.1',
    allowedHosts: ['127.0.0.1', 'localhost'],
  });

  // Match the ordering in src/mcp/http.ts: parser -> auth -> tool policy.
  app.use('/mcp', (req: Request, res: Response, next: NextFunction) => {
    void resolveMcpAuthorization(req.headers.authorization, [], undefined,
      undefined, header => client.authenticate(header))
      .then(authorization => {
        if (!authorization) {
          res.setHeader('WWW-Authenticate',
            'Bearer resource_metadata="' + resourceMetadata + '", scope="mcp"');
          res.setHeader('Cache-Control', 'no-store');
          res.status(401).json({
            error: 'unauthorized', code: 'MCP_AUTH_REQUIRED', layer: 'token',
          });
          return;
        }
        res.locals.authorization = authorization;
        metrics.authorized += 1;
        next();
      })
      .catch(error => {
        res.setHeader('Cache-Control', 'no-store');
        if (classifyMcpAuthFailure(error) === 'token') {
          res.status(401).json({
            error: 'unauthorized', code: 'MCP_AUTH_REQUIRED', layer: 'token',
          });
          return;
        }
        res.setHeader('Retry-After', '5');
        res.status(503).json({
          error: 'service_unavailable',
          code: 'MCP_AUTH_VERIFIER_UNAVAILABLE',
          layer: 'verification',
        });
      });
  });
  app.post('/mcp', (req: Request, res: Response) => {
    const authorization = res.locals.authorization as BearerAuthorization;
    const denied = deniedMcpToolNames(req.body, authorization);
    if (denied.length) {
      res.status(403).json({code:'MCP_TOOL_NOT_AUTHORIZED'});
      return;
    }
    metrics.dispatches += 1;
    res.json({
      ok: true,
      kind: authorization.kind,
      accountId: authorization.kind === 'control-plane'
        ? authorization.accountId : null,
      allowedDeviceIds: authorization.kind === 'control-plane'
        ? authorization.allowedDeviceIds : [],
      ownerDevices: authorization.kind === 'control-plane'
        ? authorization.ownerDevices?.map(value => value.id) : [],
    });
  });
  const server: Server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const url = 'http://127.0.0.1:' + address.port + '/mcp';
  return {
    metrics,
    url,
    port: address.port,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close(error => error ? reject(error) : resolve()));
    },
  };
}

async function post(url: string, body: string, authorization?: string) {
  return fetch(url, {
    method:'POST', redirect:'manual', signal: AbortSignal.timeout(12_000),
    headers:{
      'content-type':'application/json',
      ...(authorization ? {authorization} : {}),
    },
    body,
  });
}

test('#598 pre-auth parser: a large unauthenticated JSON body cannot reach tools or verifier', async () => {
  const h = await isolatedHarness();
  try {
    const response = await post(h.url, largePayload);
    assert.equal(response.status, 401);
    assert.equal((await response.json() as {code:string}).code, 'MCP_AUTH_REQUIRED');
    const challenge = response.headers.get('www-authenticate') ?? '';
    assert.equal(challenge.includes('resource_metadata='),true);
    assert.equal(challenge.includes('scope="mcp"'),true);
    assert.equal(h.metrics.dispatches, 0);
    assert.equal(h.metrics.verifierCalls, 0);

    // A hostile Host cannot reach the verifier, even if it claims a bearer.
    // Use raw Node HTTP to avoid fetch rewriting the Host header.
    const hostileHost = await new Promise<number>((resolve, reject) => {
      const client = request({
        hostname:'127.0.0.1',port:h.port,path:'/mcp',method:'POST',
        headers:{
          Host:'attacker.invalid',
          'Content-Type':'application/json',
          'Content-Length':'2',
          Authorization:token('valid'),
        },
      }, reply => {
        reply.resume();
        reply.once('end',()=>resolve(reply.statusCode ?? 0));
      });
      client.on('error',reject);
      client.end('{}');
    });
    assert.equal(hostileHost,403);
    assert.equal(h.metrics.verifierCalls,0);
    assert.equal(h.metrics.dispatches,0);

    const oversizedBody = JSON.stringify({
      payload: 'q'.repeat(NEXOWIRE_MCP_JSON_BODY_LIMIT_BYTES),
    });
    const oversized = await post(h.url, oversizedBody, token('valid'));
    assert.equal(oversized.status, 413);
    assert.equal(h.metrics.dispatches,0);
    assert.equal(h.metrics.verifierCalls,0,
      'oversize input must be stopped at parser before bearer verification');

    const malformed = await post(h.url, '{"bad":',token('valid'));
    assert.equal(malformed.status,400);
    assert.equal(h.metrics.verifierCalls,0);
    assert.equal(h.metrics.dispatches,0);
  } finally {
    await h.close();
  }
});

test('#598 genuine auth primitive: valid owner scope/device isolates dispatch; invalid scope/audience fail closed', async () => {
  const h = await isolatedHarness();
  try {
    const incorrectScope = await post(h.url, largePayload, token('wrong_scope'));
    assert.equal(incorrectScope.status,401);
    const wrongAudience = await post(h.url, '{}',token('wrong_audience'));
    assert.equal(wrongAudience.status,401);
    assert.equal(h.metrics.dispatches,0);

    const allowed = await post(h.url,largePayload,token('valid'));
    assert.equal(allowed.status,200);
    const result = await allowed.json() as {
      ok:boolean;kind:string;accountId:string;
      allowedDeviceIds:string[]; ownerDevices:string[];
    };
    assert.equal(result.ok,true);
    assert.equal(result.kind,'control-plane');
    assert.equal(result.accountId,'fixture-owner');
    assert.deepEqual(result.allowedDeviceIds,['owned-device']);
    assert.deepEqual(result.ownerDevices,['owned-device'],
      'ownerDevices from upstream must be restricted to verified device IDs');

    const adminTool = JSON.stringify({
      jsonrpc:'2.0',id:1,method:'tools/call',
      params:{name:'policy_profile_delete',arguments:{}},
    });
    const forbidden = await post(h.url,adminTool,token('valid'));
    assert.equal(forbidden.status,403);
    assert.equal(h.metrics.dispatches,1,
      'admin-only operations must not be dispatched for user role');
  } finally {
    await h.close();
  }
});

test('#598 503 verifier failure is not a 401 user-token rejection, and secrets are never echoed', async () => {
  const h = await isolatedHarness();
  try {
    for(const failure of [
      'network_error','upstream_503','upstream_401','bad_json',
      'nonobject_list','nonobject_null','invalid_auth_flag',
    ]){
      const response = await post(h.url,'{}',token(failure));
      assert.equal(response.status,503);
      assert.equal(response.headers.get('www-authenticate')===null,true);
      assert.equal(response.headers.get('retry-after'),'5');
      const text = await response.text();
      assert.equal(text.includes(secretSentinel),false);
      assert.equal(text.includes('nwx_mcp_'),false);
      assert.equal(JSON.parse(text).code,'MCP_AUTH_VERIFIER_UNAVAILABLE');
    }
    const denied = await post(h.url,'{}',token('revoked'));
    assert.equal(denied.status,401);
    assert.equal((await denied.json() as {code:string}).code,'MCP_AUTH_REQUIRED');
    assert.equal(h.metrics.dispatches,0);
  } finally {
    await h.close();
  }
});

test('#598 unauthenticated slow-upload saturation: large calls get parser 503 before OAuth, small calls remain 401', async () => {
  const h = await isolatedHarness();
  const unfinished: Array<ReturnType<typeof request>> = [];
  try {
    for(let i=0;i<4;i+=1){
      const client = request({
        hostname:'127.0.0.1',port:h.port,path:'/mcp',method:'POST',
        headers:{'Content-Type':'application/json','Transfer-Encoding':'chunked'},
      });
      client.on('error',()=>{});
      unfinished.push(client);
      client.write('{"payload":"incomplete');
    }
    await sleep(120);
    const ordinary = await post(h.url,'{}');
    assert.equal(ordinary.status,401,'small unauthenticated body reaches auth');
    const overloaded = await post(h.url,largePayload);
    assert.equal(overloaded.status,503,
      'large unauthenticated upload can reserve parser slots before auth: known DoS gate');
    assert.equal((await overloaded.json() as {code:string}).code,'MCP_JSON_PARSER_BUSY');
    assert.equal(h.metrics.verifierCalls,0);
    assert.equal(h.metrics.dispatches,0);
  } finally {
    for(const c of unfinished)c.destroy();
    await sleep(70);
    const recovered = await post(h.url,largePayload);
    assert.equal(recovered.status,401);
    await h.close();
  }
});