import test from 'node:test';
import assert from 'node:assert/strict';
import {
  renderMachineCutoverScript,
} from '../src/update/machine-update.js';

test('machine cutover updates only Nexowire machine launchers and rolls back on failed health', () => {
  const script = renderMachineCutoverScript({
    version: '1.0.5',
    buildId: '1.0.5-012345abcdef',
    targetRoot:
      'C:\\ProgramData\\Nexowire\\versions\\1.0.5-012345abcdef',
  });

  assert.match(script, /Nexowire Privileged Broker/);
  assert.match(script, /Nexowire Hub Boot/);
  assert.match(script, /privileged-broker/);
  assert.match(script, /cli\\\.js/);
  assert.match(script, /Updated SYSTEM Hub did not bind 43110/);
  assert.match(script, /Updated Admin Bridge did not bind 43112/);
  assert.match(script, /\.update-rollback/);
  assert.match(script, /Restore/);
  assert.match(script, /rolled_back/);
  assert.match(
    script,
    /C:\\ProgramData\\Nexowire\\versions\\1\.0\.5-012345abcdef/,
  );
  assert.doesNotMatch(
    script,
    /Invoke-Expression|iex\s|Start-Process.+cmd\.exe/i,
  );
});


test('machine cutover replaces only official version-directory component not the executable suffix', () => {
  const script = renderMachineCutoverScript({
    version: '1.0.6',
    buildId: '1.0.6-012345abcdef',
    targetRoot: 'C:\\ProgramData\\Nexowire\\versions\\1.0.6-012345abcdef',
  });
  assert.match(script, /\[0-9\]\+\\\.\[0-9\]\+\\\.\[0-9\]\+-\[a-f0-9\]\{12\}/);
  assert.doesNotMatch(script, /versions\\\[\^''/);
});
