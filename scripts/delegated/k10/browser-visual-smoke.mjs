#!/usr/bin/env node
/**
 * Opt-in browser capture of local static files. Needs an already installed
 * Playwright package/browser. All HTTP(S) requests are blocked. No login/API.
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inflateSync } from 'node:zlib';
import { PAGES, VIEWPORTS } from './offline-web-smoke.mjs';

function crc32(buffer, start, end) {
  let value = 0xffffffff;
  for (let i = start; i < end; i++) {
    value ^= buffer[i];
    for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}

export function inspectPng(path, width, height) {
  let data;
  try { data = readFileSync(path); } catch { return { status: 'FAIL', reason: 'PNG file not readable' }; }
  if (data.length > 24 * 1024 * 1024) return { status: 'FAIL', reason: 'PNG exceeds 24 MiB inspection limit' };
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (data.length < 33 || !data.subarray(0, 8).equals(signature)) {
    return { status: 'FAIL', reason: 'missing PNG signature/complete IHDR' };
  }
  let offset = 8;
  let dimensions = null;
  let channels = 0;
  let sawIend = false;
  const compressed = [];
  while (offset + 12 <= data.length) {
    const length = data.readUInt32BE(offset);
    if (length > data.length - offset - 12) return { status: 'FAIL', reason: 'truncated PNG chunk' };
    const type = data.toString('ascii', offset + 4, offset + 8);
    const next = offset + 12 + length;
    const expectedCrc = data.readUInt32BE(next - 4);
    if (crc32(data, offset + 4, next - 4) !== expectedCrc) return { status: 'FAIL', reason: `invalid ${type} CRC` };
    if (dimensions === null && type !== 'IHDR') return { status: 'FAIL', reason: 'IHDR must be first' };
    if (type === 'IHDR') {
      if (dimensions || length !== 13) return { status: 'FAIL', reason: 'invalid or duplicated IHDR' };
      const actualWidth = data.readUInt32BE(offset + 8);
      const actualHeight = data.readUInt32BE(offset + 12);
      const bitDepth = data[offset + 16];
      const colorType = data[offset + 17];
      if (!actualWidth || !actualHeight || bitDepth !== 8 || ![2, 6].includes(colorType) ||
          data[offset + 18] !== 0 || data[offset + 19] !== 0 || data[offset + 20] !== 0) {
        return { status: 'FAIL', reason: 'unsupported or invalid RGB/RGBA IHDR' };
      }
      dimensions = { width: actualWidth, height: actualHeight };
      channels = colorType === 6 ? 4 : 3;
    }
    if (type === 'IDAT') compressed.push(data.subarray(offset + 8, next - 4));
    if (type === 'IEND') {
      if (length !== 0 || next !== data.length) return { status: 'FAIL', reason: 'invalid PNG end/trailing bytes' };
      sawIend = true;
      break;
    }
    offset = next;
  }
  if (!dimensions || !sawIend || compressed.length === 0) return { status: 'FAIL', reason: 'missing IDAT/IEND or incomplete PNG' };
  if (dimensions.width !== width || dimensions.height !== height) {
    return { status: 'FAIL', ...dimensions, reason: 'PNG dimensions differ from requested viewport' };
  }
  const rowBytes = dimensions.width * channels;
  const rawLength = (rowBytes + 1) * dimensions.height;
  if (!Number.isSafeInteger(rawLength) || rawLength > 24 * 1024 * 1024) {
    return { status: 'FAIL', reason: 'decoded PNG dimensions exceed safe limit' };
  }
  let decoded;
  try { decoded = inflateSync(Buffer.concat(compressed), { maxOutputLength: rawLength + 1 }); }
  catch { return { status: 'FAIL', reason: 'corrupt or oversized compressed PNG pixels' }; }
  if (decoded.length !== rawLength) return { status: 'FAIL', reason: 'decoded PNG row length mismatch' };
  for (let row = 0; row < dimensions.height; row++) {
    if (decoded[row * (rowBytes + 1)] > 4) return { status: 'FAIL', reason: 'invalid PNG filter byte' };
  }
  return { status: 'PASS', ...dimensions };
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
