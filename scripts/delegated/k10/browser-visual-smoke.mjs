#!/usr/bin/env node
/**
 * Opt-in browser capture of local static files. Needs an already installed
 * Playwright package/browser. All HTTP(S) requests are blocked. No login/API.
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PAGES, VIEWPORTS } from './offline-web-smoke.mjs';

export function inspectPng(path, width, height) {
  const data = readFileSync(path);
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (data.length < 24 || !data.subarray(0, 8).equals(signature) || data.toString('ascii', 12, 16) !== 'IHDR') {
    return { status: 'FAIL', reason: 'missing PNG signature/IHDR' };
  }
  const actualWidth = data.readUInt32BE(16);
  const actualHeight = data.readUInt32BE(20);
  return actualWidth === width && actualHeight === height
    ? { status: 'PASS', width: actualWidth, height: actualHeight }
    : { status: 'FAIL', width: actualWidth, height: actualHeight, reason: 'PNG dimensions differ from requested viewport' };
}

export async function captureLocalStaticViews({ outputDir, playwrightModule = 'playwright' }) {
  const scenarios = [];
  let chromium;
  try {
    ({ chromium } = await import(playwrightModule));
  } catch (error) {
    return { status: 'NOT_RUN', reason: `Playwright is unavailable: ${error.code ?? error.message}`, scenarios };
  }
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (error) {
    return { status: 'NOT_RUN', reason: `Installed Chromium could not start: ${error.message}`, scenarios };
  }
  const webDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../../web');
  mkdirSync(outputDir, { recursive: true });
  try {
    for (const [name, spec] of Object.entries(PAGES)) {
      for (const viewport of VIEWPORTS) {
        const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, serviceWorkers: 'block' });
        const candidate = { page: name, viewport: viewport.name, width: viewport.width, height: viewport.height, screenshot: null, overflow: 'NOT_RUN', keyboardFocus: 'NOT_RUN' };
        scenarios.push(candidate);
        try {
          await context.route('**/*', (route) => {
            const protocol = new URL(route.request().url()).protocol;
            return protocol === 'file:' || protocol === 'data:' ? route.continue() : route.abort();
          });
          const page = await context.newPage();
          await page.goto(pathToFileURL(join(webDir, spec.file)).href, { waitUntil: 'domcontentloaded' });
          const screenshot = join(outputDir, `${name}-${viewport.name}-${viewport.width}x${viewport.height}.png`);
          await page.screenshot({ path: screenshot, animations: 'disabled', fullPage: false });
          candidate.png = inspectPng(screenshot, viewport.width, viewport.height);
          candidate.screenshot = basename(screenshot);
          candidate.overflow = await page.evaluate(() => {
            const actual = Math.max(document.body.scrollWidth, document.documentElement.scrollWidth);
            return actual > window.innerWidth + 1 ? 'FAIL' : 'PASS';
          });
          candidate.layout = candidate.png.status === 'PASS' ? 'CAPTURED_STATIC_FILE' : 'FAIL';
          candidate.note = 'file:// static preview only; API-driven states and focus navigation unverified';
        } catch (error) {
          candidate.layout = 'FAIL';
          candidate.error = error.message;
        } finally {
          await context.close();
        }
      }
    }
  } finally {
    await browser.close();
  }
  return {
    status: scenarios.some((item) => item.layout === 'FAIL' || item.overflow === 'FAIL') ? 'FAIL' : 'PARTIAL',
    kind: 'LOCAL_STATIC_FILE',
    network: 'HTTP_AND_HTTPS_BLOCKED',
    keyboardFocus: 'NOT_RUN',
    authenticatedStates: 'NOT_RUN',
    scenarios,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf('--out');
  if (i === -1 || !process.argv[i + 1]) {
    process.stderr.write('Usage: node scripts/delegated/k10/browser-visual-smoke.mjs --out <temporary-output-directory>\nRequires locally installed Playwright and Chromium; blocks HTTP(S).\n');
    process.exitCode = 2;
  } else {
    const result = await captureLocalStaticViews({ outputDir: resolve(process.argv[i + 1]) });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (result.status === 'NOT_RUN') process.exitCode = 2;
    if (result.status === 'FAIL') process.exitCode = 1;
  }
}
