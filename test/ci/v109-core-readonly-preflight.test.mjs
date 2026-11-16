import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const script = readFileSync(
  path.join(root, 'scripts/Read-Nexowire-V109CoreReadiness.ps1'), 'utf8',
);

test('physical CORE observer uses read-only scheduled-task and loopback queries', () => {
  assert.match(script, /Get-ScheduledTask -TaskName/);
  assert.match(script, /Get-ScheduledTaskInfo/);
  assert.match(script, /Get-NetTCPConnection/);
  for (const forbidden of [
    /\bRegister-ScheduledTask\b/i, /\bUnregister-ScheduledTask\b/i,
    /\bSet-ScheduledTask\b/i, /\bStart-ScheduledTask\b/i,
    /\bStop-ScheduledTask\b/i, /\bSet-Acl\b/i,
    /\bRemove-Item\b/i, /\bRestart-Computer\b/i,
    /\bStart-Process\b/i, /\bInvoke-RestMethod\b/i,
    /\breadExistingPrivilegedBrokerToken\b/i,
  ]) assert.doesNotMatch(script, forbidden);
});

test('read-only preflight never mistakes a running task for CORE verification', () => {
  assert.match(script, /fullCoreAccessVerified = \$false/);
  assert.match(script, /brokerAuthenticatedEffectAcceptance = 'NOT_RUN'/);
  assert.match(script, /protectedSqliteAndDpapiAcceptance = 'NOT_RUN'/);
  assert.match(script, /revocationAndNoReplayAcceptance = 'NOT_RUN'/);
});
