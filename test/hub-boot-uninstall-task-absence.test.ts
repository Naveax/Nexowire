import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {uninstallHubBootLifecycle} from '../src/hub/hub-boot-lifecycle.js';

const source=readFileSync(new URL('../src/hub/hub-boot-lifecycle.ts',import.meta.url),'utf8');

test('standalone uninstall always preserves tasks and state for coordinated recovery',async()=>{
  // Call the real production entrypoint. It must reject before scheduler,
  // filesystem or elevation access on every platform.
  for(const options of [
    {},
    {cutoverInstallMarker:'Nexowire pre-logon Hub install 00000000-0000-4000-8000-000000000000'},
    {env:{NEXOWIRE_STATE_DIR:'synthetic-untrusted-state'}},
  ])await assert.rejects(()=>uninstallHubBootLifecycle(options),/HUB_BOOT_UNINSTALL_COORDINATED_RECOVERY_REQUIRED/);
  await assert.rejects(()=>uninstallHubBootLifecycle({bootTaskName:'Foreign Boot'}),/HUB_BOOT_NONCANONICAL_TASK_DENIED/);
});

test('direct uninstall has no task or file effect path even when the task appears absent',()=>{
  const start=source.indexOf('export async function uninstallHubBootLifecycle(');
  const end=source.indexOf('export interface WindowsRebootAgentTaskEvidence',start);
  assert.ok(start>=0&&end>start);
  const uninstall=source.slice(start,end);
  assert.match(uninstall,/HUB_BOOT_UNINSTALL_COORDINATED_RECOVERY_REQUIRED/);
  assert.doesNotMatch(uninstall,/runPowerShellJson|fs\.|(?:Stop|Start|Enable|Disable|Register|Unregister)-ScheduledTask/);
  const cli=source.slice(source.indexOf('export async function runHubBootLifecycleCommand('));
  assert.match(cli,/case 'boot-uninstall':[\s\S]*await uninstallHubBootLifecycle\(options\)/);
});
