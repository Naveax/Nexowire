import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (file) => readFile(path.join(root, file), 'utf8');

function section(markdown, heading) {
  const lines = markdown.split(/\r?\n/);
  const first = lines.findIndex((line) => line.trim() === heading);
  assert.notEqual(first, -1, `Missing section: ${heading}`);
  const level = heading.match(/^#+/)?.[0].length ?? 0;
  const tail = lines.slice(first + 1);
  const next = tail.findIndex((line) => {
    const count = line.match(/^#+(?=\s)/)?.[0].length ?? 0;
    return count > 0 && count <= level;
  });
  return (next < 0 ? tail : tail.slice(0, next)).join('\n');
}

function slug(title) {
  return title.toLowerCase()
    .replace(/\[[^\]]+\]\([^)]+\)/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/[^\p{L}\p{N}_\-\s]/gu, '')
    .trim().replace(/\s+/g, '-');
}

test('hosted OAuth, local loopback and self-host Funnel are distinct URL families', async () => {
  const doc = await read('docs/SELF_HOST.md');
  const table = section(doc, '## Choose the right address (do not guess an endpoint)');
  const rows = table.split('\n').filter((line) => line.startsWith('|'));
  assert.ok(rows.length >= 5);
  const hosted = rows.find((line) => line.includes('Normal hosted Windows/ChatGPT'));
  const local = rows.find((line) => line.includes('Self-host Hub on the same PC'));
  const funnel = rows.find((line) => line.includes('Self-host with verified Funnel'));
  assert.ok(hosted && local && funnel);
  assert.match(hosted, /advertised MCP.*resource.*Hosted OAuth/);
  assert.doesNotMatch(hosted, /127\.0\.0\.1|localhost|bearer credential/i);
  assert.match(local, /http:\/\/127\.0\.0\.1:<port>\/mcp/);
  assert.match(local, /not.*remotely accessible/i);
  assert.match(funnel, /https:\/\/<tailscale-dns-name>\/mcp/);
  assert.match(funnel, /bearer credential/i);
  assert.doesNotMatch(funnel, /Hosted OAuth/);

  const hostedIsSafe = (row) =>
    /advertised MCP.*resource.*Hosted OAuth/.test(row) &&
    !/(?:localhost|127\.0\.0\.1|control-panel URL as server)/i.test(row);
  assert.equal(hostedIsSafe(hosted), true);
  assert.equal(hostedIsSafe(hosted + ' Use http://localhost:43110/mcp as server.'), false);
  const install = await read('docs/INSTALL_WINDOWS.md');
  assert.match(install, /oauth-protected-resource/);
  assert.match(install, /Giriş panelinin adresine kendin `\/mcp` ekleyip tahmin etme/);
  assert.match(install, /panel veya `localhost` adresini kullanma/);
});

test('platform descriptions do not present unverified Linux/macOS as Windows bootstrap', async () => {
  const doc = await read('docs/SELF_HOST.md');
  const table = section(doc, '## Platform support: documented code paths, not runtime certification');
  for (const os of ['Linux', 'macOS']) {
    const row = table.split('\n').find((line) => line.startsWith(`| ${os} |`));
    assert.ok(row);
    assert.match(row, /Rejected by source guard/);
    assert.match(row, /not verified/i);
    assert.doesNotMatch(row, /supported|PASS/i);
  }
  const src = await read('src/self-host-bootstrap.ts');
  assert.match(src, /if \(process\.platform !== 'win32'\)/);

  const optional = section(doc, '### Core setup versus optional environment tools');
  assert.match(optional, /Hosted Windows end user.*No source checkout, Node\/npm, Tailscale, WSL, CUDA or Ollama prerequisite/);
  assert.match(optional, /Developer source checkout.*Node\.js 22\+/);
  assert.match(optional, /Tailscale \*\*only\*\* if requesting Funnel/);
  assert.match(optional, /Python, WSL, USB, CUDA, Ollama, Hyper-V/);
  assert.match(optional, /Missing optional tools are warnings unless the operator explicitly requires them/);
  const doctor = await read('docs/environment-doctor.md');
  assert.match(doctor, /unavailable optional tools are warnings/);
  assert.match(doctor, /physicalAcceptance.*NOT_TESTED/);
});

test('disconnection recovery is diagnostic-only and secret reveal stays separate', async () => {
  const doc = await read('docs/SELF_HOST.md');
  const recovery = section(doc, '### After a disconnection: diagnostic-first recovery');
  for (const command of [
    'nexowire node status', 'nexowire hub status',
    'nexowire agent doctor', 'nexowire tailscale status',
  ]) {
    assert.ok(recovery.includes(`${'\u0060'}${command}${'\u0060'}`), `Missing diagnostic: ${command}`);
  }
  assert.match(recovery, /Do not issue new credentials/);
  const status = section(doc, '## Diagnosis without credential reveal');
  const fencedCommands = [...status.matchAll(/^nexowire\s+([^\r\n]+)$/gm)].map((m) => m[1]);
  assert.deepEqual(fencedCommands, [
    'node status', 'hub status', 'agent doctor', 'tailscale status',
  ]);
  assert.doesNotMatch(status, /^nexowire (?:node connector|node bootstrap|onboard bootstrap|tailscale funnel)$/m);
  const cli = await read('src/cli.ts');
  for (const route of ['node', 'hub', 'agent', 'tailscale']) {
    assert.match(cli, new RegExp(`command === '${route}'`));
  }
  for (const handler of [
    'runSelfHostedNodeCommand',
    'runHubLifecycleCommand',
    'runNativeAgentEnrollmentCommand',
    'runTailscaleCommand',
  ]) assert.ok(cli.includes(handler), `Missing CLI diagnostic handler: ${handler}`);
  assert.match(cli, /action === 'doctor'/);
});

