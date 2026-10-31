import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(
  new URL('../native/task-os-sandbox-windows-token-job-readback-p07.c', import.meta.url),
  'utf8',
);

test('AI-07 Windows native diagnostic rejects arbitrary task execution', () => {
  for (const marker of ['--selftest-only', 'NW07_SOURCE_ONLY_NO_TASK_EXEC',
    'NW07_WINDOWS_BOUNDARY_NOT_PROVEN', 'NOT_PRODUCTION_ACCEPTANCE']) {
    assert.ok(source.includes(marker), marker);
  }
  const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
  for (const forbidden of [
    'CreateProcess', 'CreateProcessAsUser', 'CreateProcessWithToken',
    'ShellExecute', 'WinExec', 'system(', '_popen(', 'DuplicateTokenEx(',
    'SetTokenInformation(', 'SetInformationJobObject(', 'AssignProcessToJobObject(',
    'CreateService(', 'OpenSCManager(', 'AdjustTokenPrivileges(',
  ]) assert.ok(!code.includes(forbidden), 'Forbidden execution/mutation API: '+forbidden);
});

test('AI-07 Windows probe reads effective token/Job/PID and fails closed', () => {
  for (const api of ['OpenProcessToken(', 'GetTokenInformation(',
    'TokenIsAppContainer', 'TokenIntegrityLevel', 'TokenElevation',
    'IsProcessInJob(', 'QueryInformationJobObject(', 'GetProcessTimes(',
    'JOB_OBJECT_LIMIT_BREAKAWAY_OK', 'JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK',
    'SECURITY_MANDATORY_LOW_RID', 'TokenType', 'TokenPrimary',
    'TokenAppContainerSid', 'TokenUIAccess', 'read_appcontainer_sid(token)',
    'JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE']) assert.ok(source.includes(api), api);
  assert.match(source, /if\s*\(!token_ok\s*\|\|\s*elevated\s*!=\s*0/);
  assert.match(source, /if\s*\(argc\s*!=\s*2\s*\|\|\s*strcmp/);
  assert.doesNotMatch(source, /NW07_(?:PERMIT|PRODUCTION_READY|EXECUTE_ALLOWED)/);
  assert.match(source, /#pragma comment\(lib, "Advapi32\.lib"\)/);
  assert.match(source, /\(flags & JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE\) == 0/);
  assert.match(source, /uiaccess != 0/);
  assert.match(source, /info->TokenAppContainer != NULL && IsValidSid/);
});
