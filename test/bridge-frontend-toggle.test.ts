import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const app=readFileSync(new URL('../web/app.js',import.meta.url),'utf8');
const css=readFileSync(new URL('../web/styles.css',import.meta.url),'utf8');

test('Admin Bridge has a visible one-click ON/OFF card shortcut and an accessible PC Settings switch',()=>{
  assert.match(app,/class="bridge-quick-toggle"/);
  assert.match(app,/class="bridge-quick-state">AUTO/);
  assert.match(app,/class="bridge-toggle" role="switch" aria-checked="false"/);
  assert.match(app,/bridgeToggle\.setAttribute\('aria-checked', String\(bridgeIsOn\)\)/);
  assert.match(app,/bridgeQuickToggle\.setAttribute\('aria-pressed', String\(bridgeIsOn\)\)/);
  assert.match(app,/const bridgeNextMode = bridgeIsOn \? 'off' : 'on'/);
  assert.match(app,/setDeviceBridgePreference\(device\.id, bridgeNextMode, row\)/);
  assert.match(css,/\.bridge-toggle-track/);
  assert.match(css,/\.bridge-toggle-thumb/);
  assert.match(css,/\.bridge-quick-toggle\.active/);
  assert.match(css,/\.bridge-toggle:focus-visible/);
});

test('AUTO remains optional, selected preference is not falsely presented as applied broker state',()=>{
  assert.match(app,/class="secondary bridge-mode" data-bridge="auto"/);
  assert.match(app,/bridgeCard\.dataset\.desiredMode = bridgeDesired/);
  assert.match(app,/Broker doğrulanamadı/);
  assert.match(app,/Yerel aç\/kapat komutları henüz bağlı değil/);
  assert.match(app,/Broker durumu henüz değiştirilmez/);
  assert.match(app,/row\.querySelector\('\.bridge-live-status'\)/);
  assert.doesNotMatch(app,/bridgePreference\.applied\s*=\s*true/);
  assert.doesNotMatch(app,/window\.confirm|window\.prompt/);
});

test('bridge quick button and switch are both disabled while save is in-flight and existing owner API is used',()=>{
  assert.match(app,/querySelectorAll\('\.bridge-quick-toggle, \.bridge-toggle, \.bridge-mode'\)/);
  assert.match(app,/for \(const button of buttons\) button\.disabled = true/);
  assert.match(app,/for \(const button of buttons\) button\.disabled = false/);
  assert.match(app,/\/api\/v1\/me\/devices\/bridge-preference/);
  assert.match(app,/bridge-preference-v1/);
  assert.doesNotMatch(app,/reconcilePrivilegedBrokerMode\(/);
});
