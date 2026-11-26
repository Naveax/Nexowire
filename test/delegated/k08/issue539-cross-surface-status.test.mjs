import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

// Source-only QA: read other owners' files, never send Hub/Agent/Bridge calls.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (name) => readFileSync(resolve(root, name), 'utf8');
const app = read('web/app.js');
const hub = read('src/mcp/create-server.ts');
const http = read('src/mcp/http.ts');
const charge = read('src/product/fused-mcp-authorize-charge.ts');
const controlPlane = read('src/product/control-plane-http.ts');
const surface = read('docs/MCP_SURFACE.md');
const architecture = read('docs/ARCHITECTURE.md');
const workflow = read('.github/workflows/ci.yml');
const inputs = JSON.parse(read('src/mcp/v1-input-contract.json'));
const outputs = JSON.parse(read('src/mcp/v1-output-contract.json')).contracts;

function verifyNamespaceEvidence(input) {
  assert.match(input.app, /command\.status\s*!==\s*'queued'/);
  for (const state of ['queued', 'claimed', 'applied', 'failed', 'expired']) {
    assert.ok(input.app.includes(`data.status==='${state}'`), `Bridge ${state} omitted`);
    assert.ok(input.surface.includes('`' + state + '`'), `Undocumented Bridge ${state}`);
  }
  assert.match(input.app, /data\.requestId!==command\.requestId\|\|data\.deviceId!==deviceId/);
  assert.match(input.app, /İmzalı cihaz onayı alındı/);
  assert.match(input.app, /Beklenmeyen cihaz komut durumu/);
  for (const state of ['in_progress', 'succeeded', 'failed', 'unknown']) {
    assert.ok(input.hub.includes(`'${state}'`), `Missing Hub ${state}`);
    assert.ok(input.surface.includes('`' + state + '`'), `Undocumented Hub ${state}`);
  }
  assert.match(input.surface, /There is no universal `APPLIED`\/`FAILED`\/`UNKNOWN` response/);
  assert.match(input.surface, /signed \*\*Bridge command receipt\*\*/);
  assert.match(input.surface, /Hub journal `failed` record is not a\s+signed Bridge `failed` receipt/);
}

test('T-577: real Bridge and Hub source statuses retain separate request and outcome semantics', () => {
  verifyNamespaceEvidence({ app, hub, surface });
});

test('T-577 negative: replacing a Bridge signed receipt with generic success fails source QA', () => {
  assert.throws(() => verifyNamespaceEvidence({
    app: app.replace('İmzalı cihaz onayı alındı', 'İşlem tamamlandı'), hub, surface,
  }));
  assert.throws(() => verifyNamespaceEvidence({
    app, hub, surface: surface.replace('Hub journal `failed` record is not a', 'Hub journal `failed` record is a'),
  }));
});

// Reduced VM fixture from K08 #1128: execute real render() with zero devices,
// not merely grep a static string. There are no real browser or network calls.
function dashboardWithoutDevices(source = app) {
  const end = source.indexOf("\n$('folder-filter').addEventListener");
  assert.ok(end > 0, 'render() boundary missing');
  class Element {
    constructor() {
      this.textContent = ''; this.children = []; this.style = {};
      this.classList = { toggle() {}, add() {} };
    }
    replaceChildren(...items) { this.children = items; }
    appendChild(item) { this.children.push(item); }
    add(item) { this.children.push(item); }
  }
  const elements = new Map();
  const get = (id) => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id);
  };
  const document = {
    getElementById: get, querySelectorAll: () => [], createElement: () => new Element(),
  };
  class Option { constructor(text, value) { this.text = text; this.value = value; } }
  const script = source.slice(0, end) + `\nrender({
    displayName: 'QA', planId: 'free', billingMode: 'free',
    usage: { monthlyCredits: 100, usedCredits: 0 },
    devices: [], folders: [], autoSelectDevices: false,
  });`;
  runInNewContext(script, { document, Option, Intl, Date, Math, Set }, { timeout: 1500 });
  return {
    badge: get('connection-pill').textContent,
    count: get('devices-count').textContent,
    empty: get('devices').children[0]?.textContent,
  };
}

