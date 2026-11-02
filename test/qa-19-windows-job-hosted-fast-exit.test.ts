import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {ProcessManager} from '../src/agent/process-manager.js';
import {PathPolicy} from '../src/agent/path-policy.js';
import {verifyWindowsKernelJob} from '../src/agent/windows-job-kernel-attestation.js';

// #19 is independent of the Windows Job native executable / #03 ownership.
// Nothing here elevates, touches an installed service, or targets an external PID.
const windowsOnly = process.platform !== 'win32';
const policy = () => new PathPolicy(['*']);

test('QA19 hosted Windows Job: 100 deterministic fast exits expose both pipes before terminal status', {
  skip: windowsOnly,
  timeout: 540_000,
}, async () => {
  const manager = new ProcessManager();

  // Deterministic stimuli, unique per cycle, with both possible write orders.
  // Order BETWEEN stdout and stderr is intentionally not asserted: two OS pipes
  // have no globally ordered interleaving. The required happens-before edge is
  // BOTH captured stream payloads -> observed terminal session status.
  for (let cycle = 0; cycle < 100; cycle++) {
    const token = 'NW19_EXIT_' + String(cycle).padStart(3, '0');
    const out = token + '_STDOUT';
    const err = token + '_STDERR';
    const reversed = cycle % 2 === 1;
    const command = reversed
      ? 'echo ' + err + ' 1>&2 & echo ' + out
      : 'echo ' + out + ' & echo ' + err + ' 1>&2';

    const session = await manager.start({shell: 'cmd', command}, policy());
    assert.equal(session.treeOwnership, 'windows_job', 'cycle ' + cycle);
    assert.equal(session.jobMembershipVerified, 'root_at_launch', 'cycle ' + cycle);
    assert.equal(session.descendantCoverage, 'job_members_only', 'cycle ' + cycle);
    assert.equal(session.outOfJobDescendants, 'unknown', 'cycle ' + cycle);

    let cursor = 0;
    let stdout = '';
    let stderr = '';
    let status: string = session.status;
    let terminalObserved = false;
    try {
      for (let poll = 0; poll < 80; poll++) {
        const read = await manager.read({
          session_id: session.sessionId,
          after_seq: cursor,
          wait_ms: 200,
        });
        for (const event of read.events) {
          assert.ok(event.seq > cursor,
            'replayed/non-monotonic event at cycle ' + cycle);
          cursor = event.seq;
          if (event.stream === 'stdout') stdout += event.text;
          else if (event.stream === 'stderr') stderr += event.text;
          else assert.fail('unexpected output stream at cycle ' + cycle);
        }
        assert.equal(read.nextSeq, cursor, 'cursor inconsistent: cycle ' + cycle);
        status = read.session.status;
        assert.notEqual(status, 'lost', 'lost ownership at cycle ' + cycle);
        assert.notEqual(status, 'orphaned',
          'unconfirmed root must not be silently reported completed: cycle ' + cycle);
        if (status === 'exited') {
          terminalObserved = true;
          assert.equal(stdout.split(out).length - 1, 1,
            'stdout lost or duplicated BEFORE exited, cycle ' + cycle);
          assert.equal(stderr.split(err).length - 1, 1,
            'stderr lost or duplicated BEFORE exited, cycle ' + cycle);
          assert.ok(read.session.exitedAt,
            'missing terminal timestamp, cycle ' + cycle);
          break;
        }
      }
      assert.equal(terminalObserved, true, 'bounded fast-exit timeout at cycle ' + cycle);

      // A separate post-terminal poll must never uncover trailing pipe data.
      // It is a read-only observation of this fixture's private session.
      await new Promise(resolve => setTimeout(resolve, 25));
      const after = await manager.read({
        session_id: session.sessionId, after_seq: cursor, wait_ms: 0,
      });
      assert.equal(after.session.status, 'exited', 'terminal regressed: cycle ' + cycle);
      assert.equal(after.events.length, 0,
        'late output after visible exited status: cycle ' + cycle);
    } finally {
      if (status === 'running' || status === 'orphaned') {
        // Cleanup is restricted to the freshly created ProcessManager session.
        await manager.stop({session_id: session.sessionId}).catch(() => undefined);
      }
    }
  }
});

