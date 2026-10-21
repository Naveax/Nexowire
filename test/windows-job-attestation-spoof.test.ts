import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {ProcessManager} from '../src/agent/process-manager.js';
import {PathPolicy} from '../src/agent/path-policy.js';
import {verifyWindowsKernelJob} from '../src/agent/windows-job-kernel-attestation.js';

function guardianCommand(pid:number):string {
  const script="$p=Get-CimInstance Win32_Process -Filter 'ProcessId="+pid+
    "';if($p){$p.CommandLine}";
  return execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],
    {windowsHide:true,encoding:'utf8',timeout:8000}).trim();
}

test('fake NWJOB5 stdout and altered status cannot replace live kernel membership proof', {
  skip:process.platform!=='win32',timeout:35000,
},async()=>{
  const manager=new ProcessManager();
  // This synthetic root deliberately PRINTS a well-formed forged marker.
  // Its stdout must not be accepted as a Job proof or change the actual PID.
  const fake='NWJOB5 999999 133000000000000000 1234';
  const session=await manager.start({shell:'powershell',
    command:"Write-Output '"+fake+"'; Start-Sleep -Seconds 8"},
  new PathPolicy(['*']));
  try {
    assert.equal(session.treeOwnership,'windows_job');
    assert.ok(session.pid && session.jobGuardianPid);
    assert.notEqual(session.pid,999999);
    const cmd=guardianCommand(session.jobGuardianPid);
    const status=/--status\s+(?:"([^"]+)"|([^\s]+))\s+--cwd/.exec(cmd);
    assert.ok(status,'test must read only its own guardian marker path');
    const marker=(await readFile(status[1]??status[2]!,'utf8')).trim();
    const proof=/^NWJOB5 (\d+) (\d+) (\d+)$/.exec(marker);
    assert.ok(proof,'genuine native marker expected');
    assert.equal(Number(proof[1]),session.pid);
    await verifyWindowsKernelJob(session.pid,proof[2]!,session.jobGuardianPid,proof[3]!);

    const before=await manager.read({session_id:session.sessionId,wait_ms:1500});
    assert.ok(before.events.some(e=>e.stream==='stdout' && e.text.includes(fake)),
      'forged status line must remain mere user-process stdout data');

    await assert.rejects(
      ()=>verifyWindowsKernelJob(999999,proof[2]!,session.jobGuardianPid!,proof[3]!),
      /WINDOWS_JOB_KERNEL_ATTESTATION_FAILED/,
      'forged process PID cannot be accepted');
    const fakeTime=(BigInt(proof[2]!)+10000000n).toString();
    await assert.rejects(
      ()=>verifyWindowsKernelJob(session.pid!,fakeTime,session.jobGuardianPid!,proof[3]!),
      /WINDOWS_JOB_KERNEL_ATTESTATION_FAILED/,
      'same PID with forged FILETIME cannot be accepted');
    await assert.rejects(
      ()=>verifyWindowsKernelJob(session.pid!,proof[2]!,session.jobGuardianPid!,'999999999'),
      /WINDOWS_JOB_KERNEL_ATTESTATION_FAILED/,
      'forged guardian Job handle cannot be accepted');
  } finally {
    // Only the exact session created above is stopped.
    await manager.stop({session_id:session.sessionId}).catch(()=>undefined);
  }
});
