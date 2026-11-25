import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {controlledSystemHubCutover} from '../../scripts/ai04-controlled-system-hub-cutover.js';

test('unprovisioned production cutover denies before elevation or any artifact access',async()=>{
  await assert.rejects(controlledSystemHubCutover('inert-not-an-executable'),
    {message:'AI04_SIGNED_SQLITE_RECOVERY_AUTHORITY_REQUIRED'});
});

test('manual legacy rollback admission denies before artifact verification or PowerShell execution',()=>{
  const source=readFileSync(new URL('../../scripts/ai04-controlled-system-hub-cutover.ts',import.meta.url),'utf8');
  const start=source.indexOf('function runRollbackScript():void{');
  assert.ok(start>=0);
  const body=source.slice(start,source.indexOf('\n}',start));
  assert.match(body,/^function runRollbackScript\(\):void\{\s*requireIndependentRecoveryAuthority\(\);/);
  assert.ok(body.indexOf('requireIndependentRecoveryAuthority()')<body.indexOf('validateRecoveredScript()'));
  assert.ok(body.indexOf('validateRecoveredScript()')<body.indexOf('runPS('));
});
