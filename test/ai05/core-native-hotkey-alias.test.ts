import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { CORE_POWERSHELL } from '../../src/agent/windows-core-console-native.js';

test('native CORE hotkey uses PowerShell 5.1-compatible uint16 casts', () => {
  const source = readFileSync(new URL('../../src/agent/windows-core-console-native.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\[ushort(?:\[\])?\]/);
  assert.match(source, /\[NxCoreConsole\]::Chord\(\[uint16\[\]\]\$keys\)/);
  assert.match(source, /\[uint16\]\[Enum\]::Parse/);
  if (process.platform !== 'win32') return;
  const command = "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Windows.Forms; $n='F24'; $key=[uint16][Enum]::Parse([System.Windows.Forms.Keys],$n,$true); if($key -ne 135){throw 'Wrong F24 key'}; Write-Output 'PASS'";
  const result = spawnSync(CORE_POWERSHELL, ['-NoProfile','-NonInteractive','-Command',command], {encoding:'utf8', timeout:20000});
  assert.equal(result.error,undefined,String(result.error));
  assert.equal(result.status,0,result.stderr || result.stdout);
  assert.match(result.stdout,/PASS/);
});
