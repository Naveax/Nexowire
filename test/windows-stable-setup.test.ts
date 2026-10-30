import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import {
  renderStableWindowsSetup,
  stableWindowsChecksums,
  stableWindowsPayload,
} from '../scripts/generate-windows-stable-setup.js';

test('downloadable bootstrap exactly matches its source and published payload pins', async () => {
  const setup = renderStableWindowsSetup();
  assert.equal(await fs.readFile(new URL('../installers/Nexowire-Setup.cmd', import.meta.url), 'utf8'), setup);
  assert.equal(await fs.readFile(new URL('../installers/SHA256SUMS-Windows', import.meta.url), 'utf8'), stableWindowsChecksums(setup));
  assert.match(setup, /releases\/download\/v1\.0\.7\/Nexowire-Windows-x64\.zip/);
  assert.match(setup, /NX_BUILD_ID=1\.0\.7-e9489175cf59/);
  assert.ok(setup.includes(stableWindowsPayload.payloadSha256));
  assert.equal(setup.replaceAll('\r\n', '').includes('\n'), false, 'CMD bytes must retain CRLF.');
});