test('risk categories explicitly separate credential reveal, issuance and exposure', async () => {
  const doc = await read('docs/DEPLOYMENT_ONBOARDING.md');
  const table = section(doc, '## Which operation changes what?');
  const rows = table.split('\n').filter((line) => line.startsWith('|'));
  const row = (needle) => rows.find((line) => line.includes(needle));
  assert.match(row('node connector') ?? '', /Reveals secret/);
  assert.match(row('onboard bootstrap --force') ?? '', /Rotates\/overlaps credentials/);
  assert.match(row('tailscale funnel') ?? '', /Changes remote exposure/);
  assert.match(row('node bootstrap') ?? '', /Changes local system state/);
  const diagnostic = row('node status');
  assert.match(diagnostic ?? '', /Diagnostic/);
  assert.doesNotMatch(diagnostic ?? '', /token values|Reveals secret|Issues credentials/i);

  const consent = section(doc, '## Operator confirmation before side effects');
  for (const sideEffect of [
    'node bootstrap', 'onboard bootstrap', 'node connector',
    'tailscale funnel', 'onboard bootstrap --force',
  ]) {
    assert.ok(consent.includes(`${'\u0060'}${sideEffect}${'\u0060'}`), `Unlabeled operator action: ${sideEffect}`);
  }
  assert.match(consent, /deliberate, informed decision/);
  assert.match(consent, /NOT_RUN/);
  assert.match(consent, /do \*\*not\*\* grant admin\/CORE approval, automate elevation or authorize deployment/);
});

test('credential examples use protected-source references, not real inline values', async () => {
  const docs = (await Promise.all([
    read('docs/SELF_HOST.md'), read('docs/DEPLOYMENT_ONBOARDING.md'),
  ])).join('\n');
  for (const name of [
    'NEXOWIRE_AGENT_TOKEN_FILE',
    'NEXOWIRE_AGENT_TOKEN_DPAPI_FILE',
    'NEXOWIRE_AGENT_TOKEN_PLATFORM_NAME',
  ]) assert.ok(docs.includes(name));
  assert.doesNotMatch(docs, /\bnwx1\.(?:agent|mcp)\.[A-Za-z0-9_-]{16,}/);
  assert.doesNotMatch(docs, /\bNEXOWIRE_[A-Z_]*(?:TOKEN|SECRET|KEY)\s*=\s*[^\s<]{12,}/);

  const evidence = section(await read('docs/DEPLOYMENT_ONBOARDING.md'), '## Reporting incomplete evidence');
  assert.match(evidence, /Source-only PASS.*not proof of a deployed device/);
  assert.match(evidence, /NOT_RUN.*not exercised/);
  assert.match(evidence, /UNKNOWN.*inconclusive/);
  assert.match(evidence, /action_required.*not a test PASS/);
  assert.match(evidence, /clean-user installation, pairing and remote MCP checks still require a real Windows acceptance run/);
});

test('cross-guide links and target heading anchors are valid offline', async () => {
  const files = [
    'docs/SELF_HOST.md',
    'docs/DEPLOYMENT_ONBOARDING.md',
    'docs/INSTALL_WINDOWS.md',
  ];
  const contents = new Map(await Promise.all(files.map(async (name) => [name, await read(name)])));
  assert.match(contents.get(files[0]), /\(DEPLOYMENT_ONBOARDING\.md\)/);
  assert.match(contents.get(files[1]), /\(SELF_HOST\.md\)/);
  assert.match(contents.get(files[0]), /\(INSTALL_WINDOWS\.md/);
  assert.match(contents.get(files[1]), /\(INSTALL_WINDOWS\.md/);

  let checked = 0;
  for (const name of files.slice(0, 2)) {
    const content = contents.get(name);
    for (const match of content.matchAll(/\[[^\]]+\]\(([^)]+#[^)]+)\)/g)) {
      const [relative, fragment] = match[1].split('#');
      const target = path.posix.normalize(path.posix.join('docs', relative));
      const targetContent = contents.get(target);
      assert.ok(targetContent, `Unknown local guide anchor target: ${match[1]}`);
      const headings = targetContent.split(/\r?\n/).filter((line) => /^#+\s/.test(line))
        .map((line) => slug(line.replace(/^#+\s+/, '')));
      assert.ok(headings.includes(decodeURIComponent(fragment)), `Broken anchor: ${name} -> ${match[1]}`);
      checked++;
    }
  }
  assert.ok(checked >= 3);
});
