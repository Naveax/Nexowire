import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const source=readFileSync(new URL('../src/hub/hub-boot-lifecycle.ts',import.meta.url),'utf8');
const install=source.slice(
  source.indexOf('export async function installHubBootLifecycle('),
  source.indexOf('export async function uninstallHubBootLifecycle('),
);
const uninstall=source.slice(
  source.indexOf('export async function uninstallHubBootLifecycle('),
  source.indexOf('export interface WindowsRebootAgentTaskEvidence'),
);

test('SYSTEM handoff remembers the previous user task state and detects races before registration',()=>{
  const preflight=install.indexOf('const taskPreflight = await runPowerShellJson');
  const capture=install.indexOf('legacyState=$legacyState');
  const guard=install.indexOf('HUB_USER_TASK_STATE_RACE');
  const register=install.indexOf('Register-ScheduledTask -TaskName $boot');
  const stop=install.indexOf('Stop-ScheduledTask -TaskName $user');
  assert.ok(preflight>=0 && preflight<capture && capture<guard && guard<register && register<stop);
  assert.match(install,/HUB_USER_TASK_UNEXPECTED_STATE/);
  assert.match(install,/userTaskPreviousState|taskPreflight\.legacyState/);
});

test('SYSTEM handoff waits for the old listener to disappear before starting the new Hub',()=>{
  const stop=install.indexOf('Stop-ScheduledTask -TaskName $user');
  const poll=install.indexOf('Get-NetTCPConnection -State Listen -ErrorAction Stop',stop);
  const deny=install.indexOf('HUB_LEGACY_PORT_STILL_OWNED',poll);
  const start=install.indexOf('Start-ScheduledTask -TaskName $boot',deny);
  assert.ok(stop>=0 && stop<poll && poll<deny && deny<start);
  assert.match(install,/waitForBootHub\(port, p\.pid\)/);
});

test('failed staging removes only its own ACL-verified root and install rollback does not force-start an originally disabled task',()=>{
  const create=install.indexOf('await fs.mkdir(p.root,{mode:0o700})');
  const stage=install.indexOf('} catch (stageError) {',create);
  const verify=install.indexOf('await assertHubBootRootSafeToRemove(p.root)',stage);
  const remove=install.indexOf('await fs.rm(p.root,{recursive:true,force:true})',verify);
  const markerValidation=install.indexOf('const installMarker');
  const commit=install.indexOf('let switched = false;',remove);
  assert.ok(markerValidation>=0 && markerValidation<create);
  assert.ok(create>=0 && create<stage && stage<verify && verify<remove && remove<commit);
  assert.match(install,/HUB_BOOT_STAGE_CLEANUP_FAILED/);
  assert.match(install,/expectedLegacyState -ne 'Disabled' -and \$expectedLegacyState -ne 'NotInstalled'/);
  assert.match(install,/expectedLegacyState -eq 'Running'/);
});

test('standalone uninstall cannot bypass the independent recovery and state reconciliation path',()=>{
  assert.match(uninstall,/HUB_BOOT_UNINSTALL_COORDINATED_RECOVERY_REQUIRED/);
  assert.match(uninstall,/assertCanonicalHubBootTaskNames\(options\)/);
  assert.doesNotMatch(uninstall,/(?:Stop|Start|Enable|Disable|Register|Unregister)-ScheduledTask|fs\.(?:rm|unlink|writeFile)|runPowerShellJson/);
});

test('SYSTEM task must be independently read back before disabling the original user Hub',()=>{
  const registration=install.indexOf('Register-ScheduledTask -TaskName $boot');
  const readback=install.indexOf("'$bootTask=Get-ScheduledTask -TaskName $boot -TaskPath",registration);
  const reReadUser=install.indexOf("'$userTask=Get-ScheduledTask -TaskName $user -TaskPath",readback);
  const identity=install.indexOf('hubBootRegisteredTaskIdentityGuard',reReadUser);
  const marker=install.indexOf('hubBootRollbackTaskOwnershipGuard',identity);
  const stateRace=install.indexOf('HUB_USER_TASK_STATE_RACE',marker);
  const stopUser=install.indexOf('Stop-ScheduledTask -TaskName $user',registration);
  const startBoot=install.indexOf('Start-ScheduledTask -TaskName $boot',stopUser);
  assert.ok(registration>=0 && registration<readback && readback<reReadUser &&
    reReadUser<identity && identity<marker && marker<stateRace &&
    stateRace<stopUser && stopUser<startBoot,
    'Re-read BOTH task identities and user task state before any user-Hub handoff');
});
