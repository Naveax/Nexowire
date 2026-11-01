import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Standalone and offline: no MCP client, credentials, Hub, Agent or dependencies.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (file) => readFileSync(resolve(root, file), 'utf8');
const docs = read('docs/MCP_SURFACE.md');
const architecture = read('docs/ARCHITECTURE.md');

function between(source, start, end) {
  assert.equal(source.split(start).length, 2, `Unique marker: ${start}`);
  const after = source.split(start)[1];
  assert.equal(after.split(end).length, 2, `Unique marker: ${end}`);
  return after.split(end)[0];
}

function sourceSnapshot() {
  const stable = [...between(
    read('src/mcp/surface.ts'),
    'export const MCP_V1_STABLE_TOOLS = [',
    '] as const',
  ).matchAll(/"([a-z0-9_]+)"/g)].map((match) => match[1]);
  const capabilityEntries = [...between(
    read('src/mcp/tool-capabilities.ts'),
    'export const MCP_TOOL_CAPABILITY_REQUIREMENTS = {',
    '} as const',
  ).matchAll(/^\s*([a-z0-9_]+): '([a-z0-9.]+)',?\s*$/gm)];
  const capabilities = new Map(capabilityEntries.map((match) => [match[1], match[2]]));
  const readOnly = new Set([...between(
    read('src/protocol/capabilities.ts'),
    'export const READ_ONLY_CAPABILITIES = new Set<string>([',
    ']);',
  ).matchAll(/'([a-z0-9.]+)'/g)].map((match) => match[1]));
  assert.ok(stable.length > 0);
  assert.ok(capabilities.size > 0);
  assert.ok(readOnly.size > 0);
  return { stable, capabilities, readOnly };
}

function documentedReadOnly() {
  const section = between(
    docs, '<!-- k08:read-only-v1-begin -->', '<!-- k08:read-only-v1-end -->',
  );
  const rows = [...section.matchAll(/^\| `([a-z0-9_]+)` \| `([a-z0-9.]+)` \|$/gm)]
    .map((match) => [match[1], match[2]]);
  assert.ok(rows.length > 0);
  return rows;
}

function assertExactReadOnlyTable(rows, snapshot) {
  const expected = snapshot.stable
    .filter((name) => {
      const capability = snapshot.capabilities.get(name);
      return capability !== undefined && snapshot.readOnly.has(capability);
    })
    .map((name) => [name, snapshot.capabilities.get(name)]);
  assert.deepEqual(rows, expected, 'Document only classified read-only v1 Agent tools, in source order');
}

test('MCP doc read-only v1 tool-to-capability matrix follows the three source contracts', () => {
  assertExactReadOnlyTable(documentedReadOnly(), sourceSnapshot());
});

test('mutation-capable and Hub-local tools cannot accidentally become Agent read-only rows', () => {
  const snapshot = sourceSnapshot();
  const documented = new Set(documentedReadOnly().map(([name]) => name));
  for (const name of ['file_write', 'shell_exec', 'windows_window_focus', 'browser_session_start']) {
    assert.ok(snapshot.stable.includes(name), `${name} remains a stable v1 tool`);
    const capability = snapshot.capabilities.get(name);
    assert.ok(capability, `${name} has a capability mapping`);
    assert.equal(snapshot.readOnly.has(capability), false, `${name} is not an Agent read-only capability`);
    assert.equal(documented.has(name), false, `${name} excluded from the read-only matrix`);
  }
  assert.equal(snapshot.capabilities.has('nexowire_surface_info'), false, 'Hub-local is not an Agent capability');
  assert.equal(snapshot.capabilities.has('device_alias_set'), false, 'Hub mutation is not an Agent capability');
  assert.equal(documented.has('nexowire_surface_info'), false);
  assert.equal(documented.has('device_alias_set'), false);

  assert.throws(() => assertExactReadOnlyTable(
    [...documentedReadOnly(), ['file_write', 'files.write']], snapshot,
  ), /Document only classified/);
});

function headingSlug(text) {
  return text.toLowerCase()
    .replace(/`/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-');
}

function checkLocalLinks(source, from) {
  const headings = [...source.matchAll(/^#{1,6} (.+)$/gm)]
    .map((match) => headingSlug(match[1]));
  for (const [, target] of source.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
    if (/^(?:https?:|mailto:)/.test(target)) continue;
    const [relative, fragment] = target.split('#');
    const file = relative ? resolve(root, 'docs', relative) : resolve(root, from);
    assert.ok(existsSync(file), `${from}: missing local target ${target}`);
    if (fragment) {
      const targetHeadings = relative
        ? [...readFileSync(file, 'utf8').matchAll(/^#{1,6} (.+)$/gm)]
          .map((match) => headingSlug(match[1]))
        : headings;
      assert.ok(targetHeadings.includes(decodeURIComponent(fragment)),
        `${from}: missing heading for ${target}`);
    }
  }
}

test('both K08 documents use existing local files and heading anchors', () => {
  checkLocalLinks(docs, 'docs/MCP_SURFACE.md');
  checkLocalLinks(architecture, 'docs/ARCHITECTURE.md');
});

test('frozen v1 input/output JSON tools exactly match source and documented names', () => {
  const { stable } = sourceSnapshot();
  const inputs = JSON.parse(read('src/mcp/v1-input-contract.json'));
  const output = JSON.parse(read('src/mcp/v1-output-contract.json'));
  assert.equal(output.version, 1);
  assert.deepEqual(Object.keys(inputs), stable);
  assert.deepEqual(Object.keys(output.contracts), stable);
  for (const name of stable) {
    assert.equal(output.contracts[name].tool, name, `Output contract tool: ${name}`);
    assert.equal(output.contracts[name].surfaceVersion, 1, `v1 contract: ${name}`);
  }
  for (const name of ['machine_snapshot', 'file_write', 'nexowire_surface_info', 'device_alias_set']) {
    assert.ok(docs.includes('`' + name + '`'), `Documented example missing from JSON contracts: ${name}`);
  }
  assert.deepEqual(inputs.audit_query.properties.status.enum, ['started', 'succeeded', 'failed']);
  assert.equal(output.contracts.machine_snapshot.profile, 'native-execution-v1');
  assert.equal(output.contracts.file_write.profile, 'native-execution-v1');
  assert.equal(output.contracts.nexowire_surface_info.profile, 'hub-object-v1');
  assert.equal(output.contracts.device_alias_set.profile, 'hub-object-v1');
  const nativeFields = output.contracts.machine_snapshot.fields;
  assert.ok(nativeFields.some((field) => field.path === 'ok' && field.type === 'boolean'));
  assert.ok(nativeFields.some((field) => field.path === 'error' && !field.requiredOnSuccess));
  assert.ok(nativeFields.some((field) => field.path === 'idempotency' && !field.requiredOnSuccess));
  assert.ok(output.contracts.nexowire_surface_info.fields.some((field) =>
    field.path === 'mcpSurfaceVersion' && field.requiredOnSuccess));

  const mismatched = { ...inputs };
  delete mismatched.machine_snapshot;
  assert.notDeepEqual(Object.keys(mismatched), stable, 'Missing frozen JSON tool is detectable');
});
