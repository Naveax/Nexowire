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

test('uninstall validates saved restoration state and requires port release before removing SYSTEM task',()=>{
  const read=uninstall.indexOf("fs.readFile(p.manifest,'utf8')");
  const stop=uninstall.indexOf('Stop-ScheduledTask -TaskName $boot');
  const poll=uninstall.indexOf('Get-NetTCPConnection -State Listen -ErrorAction Stop',stop);
  const deny=uninstall.indexOf('HUB_BOOT_PORT_STILL_OWNED',poll);
  const unregister=uninstall.indexOf('Unregister-ScheduledTask -TaskName $boot',deny);
  const restore=uninstall.indexOf('if($userTask -and $expectedLegacyState',unregister);
  assert.ok(read>=0 && read<stop && stop<poll && poll<deny && deny<unregister && unregister<restore);
  assert.match(uninstall,/userTaskPreviousState: z\.enum\(\['Running','Ready','Disabled','NotInstalled'\]\)/);
  assert.match(uninstall,/expectedLegacyState -eq 'Running'/);
});
