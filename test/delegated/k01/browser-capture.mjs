#!/usr/bin/env node
// Optional real Chromium visual smoke. Static fixture HTTP only: no Hub/Agent/OAuth.
// Usage: node test/delegated/k01/browser-capture.mjs [output-directory]
import { createServer } from 'node:http';
import { readFile, mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

const chrome = process.env.K01_CHROMIUM ?? 'chromium';
const files = new Map(await Promise.all([
  ['connect.html', 'text/html; charset=utf-8'],
  ['connect.js', 'text/javascript; charset=utf-8'],
  ['styles.css', 'text/css; charset=utf-8'],
].map(async ([name, type]) => [name, { type, data: await readFile(`web/${name}`) }])));

function withFixture(html, scenario) {
  const observer = `<script>
    setInterval(() => {
      const html = document.documentElement;
      html.dataset.fixtureState = document.getElementById('connect-pill')?.textContent || '';
      html.dataset.fixtureWidth = String(innerWidth);
      html.dataset.fixtureOverflow = String(html.scrollWidth > innerWidth);
      html.dataset.fixtureFocus = document.activeElement?.id || document.activeElement?.tagName || '';
    }, 50);
    ${scenario === 'error' ? `window.addEventListener('load', () => setTimeout(() => {
      document.getElementById('approve').click();
    }, 300));` : ''}
  </script>`;
  return html.replace('</body>', `${observer}</body>`);
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1');
  const scenario = url.searchParams.get('fixture') ?? 'install';
  if (url.pathname === '/.well-known/oauth-protected-resource') {
    const origin = `http://127.0.0.1:${server.address().port}`;
    response.writeHead(scenario === 'unavailable' ? 503 : 200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ resource: 'https://mcp.fixture.invalid/mcp', authorization_servers: [origin] }));
    return;
  }
  if (url.pathname === '/api/v1/me/dashboard') {
    response.writeHead(scenario === 'account-error' ? 503 : 200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(scenario === 'account-error' ? { error: 'fixture' } : {}));
    return;
  }
  if (url.pathname === '/api/v1/pairing' && request.method === 'POST') {
    response.writeHead(503, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'fixture upstream unavailable' }));
    return;
  }
  const name = url.pathname.slice(1);
  const file = files.get(name);
  if (!file) {
    response.writeHead(404); response.end('fixture missing'); return;
  }
  response.writeHead(200, { 'content-type': file.type, 'cache-control': 'no-store' });
  response.end(name === 'connect.html' ? withFixture(file.data.toString('utf8'), scenario) : file.data);
});

function runChrome(url, imagePath, size) {
  return new Promise((done, fail) => {
    let out = '', err = '';
    const chromeProcess = spawn(chrome, [
      '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
      '--disable-background-networking', '--no-first-run', '--hide-scrollbars',
      '--force-device-scale-factor=1', `--window-size=${size[0]},${size[1]}`,
      '--virtual-time-budget=3000', `--screenshot=${imagePath}`, '--dump-dom', url,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => chromeProcess.kill('SIGKILL'), 15_000);
    chromeProcess.stdout.on('data', (chunk) => { out += chunk; });
    chromeProcess.stderr.on('data', (chunk) => { err += chunk; });
    chromeProcess.on('error', (error) => { clearTimeout(timer); fail(error); });
    chromeProcess.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) fail(new Error(`Chromium exited ${code}: ${err.slice(-400)}`));
      else done(out);
    });
  });
}

await new Promise((done) => server.listen(0, '127.0.0.1', done));
const output = process.argv[2]
  ? resolve(process.argv[2])
  : await mkdtemp(join(tmpdir(), 'nexowire-k01-browser-'));
await mkdir(output, { recursive: true });
const cases = [
  ['install-375', 'install', 375, 812, 'Kurulum'],
  ['ready-375', 'ready', 375, 812, 'Hazır'],
  ['error-375', 'error', 375, 812, 'Hata'],
  ['ready-768', 'ready', 768, 900, 'Hazır'],
  ['error-768', 'error', 768, 900, 'Hata'],
  ['install-desktop', 'install', 1366, 900, 'Kurulum'],
];
const report = { browser: chrome, source: 'current working-tree web/connect.js', output, cases: [] };
try {
  for (const [name, scenario, width, height, expectedState] of cases) {
    const url = new URL(`http://127.0.0.1:${server.address().port}/connect.html`);
    url.searchParams.set('fixture', scenario);
    if (scenario === 'ready' || scenario === 'error') {
      url.searchParams.set('callback', 'http://127.0.0.1:49999/nexowire-connect');
      url.searchParams.set('state', 'fixture');
      url.searchParams.set('deviceId', 'fixture-device');
      url.searchParams.set('deviceName', 'Fixture PC');
    }
    const png = join(output, `${name}.png`);
    const dom = await runChrome(url.href, png, [width, height]);
    const state = dom.match(/data-fixture-state="([^"]*)"/)?.[1] ?? 'NOT_OBSERVED';
    const actualWidth = Number(dom.match(/data-fixture-width="([^"]*)"/)?.[1] ?? NaN);
    const overflow = dom.match(/data-fixture-overflow="([^"]*)"/)?.[1] ?? 'NOT_OBSERVED';
    const focus = dom.match(/data-fixture-focus="([^"]*)"/)?.[1] ?? 'NOT_OBSERVED';
    const hash = createHash('sha256').update(await readFile(png)).digest('hex');
    report.cases.push({ name, requestedWidth: width, actualWidth, height, expectedState, state, overflow, focus, screenshot: png, sha256: hash, stateMatched: state === expectedState });
  }
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  if (report.cases.some((item) => !item.stateMatched)) process.exitCode = 1;
} catch (error) {
  process.stderr.write(`BROWSER_NOT_RUN: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
} finally {
  await new Promise((done) => server.close(done));
}
