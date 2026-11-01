#!/usr/bin/env node
/**
 * Dependency-free, read-only checks for the public static web shell.
 * This does NOT run JavaScript, a browser, an authenticated session or a layout engine.
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PAGES = Object.freeze({
  dashboard: { file: 'index.html', ids: ['main-content', 'connection-pill', 'devices', 'error-panel'] },
  connect: { file: 'connect.html', ids: ['install-panel', 'chatgpt-panel', 'pair-panel', 'error-panel'] },
  admin: { file: 'admin.html', ids: ['admin-pill', 'admin-error'] },
});

export const VIEWPORTS = Object.freeze([
  { name: 'mobile', width: 375, height: 812 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1440, height: 900 },
]);

function attribute(tag, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|\\s)${escaped}\\s*=\\s*(["'])(.*?)\\1`, 'i').exec(tag)?.[2] ?? null;
}

function tags(html, name) {
  return [...html.matchAll(new RegExp(`<${name}\\b[^>]*>`, 'gi'))].map((match) => match[0]);
}

function checkResource(webDir, file, reference) {
  // Root-relative, remote and data URLs are not local static assets.
  if (/^(?:\/|#|[a-z][a-z\d+.-]*:|\/\/)/i.test(reference)) return null;
  const pathname = reference.split(/[?#]/, 1)[0];
  if (!pathname) return null;
  // A static file contract should not depend on a host's interpretation of
  // encoded dot/slash characters, Windows backslashes or symlink targets.
  if (/%(?:2e|2f|5c)/i.test(pathname) || pathname.includes('\\')) {
    return `ambiguous encoded path or backslash: ${reference}`;
  }
  const target = resolve(webDir, dirname(file), pathname);
  const withinWeb = relative(webDir, target);
  if (isAbsolute(withinWeb) || withinWeb === '..' || withinWeb.startsWith(`..${sep}`)) {
    return `path escapes web/: ${reference}`;
  }
  if (!existsSync(target)) return `missing static asset: ${reference}`;
  const actual = relative(realpathSync(webDir), realpathSync(target));
  if (isAbsolute(actual) || actual === '..' || actual.startsWith(`..${sep}`)) {
    return `symlink escapes web/: ${reference}`;
  }
  return null;
}

export function auditWebShell(webDir) {
  const checks = [];
  const add = (page, rule, passed, detail) => checks.push({ page, rule, status: passed ? 'PASS' : 'FAIL', detail });

  for (const [page, spec] of Object.entries(PAGES)) {
    const path = join(webDir, spec.file);
    if (!existsSync(path)) {
      add(page, 'file', false, `missing ${spec.file}`);
      continue;
    }
    const html = readFileSync(path, 'utf8');
    add(page, 'doctype', /^\s*<!doctype\s+html\s*>/i.test(html), 'HTML5 doctype');
    add(page, 'language', /<html\b[^>]*\blang\s*=\s*["'][^"']+["']/i.test(html), 'document language');
    add(page, 'viewport-meta', tags(html, 'meta').some((t) => attribute(t, 'name')?.toLowerCase() === 'viewport' && /width\s*=\s*device-width/i.test(attribute(t, 'content') ?? '')), 'device-width viewport meta');

    const ids = [...html.matchAll(/\bid\s*=\s*(["'])(.*?)\1/gi)].map((match) => match[2]);
    const duplicates = ids.filter((id, i) => ids.indexOf(id) !== i);
    add(page, 'unique-ids', duplicates.length === 0, duplicates.length ? `duplicate ids: ${[...new Set(duplicates)].join(', ')}` : 'no duplicate ids');
    for (const id of spec.ids) add(page, `required-id:${id}`, ids.includes(id), `#${id}`);

    const styleLinks = tags(html, 'link').filter((tag) => /\bstylesheet\b/i.test(attribute(tag, 'rel') ?? ''));
    const modules = tags(html, 'script').filter((tag) => attribute(tag, 'type') === 'module');
    add(page, 'stylesheet-present', styleLinks.length > 0, 'static stylesheet declared');
    add(page, 'module-present', modules.some((tag) => attribute(tag, 'src')), 'module entrypoint declared');

    for (const tag of [...styleLinks, ...modules]) {
      const src = attribute(tag, 'href') ?? attribute(tag, 'src');
      if (src === null) {
        add(page, 'asset-reference', false, 'asset tag has no href/src');
        continue;
      }
      if (/^(?:https?:|\/\/)/i.test(src)) {
        add(page, 'asset-reference', false, `remote runtime asset not checked offline: ${src}`);
        continue;
      }
      const error = checkResource(webDir, spec.file, src);
      add(page, 'asset-reference', !error, error ?? `resolved: ${src}`);
    }
  }

  const failures = checks.filter((check) => check.status === 'FAIL');
  return {
    schemaVersion: 1,
    static: { status: failures.length ? 'FAIL' : 'PASS', checks, passed: checks.length - failures.length, failed: failures.length },
    // Width declarations are test inputs, not evidence of actual rendering.
    visual: {
      status: 'NOT_RUN',
      engine: null,
      scenarios: Object.keys(PAGES).flatMap((page) => VIEWPORTS.map((viewport) => ({
        page,
        ...viewport,
        layout: 'NOT_RUN',
        overflow: 'NOT_RUN',
        keyboardFocus: 'NOT_RUN',
        screenshot: null,
      }))),
      reason: 'No browser/layout engine was launched; CSS overflow, focus and screenshots need separate evidence.',
    },
    accountAndDevice: { status: 'NOT_RUN', reason: 'No live account, Agent, Hub or device was accessed.' },
  };
}

const calledDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (calledDirectly) {
  const webDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../../web');
  const report = auditWebShell(webDir);
  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`Static web: ${report.static.status} (${report.static.passed} passed, ${report.static.failed} failed)\n`);
    for (const failure of report.static.checks.filter((c) => c.status === 'FAIL')) {
      process.stderr.write(`FAIL ${failure.page}/${failure.rule}: ${failure.detail}\n`);
    }
    process.stdout.write(`Visual/browser: ${report.visual.status}; account/device: ${report.accountAndDevice.status}\n`);
  }
  if (report.static.status === 'FAIL') process.exitCode = 1;
}