test('QA19 hosted Windows Job: live PID/guardian/time must defeat crossed-owner spoofing', {
  skip: windowsOnly,
  timeout: 65_000,
}, async () => {
  const manager = new ProcessManager();
  // Long enough for proof checks; no external process or OS settings affected.
  const session = await manager.start({
    shell: 'powershell',
    command: "Write-Output 'NW19_PID_OWNER_FIXTURE'; Start-Sleep -Seconds 25",
  }, policy());
  let stopped = false;
  try {
    assert.equal(session.treeOwnership, 'windows_job');
    const root = session.pid;
    const guardian = session.jobGuardianPid;
    const ticks = session.processCreationFiletime;
    assert.ok(root && guardian && ticks, 'native identity proof required');
    assert.notEqual(root, guardian, 'root must not equal guardian');
    assert.notEqual(root, process.pid, 'fixture root must not be test runner');
    assert.notEqual(guardian, process.pid, 'fixture guardian must not be test runner');

    // OS-observed guardian command line is used solely to LOCATE the
    // per-fixture native marker, not as a trust decision by itself.
    const script = "$p=Get-CimInstance Win32_Process -Filter 'ProcessId=" +
      guardian + "'; if($p){ $p.CommandLine }";
    const commandLine = execFileSync('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      {windowsHide: true, encoding: 'utf8', timeout: 10_000}).trim();
    assert.match(commandLine, /windows-job-owner\.exe/i);
    const match = /--status\s+(?:"([^"]+)"|([^\s]+))\s+--cwd/.exec(commandLine);
    assert.ok(match, 'live native guardian status-path argument missing');
    const statusPath = match[1] ?? match[2]!;
    assert.equal(path.win32.basename(statusPath).toLowerCase(), 'assigned.txt');
    assert.match(path.win32.basename(path.win32.dirname(statusPath)), /^nexowire-job-/);
    const signedByNobody = (await readFile(statusPath, 'utf8')).trim();
    const proof = /^NWJOB5 (\d+) (\d+) (\d+)$/.exec(signedByNobody);
    assert.ok(proof, 'native marker expected, but marker alone is NOT authority');
    assert.equal(Number(proof[1]), root);
    assert.equal(proof[2], ticks);
    const handle = proof[3]!;

    // Only actual Win32 kernel membership and process creation time count.
    await verifyWindowsKernelJob(root, ticks, guardian, handle);
    await assert.rejects(
      () => verifyWindowsKernelJob(root, ticks, process.pid, handle),
      /WINDOWS_JOB_KERNEL_ATTESTATION_FAILED/,
      'same root/handle with different live process owner must fail');
    await assert.rejects(
      () => verifyWindowsKernelJob(process.pid, ticks, guardian, handle),
      /WINDOWS_JOB_KERNEL_ATTESTATION_FAILED/,
      'substituting the live test-runner PID must fail');
    await assert.rejects(
      () => verifyWindowsKernelJob(root,
        (BigInt(ticks) + 10_000_000n).toString(), guardian, handle),
      /WINDOWS_JOB_KERNEL_ATTESTATION_FAILED/,
      'stale/recycled PID creation FILETIME must fail');

    await manager.stop({session_id: session.sessionId});
    stopped = true;
    await assert.rejects(
      () => verifyWindowsKernelJob(root, ticks, guardian, handle),
      /WINDOWS_JOB_KERNEL_ATTESTATION_FAILED/,
      'a stopped synthetic guardian cannot be reused as authority');
  } finally {
    if (!stopped) {
      await manager.stop({session_id: session.sessionId}).catch(() => undefined);
    }
  }
});
