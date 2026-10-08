import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const app = readFileSync('web/app.js','utf8');
const html = readFileSync('web/index.html','utf8');
const css = readFileSync('web/styles.css','utf8');
const connect = readFileSync('web/connect.html','utf8');
const connectJs = readFileSync('web/connect.js','utf8');

test('PC Settings uses an actual reachable button with unique per-device panel',()=>{
  assert.match(app, /<button type="button" class="pc-settings-button" aria-expanded="false">/);
  assert.match(app, /pcButton\.setAttribute\('aria-controls', pcPanel\.id\)/);
  assert.match(app, /pcButton\.addEventListener\('click'/);
  assert.match(app, /pcPanel\.inert = !open/);
  assert.doesNotMatch(app, /<summary class="pc-settings-summary"/);
  assert.match(css, /\.pc-settings-button:hover/);
  assert.match(css, /\.pc-settings\.is-open \.pc-settings-panel/);
});

test('PC Settings stays below the badges and is left aligned on desktop and mobile',()=>{
  assert.match(app, /root-state-chip[^\n]+[\s\S]*?'\<\/div\>',\s*' <button type="button" class="pc-settings-button"/);
  assert.match(css, /\.pc-settings \.pc-settings-button \{ margin:0; width:auto;/);
  assert.match(css, /@media \(max-width:620px\)[\s\S]*?\.pc-settings \.pc-settings-button \{ width:auto;/);
  assert.match(html, /class="policy-steps" role="list"/);
  assert.match(html, /class="policy-line" role="listitem"/);
  assert.match(css, /\.auto-selection-heading \{ align-items:flex-start; flex-direction:column;/);
});

test('FULL and ROOT are shown independently beside Agent/Bridge and Core is not represented as real privilege',()=>{
  assert.match(app, /Full Access açık/);
  assert.match(app, /ROOT kapalı/);
  assert.match(app, /ROOT izni açık/);
  assert.match(app, /Core Access henüz etkinleştirilebilir değil/);
  assert.match(html, /data-filter="persistent"[^>]+>CORE/);
});

test('Auto selection is owner approved and defaults to off, with no untrusted auto-routes',()=>{
  assert.match(html, /id="auto-toggle"/);
  assert.match(html, /id="auto-confirm-panel"/);
  assert.match(html, /AUTO DEVICE ACCESS/);
  assert.match(app, /\/api\/v1\/me\/device-selection\/auto/);
  assert.match(app, /auto-device-selection-v1/);
  assert.match(app, /snapshot\.autoSelectDevices === true/);
});

test('install view preserves protected local callback pairing and allows leaving any step',()=>{
  assert.match(connect, /class="brand-symbol"/);
  assert.match(connect, /href="\/"[^>]*aria-label="Kontrol paneline geri dön"/);
  assert.match(connect, /id="install-panel"/);
  assert.match(connect, /id="pair-panel"/);
  assert.match(connect, /data-os="windows"/);
  assert.match(connect, /data-os="macos"/);
  assert.match(connect, /data-os="linux"/);
  assert.match(connectJs, /validatedLoopbackCallback/);
  assert.match(connectJs, /selectInstallOS\(detectedOS\(\)\)/);
  assert.match(connectJs, /navigator\.clipboard\.writeText/);
  assert.match(connectJs, /Nexowire-Setup\.cmd/);
  assert.match(connectJs, /SHA256SUMS-Windows/);
  assert.match(connectJs, /window\.location\.replace\(callback\.toString\(\)\)/);
  assert.doesNotMatch(connectJs, /eval\(|new Function\(/);
});
