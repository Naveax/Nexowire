#!/usr/bin/env node
/**
 * Opt-in, network-isolated visual fixtures for #485. This exercises layout of
 * loading/error/success-looking DOM panels; success is synthetic, never a
 * paired device, authenticated user, or authorization acceptance test.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inspectPng } from './browser-visual-smoke.mjs';
import { VIEWPORTS } from './offline-web-smoke.mjs';

const STATES = ['loading', 'error', 'success'];
const SHA = /^[a-f0-9]{40}$/;

function actualCheckoutSha() {
  try {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  } catch { return null; }
}

export function allowOfflineFixtureRequest(address, webDir) {
  try {
    const url = new URL(address);
    if (url.protocol === 'data:') return true;
    if (url.protocol !== 'file:') return false;
    const path = realpathSync(fileURLToPath(url));
    const root = realpathSync(webDir);
    const within = relative(root, path);
    // Loading connect.js would race our explicit visual fixture state changes
    // against its normal asynchronous API requests. This is an HTML/CSS layout
    // fixture, deliberately not a functional JS or authenticated pairing test.
    return !isAbsolute(within) && within !== '..' && !within.startsWith(`..${sep}`) &&
      path !== join(root, 'connect.js');
  } catch { return false; }
}

function setSyntheticState(state) {
  const get = (name) => document.getElementById(name);
  get('error-panel').classList.toggle('hidden', state !== 'error');
  get('pair-panel').classList.toggle('hidden', state !== 'success');
  get('chatgpt-panel').classList.toggle('hidden', state === 'success');
  get('chatgpt-status').textContent = state === 'loading'
    ? 'Görünüm örneği: adres bekleniyor (gerçek istek yapılmadı)'
    : state === 'error'
      ? 'Görünüm örneği: bağlantı başarısız (gerçek istek yapılmadı)'
      : 'Görünüm örneği: cihaz eşleştirilmedi';
  get('error-message').textContent = 'Görünüm örneği: bağlantı kurulamadı. Gerçek cihaz testi yapılmadı.';
  get('device-name').textContent = 'Örnek cihaz (eşleştirilmedi)';
  get('status-title').textContent = 'Örnek başarılı durum görünümü';
  get('status-text').textContent = 'Bu ekran sentetiktir; gerçek bağlantı/izin kanıtı değildir.';
  get('approve').disabled = true;
  get('connect-pill').textContent = `ÖRNEK: ${state}`;
  get('connect-pill').className = 'pill muted';
}

export async function captureHostedConnectFixtures({ outputDir, sourceSha, checkoutSha = actualCheckoutSha(), playwrightModule = 'playwright', viewports = VIEWPORTS }) {
  const screenshots = [];
  if (!SHA.test(sourceSha ?? '')) return { status: 'NOT_RUN', reason: 'valid source SHA is required', screenshots };
  if (checkoutSha !== sourceSha) return { status: 'NOT_RUN', reason: 'source SHA differs from checked-out commit', screenshots };
  let chromium;
  try { ({ chromium } = await import(playwrightModule)); }
  catch { return { status: 'NOT_RUN', reason: 'Playwright module unavailable', screenshots }; }
  let browser;
  try { browser = await chromium.launch({ headless: true }); }
  catch { return { status: 'NOT_RUN', reason: 'Browser launch failed (details redacted)', screenshots }; }
  const webDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../../web');
  try { mkdirSync(outputDir, { recursive: true }); }
  catch {
    await browser.close().catch(() => {});
    return { status: 'NOT_RUN', reason: 'Output directory unavailable', screenshots };
  }
  let failed = false;
  const digests = new Set();
  try {
    for (const viewport of viewports) {
      let context;
      try {
        context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, serviceWorkers: 'block' });
        await context.route('**/*', (route) => {
          return allowOfflineFixtureRequest(route.request().url(), webDir) ? route.continue() : route.abort();
        });
        const page = await context.newPage();
        await page.goto(pathToFileURL(join(webDir, 'connect.html')).href, { waitUntil: 'domcontentloaded' });
        for (const state of STATES) {
          await page.evaluate(setSyntheticState, state);
          const filename = `connect-${state}-${viewport.width}x${viewport.height}.png`;
          const path = join(outputDir, filename);
          await page.screenshot({ path, fullPage: false, animations: 'disabled' });
          const png = inspectPng(path, viewport.width, viewport.height);
          const sha256 = createHash('sha256').update(readFileSync(path)).digest('hex');
          const unique = !digests.has(sha256);
          digests.add(sha256);
          const overflow = await page.evaluate(() =>
            Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) > innerWidth + 1 ? 'FAIL' : 'PASS');
          const valid = png.status === 'PASS' && unique && overflow === 'PASS';
          if (!valid) failed = true;
          screenshots.push({ state, viewport: viewport.name, width: viewport.width, height: viewport.height,
            file: basename(path), sha256, status: valid ? 'CAPTURED_SYNTHETIC' : 'FAIL', overflow });
        }
      } catch {
        failed = true;
        screenshots.push({ state: 'ALL', viewport: viewport.name, status: 'FAIL', reason: 'capture failed (details redacted)' });
      } finally {
        if (context) await context.close().catch(() => {});
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }
  return { status: failed ? 'FAIL' : 'PARTIAL_STATIC_FIXTURE', sourceSha,
    evidenceKind: 'LOCAL_FILE_DOM_FIXTURE_NO_NETWORK', screenshots,
    realPairing: 'NOT_RUN', browserOriginIndependent: 'NOT_VERIFIED', keyboardNavigation: 'NOT_RUN',
    windowsDeviceAcceptance: 'NOT_RUN' };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const option = (name) => { const index = args.indexOf(name); return index < 0 ? null : args[index + 1]; };
  const outputDir = option('--out');
  const sourceSha = option('--source-sha');
  if (!outputDir) {
    process.stderr.write('Usage: node hosted-connect-three-state.mjs --out <temporary-dir> --source-sha <exact-40-hex>\n');
    process.exitCode = 2;
  } else {
    const result = await captureHostedConnectFixtures({ outputDir: resolve(outputDir), sourceSha });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = result.status === 'FAIL' ? 1 : result.status === 'NOT_RUN' ? 2 : 0;
  }
}
