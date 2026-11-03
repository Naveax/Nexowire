#!/usr/bin/env node
/** Read-only inventory of HTML pages without authenticated browser evidence. */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditWebShell, PAGES, VIEWPORTS } from '../k10/offline-web-smoke.mjs';

export function buildBrowserEvidenceInventory(webDir, stateManifest) {
  const checked = auditWebShell(webDir);
  const knownFiles = new Map(Object.entries(PAGES).map(([page, spec]) => [spec.file, page]));
  const pages = readdirSync(webDir).filter((file) => file.endsWith('.html')).sort();
  const cases = Array.isArray(stateManifest?.cases) ? stateManifest.cases : [];
  return {
    schemaVersion: 1,
    origin: 'READ_ONLY_OFFLINE_SOURCE_INVENTORY',
    staticStatus: checked.static.status,
    browserEvidence: 'NOT_RUN',
    authenticatedRuntimeEvidence: 'NOT_RUN',
    pages: pages.map((file) => {
      const known = knownFiles.get(file) ?? null;
      const screen = readFileSync(join(webDir, file), 'utf8');
      const mappedStates = cases.filter((item) => item.page === known).map((item) => item.state);
      return {
        file,
        auditedPage: known,
        html5Source: /^\s*<!doctype\s+html\s*>/i.test(screen) ? 'OBSERVED' : 'MISSING',
        staticSmoke: known ? (checked.static.checks.some((item) => item.page === known && item.status === 'FAIL') ? 'FAIL' : 'PASS') : 'NOT_COVERED',
        screenshotCapture: 'NOT_RUN',
        keyboardFocus: 'NOT_RUN',
        horizontalOverflow: 'NOT_RUN',
        authenticatedStates: known ? 'NOT_RUN' : 'NOT_DEFINED',
        scenarioNames: mappedStates,
        candidateViewports: VIEWPORTS.map(({ name, width, height }) => ({ name, width, height, screenshot: 'NOT_RUN' })),
      };
    }),
    note: 'HTML/source checks and synthetic fixtures do not establish screenshots, focus order, runtime states, or real-device acceptance.',
  };
}

export function renderInventoryMarkdown(inventory) {
  const lines = [
    '# Offline browser evidence gaps',
    '',
    `Source-level static result: ${inventory.staticStatus}. Browser: **${inventory.browserEvidence}**. Authenticated runtime: **${inventory.authenticatedRuntimeEvidence}**.`,
    '',
    '| HTML page | Static source | Screenshots | Focus | Overflow | Runtime states |',
    '| --- | --- | --- | --- | --- | --- |',
    ...inventory.pages.map((page) => `| ${page.file} | ${page.staticSmoke} | ${page.screenshotCapture} | ${page.keyboardFocus} | ${page.horizontalOverflow} | ${page.authenticatedStates} |`),
    '',
    `Candidate screenshots lacking evidence: ${inventory.pages.length * VIEWPORTS.length} (3 widths per page).`,
    'No missing screenshot is counted as PASS. Real browser/authorized account/Windows/device tests are not run.',
    '',
  ];
  return lines.join('\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../');
  const cases = JSON.parse(readFileSync(join(root, 'test/delegated/k10/state-scenarios.json'), 'utf8'));
  const inventory = buildBrowserEvidenceInventory(join(root, 'web'), cases);
  process.stdout.write(process.argv.includes('--json') ? `${JSON.stringify(inventory, null, 2)}\n` : renderInventoryMarkdown(inventory));
  if (inventory.staticStatus === 'FAIL' || inventory.pages.some((page) => page.staticSmoke === 'FAIL')) process.exitCode = 1;
}
