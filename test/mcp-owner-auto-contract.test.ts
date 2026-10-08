import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const worker=readFileSync('cloudflare/worker.js','utf8');
const hub=readFileSync('src/mcp/http.ts','utf8');

test('internal OAuth MCP authorization stays service-only and derives AUTO and folders from owner storage',()=>{
  assert.match(worker,/url\.pathname ===\s*'\/api\/v1\/internal\/mcp\/authenticate'/);
  assert.match(worker,/caller\.role !== 'service'/);
  assert.match(worker,/oauth\.authenticateAccessToken/);
  assert.match(worker,/store\.getAccount\(\s*tokenIdentity\.accountId/);
  assert.match(worker,/store\.getAutoDeviceSelection\(account\.id\)/);
  assert.match(worker,/store\.listDeviceFolders\(account\.id\)/);
  assert.match(worker,/store\.listDeviceFolderAssignments\(account\.id\)/);
  assert.match(worker,/ownerDevices: devices\.map/);
  assert.match(worker,/ownerFolders: folders\.map/);
});

test('Hub reauthenticates each MCP POST and cannot extend AUTO permissions across requests',()=>{
  assert.match(hub,/app\.use\('\/mcp'/);
  assert.match(hub,/resolveMcpAuthorization\(/);
  assert.match(hub,/app\.post\('\/mcp'/);
  assert.match(hub,/createNexowireMcpServer\(/);
  assert.doesNotMatch(hub,/autoSelectDevices\s*=\s*true/);
});
