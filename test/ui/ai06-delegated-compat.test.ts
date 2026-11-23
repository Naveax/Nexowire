import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';

// Read-only CI compatibility: the main delegated 409-case TAP is redirected
// to a temporary file, so a failure can otherwise hide the responsible test.
// Run only the AI-06 contract subset in an isolated child. Do not trigger
// any Windows tasks, authorization, pairing network calls or real devices.
test('AI-06: delegated connect, pairing recovery, and source UI contracts execute visibly',()=>{
  const paths=[
    'test/delegated/k06/connect-error-display.test.mjs',
    'test/delegated/k06/p005-pairing-recovery.test.mjs',
    'test/connect-web.test.ts',
  ];
  const child=spawnSync(process.execPath,
    ['--test','--import','tsx',...paths],{
      cwd:process.cwd(),encoding:'utf8',timeout:45_000,
      maxBuffer:2*1024*1024,
      env:{...process.env,CI:'true'},
    });
  const diagnostics=[child.stdout,child.stderr]
    .filter((value):value is string=>typeof value==='string')
    .join('\n').slice(-16_000);
  assert.equal(child.error,undefined,
    'AI-06 delegated source test harness failed to launch: '+String(child.error));
  assert.equal(child.signal,null,
    'AI-06 delegated source test harness terminated: '+String(child.signal));
  assert.equal(child.status,0,
    'AI-06 delegated connect contract failed on this exact checkout:\n'+diagnostics);
});
