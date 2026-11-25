import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {
  assertProtectedHubBootRoot,
  verifyHubBootSharedAncestorTrust,
} from '../src/hub/hub-boot-lifecycle.js';

const code=readFileSync(new URL('../src/hub/hub-boot-lifecycle.ts',import.meta.url),'utf8');
const installStart=code.indexOf('export async function installHubBootLifecycle(');
const uninstallStart=code.indexOf('export async function uninstallHubBootLifecycle(',installStart);
const install=code.slice(installStart,uninstallStart);
const uninstall=code.slice(uninstallStart);

test('production SYSTEM boot install requires ancestor ACL before reading user DPAPI, task changes or file creation',()=>{
  assert.ok(installStart>=0&&uninstallStart>installStart);
  const root=install.indexOf('assertProtectedHubBootRoot(protectedBootRoot)');
  const ancestor=install.indexOf('verifyHubBootSharedAncestorTrust()',root);
  const parent=install.indexOf('verifyWindowsPrivateAcl(path.win32.dirname(protectedBootRoot))');
  const firstTask=install.indexOf('Get-ScheduledTask -TaskName $boot');
  const token=install.indexOf('readProtectedSecretFile(');
  const create=install.indexOf('await fs.mkdir(p.root,{mode:0o700})');
  assert.ok(root>=0&&root<ancestor&&ancestor<parent&&parent<firstTask);
  assert.ok(ancestor<token&&ancestor<create);
  const harden=install.indexOf('hardenProgramDataAcl(p.root)');
  const stageAncestor=install.indexOf('verifyHubBootSharedAncestorTrust()',harden+1);
  const register=install.indexOf('Register-ScheduledTask -TaskName $boot');
  assert.ok(harden>create&&stageAncestor>harden&&stageAncestor<register);
  const stageCleanup=install.indexOf('} catch (stageError)');
  const stageCleanupAncestor=install.indexOf('verifyHubBootSharedAncestorTrust()',stageCleanup);
  const stageDelete=install.indexOf('await fs.rm(p.root',0);
  assert.ok(stageCleanupAncestor>stageCleanup&&stageCleanupAncestor<stageDelete);
});

test('installation task rollback checks shared ancestor before removing protected launcher',()=>{
  const fallback=install.indexOf('if(taskRollbackFailure===null){');
  const gate=install.indexOf('verifyHubBootSharedAncestorTrust()',fallback);
  const deletion=install.indexOf('await fs.rm(p.root',fallback);
  assert.ok(fallback>=0&&gate>fallback&&deletion>gate);
});

test('standalone SYSTEM boot uninstall cannot bypass the protected recovery authority',()=>{
  const end=uninstall.indexOf('export interface WindowsRebootAgentTaskEvidence');
  const direct=uninstall.slice(0,end);
  assert.match(direct,/HUB_BOOT_UNINSTALL_COORDINATED_RECOVERY_REQUIRED/);
  assert.doesNotMatch(direct,/fs\.|runPowerShellJson|(?:Stop|Start|Enable|Disable|Register|Unregister)-ScheduledTask/);
});

test('the shared ancestor verifier uses exact non-user-writable C:\\ and ProgramData paths',()=>{
  const declaration=code.indexOf('export function verifyHubBootSharedAncestorTrust():void');
  const end=code.indexOf('/** Preflight:',declaration);
  assert.ok(declaration>=0&&end>declaration);
  const body=code.slice(declaration,end);
  assert.match(body,/verifyWindowsStackOuterAncestorAcl\('C:\\\\'\)/);
  assert.match(body,/verifyWindowsStackOuterAncestorAcl\('C:\\\\ProgramData'\)/);
  assert.doesNotMatch(body,/options|process\.env|ProgramData\s*\?\?/);
  assert.doesNotThrow(()=>assertProtectedHubBootRoot('C:\\ProgramData\\Nexowire\\hub-boot'));
});

test('physical shared ancestors pass read-only Windows ACL verification',{
  skip:process.platform!=='win32',
},()=>{
  assert.doesNotThrow(()=>verifyHubBootSharedAncestorTrust());
});