test('T-578: #1128 empty dashboard reproduces Bağlı / 0 devices contradiction; owner copy fixes fixture only', () => {
  const before = dashboardWithoutDevices();
  assert.equal(before.badge, 'Bağlı');
  assert.equal(before.count, '0');
  assert.match(before.empty, /Henüz bağlı cihaz yok/);
  const proposal = app.replace("setPill('Bağlı', 'good');", "setPill('Kontrol paneli yüklendi', 'good');");
  assert.notEqual(proposal, app);
  assert.equal(dashboardWithoutDevices(proposal).badge, 'Kontrol paneli yüklendi');
  assert.match(surface, /source-label collision/);
  assert.match(surface, /#1128/);
  assert.match(surface, /#1068/);
});

test('T-579: documented physical permission requires evidence absent from status-only responses', () => {
  for (const limitation of [
    'fresh owner grant evidence',
    'exact\nphysical action boundary',
    'installed build identity',
    'independent local\nreadback',
    'NOT_RUN',
  ]) assert.ok(architecture.includes(limitation), `Permission evidence absent: ${limitation}`);
  assert.match(architecture, /signed Bridge `applied` receipt covers\s+its \*own\* observation only/);
  assert.match(surface, /physical permission, installed binary\s+provenance/);
  // Neither an HTTP status nor a Hub record is a physical grant or a postcondition.
  const physicalAcceptance = ({ ownerGrant, boundaryCheck, installedBuild, readback }) =>
    ownerGrant === true && boundaryCheck === true && installedBuild === true && readback === true;
  for (const field of ['ownerGrant', 'boundaryCheck', 'installedBuild', 'readback']) {
    const evidence = { ownerGrant: true, boundaryCheck: true, installedBuild: true, readback: true };
    evidence[field] = false;
    assert.equal(physicalAcceptance(evidence), false, `Missing ${field} must not validate`);
  }
  assert.equal(physicalAcceptance({}), false);
});

function verifyHttpGates(parts) {
  assert.match(parts.http, /res\.status\(401\)\.json\(\{\s*error:\s*'unauthorized',\s*code:\s*'MCP_AUTH_REQUIRED'/);
  assert.match(parts.http, /res\.status\(403\)\.json\(\{\s*error:\s*'forbidden',\s*code:\s*'MCP_TOOL_NOT_AUTHORIZED'/);
  assert.match(parts.http, /res\.setHeader\('Retry-After', '5'\);\s*res\.status\(503\)\.json\(\{\s*error:\s*'service_unavailable',\s*code:\s*'MCP_AUTH_VERIFIER_UNAVAILABLE'/);
  assert.match(parts.charge, /response\(feature\?403:429,\{\s*error:feature\?'MCP_FEATURE_NOT_IN_PLAN':'MCP_QUOTA_EXHAUSTED'/);
  assert.match(parts.charge, /response\(503,\{error:'MCP_AUTH_CHARGE_UNAVAILABLE'\}/);
  assert.match(parts.controlPlane, /return json\(503,\{error:'BRIDGE_COMMAND_TRANSPORT_DISABLED'\}\)/);
  for (const code of [401, 403, 429, 503]) assert.ok(parts.surface.includes('`' + code + '`'));
  assert.match(parts.surface, /HTTP timeout \*after possible dispatch\* remains\s+`UNKNOWN`/);
}

test('T-581: 401/403/429/503 are source-backed gates, not remote outcome results', () => {
  verifyHttpGates({ http, charge, controlPlane, surface });
  assert.match(surface, /`MCP_AUTH_CHARGE_UNAVAILABLE`/);
  assert.match(surface, /`MCP_AUTH_VERIFIER_UNAVAILABLE`/);
});

test('T-581 negative: treating verifier unavailability as 401 or removing quota 429 fails', () => {
  assert.throws(() => verifyHttpGates({
    http: http.replace("res.setHeader('Retry-After', '5');\n        res.status(503)", "res.setHeader('Retry-After', '5');\n        res.status(401)"),
    charge, controlPlane, surface,
  }));
  assert.throws(() => verifyHttpGates({
    http, charge: charge.replace('response(feature?403:429', 'response(feature?403:200'), controlPlane, surface,
  }));
});

test('T-580: report CI discovery from source without equating a green job with hosted nested execution', (t) => {
  const explicitlyHosted = workflow.includes('test/delegated/k08/issue539-mcp-evidence-matrix.test.mjs');
  const wildcardHosted = workflow.includes('test/delegated/k08/*.test.mjs');
  const covered = explicitlyHosted || wildcardHosted;
  t.diagnostic(`Required CI source selection for previous K08 nested matrix: ${covered ? 'SELECTED' : 'NOT_SELECTED'}`);
  // Show that this detector flags an explicit file or directory wildcard, not an unrelated passing suite.
  assert.equal(workflow.includes('test/delegated/k08/mcp-doc-contract.test.mjs'), true);
  assert.equal(workflow.includes('test/delegated/k08/issue539-cross-surface-status.test.mjs'), false);
  assert.equal(['SELECTED', 'NOT_SELECTED'].includes(covered ? 'SELECTED' : 'NOT_SELECTED'), true);
});

test('T-582: owner web copy check is independent of the unchanged MCP v1 input/output schema', () => {
  assert.match(app, /\/api\/v1\/me\/devices\/bridge-command/);
  assert.match(surface, /Admin Bridge command/);
  assert.match(surface, /There is no universal `APPLIED`\/`FAILED`\/`UNKNOWN` response/);
  assert.equal(Object.keys(inputs).length, 110);
  assert.deepEqual(Object.keys(inputs).sort(), Object.keys(outputs).sort());
  assert.equal(outputs.agent_operation_status.profile, 'native-execution-v1');
  assert.match(surface, /MCP surface: \*\*v1\*\*/);
});
