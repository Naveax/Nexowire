import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {
  assertProtectedSystemHubStateRoot,
  parsePersistedHubLauncherEnvironment,
} from '../src/hub/hub-boot-lifecycle.js';

const protectedRoot='C:\\ProgramData\\Nexowire\\hub-state';
const code=(error:unknown)=>error instanceof Error &&
  error.message==='HUB_BOOT_SYSTEM_STATE_MIGRATION_REQUIRED';

test('SYSTEM Hub refuses user-profile and untrusted state roots before activation',()=>{
  const invalid=[
    undefined,'','C:\\Users\\Owner\\.nexowire\\hub',
    'C:\\Users\\Owner\\.nexowire\\hub\\',
    'C:\\ProgramData\\Nexowire\\hub-state\\..\\hub',
    '\\\\remote-share\\Nexowire\\hub-state',
    'C:\\ProgramData\\Nexowire\\hub-state\\',
    'c:\\programdata\\nexowire\\hub-state',
    'C:\\ProgramData\\Nexowire\\hub-boot',
    '..\\hub-state',
  ];
  for(const value of invalid){
    assert.throws(()=>assertProtectedSystemHubStateRoot(value),code,
      'Invalid inherited state unexpectedly admitted: '+String(value));
  }
  assert.equal(assertProtectedSystemHubStateRoot(protectedRoot),protectedRoot);
});

test('SYSTEM Hub fails closed against a persisted interactive user launcher',()=>{
  const env=parsePersistedHubLauncherEnvironment(
    "$env:NEXOWIRE_STATE_DIR='C:\\Users\\Owner\\.nexowire\\hub'\n"+
    "$env:NEXOWIRE_HTTP_PORT='43110'\n",
  );
  assert.equal(env.NEXOWIRE_HTTP_PORT,'43110');
  assert.throws(()=>assertProtectedSystemHubStateRoot(env.NEXOWIRE_STATE_DIR),code);
});

test('migration and ACL preflight precede user DPAPI unseal and task mutation',()=>{
  const source=readFileSync(new URL('../src/hub/hub-boot-lifecycle.ts',import.meta.url),'utf8');
  const begin=source.indexOf('export async function installHubBootLifecycle(');
  const preflight=source.indexOf('const protectedStateRoot=assertProtectedSystemHubStateRoot(',begin);
  const acl=source.indexOf('verifyWindowsPrivateAcl(protectedStateRoot);',preflight);
  const sqliteAcl=source.indexOf("verifyWindowsPrivateAcl(path.win32.join(protectedStateRoot,'idempotency-records.sqlite'));",acl);
  const sourceSecret=source.indexOf('const sourceSecretFile =',preflight);
  const sourceDPAPI=source.indexOf('readProtectedSecretFile(',sourceSecret);
  const tasks=source.indexOf('Register-ScheduledTask',sourceSecret);
  assert.ok(begin>=0 && preflight>begin && acl>preflight &&
    sqliteAcl>acl && sourceSecret>sqliteAcl && sourceDPAPI>sourceSecret &&
    tasks>sourceDPAPI,'Unprotected state cannot reach DPAPI or Scheduled Task side effects');
});
