import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {extname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {hubRuntimeIdentity,loadedMcpRouterSha256} from '../src/mcp/http.js';
import {NEXOWIRE_VERSION} from '../src/version.js';

test('Hub runtime identity fingerprints actual loaded router bytes, not a stale release label',()=>{
  const suffix=extname(fileURLToPath(import.meta.url));
  const router=new URL('../src/mcp/create-server'+suffix,import.meta.url);
  const expected=createHash('sha256').update(readFileSync(router)).digest('hex');
  assert.equal(loadedMcpRouterSha256(),expected);
  assert.match(expected,/^[a-f0-9]{64}$/);
});

test('Hub runtime metadata describes compiled owner routing without declaring real OAuth acceptance',()=>{
  const plain=hubRuntimeIdentity(false);
  assert.deepEqual(plain,{
    packageVersion:NEXOWIRE_VERSION,
    mcpRouterSha256:loadedMcpRouterSha256(),
    ownerAutoRoutingContract:'owner-auto-v1',
    ownerOauthConfigured:false,
  });
  const hosted=hubRuntimeIdentity(true);
  assert.equal(hosted.ownerOauthConfigured,true);
  assert.equal(hosted.ownerAutoRoutingContract,'owner-auto-v1');
  assert.equal(hosted.mcpRouterSha256,plain.mcpRouterSha256);
  const output=JSON.stringify(hosted);
  assert.doesNotMatch(output,/token|credential|secret|authorized|ready|approved/i);
});
