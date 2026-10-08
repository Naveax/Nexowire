import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { privilegedBrokerStatusScript } from '../src/agent/privileged-broker-lifecycle.js';

test(
  'Windows broker status handles Task Scheduler null next/last run timestamps',
  { skip: process.platform !== 'win32' },
  () => {
    const mockedTasks = String.raw`
$ErrorActionPreference='Stop'
$env:NEXOWIRE_BROKER_TASK_NAME='Nexowire Null Time Test'
function Get-ScheduledTask {
  param([string]$TaskName, [string]$ErrorAction)
  [pscustomobject]@{TaskName=$TaskName;State='Running'}
}
function Get-ScheduledTaskInfo {
  process {
    [pscustomobject]@{
      LastRunTime=$null
      NextRunTime=$null
      LastTaskResult=0
    }
  }
}
`;
    const run = spawnSync(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', mockedTasks + privilegedBrokerStatusScript],
      { encoding: 'utf8', windowsHide: true },
    );
    assert.equal(run.status, 0, run.stderr || run.stdout);
    const parsed = JSON.parse(run.stdout.trim()) as {
      installed: boolean;
      state: string;
      lastRunTime: string | null;
      nextRunTime: string | null;
    };
    assert.equal(parsed.installed, true);
    assert.equal(parsed.state, 'Running');
    assert.equal(parsed.lastRunTime, null);
    assert.equal(parsed.nextRunTime, null);
  },
);
