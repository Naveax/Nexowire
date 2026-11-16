import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {simulateDangerLabRequest, dangerLabStatus, DANGER_LAB_VERSION} from '../../src/agent/danger-lab.ts';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
test('all capability names are accepted in inert model only, without host effects', () => {
  for (const name of ['windows.task.control', 'shell.powershell', 'core.full', 'unknown.privileged.effect']) {
    const result=simulateDangerLabRequest(name, {command:'simulated', token:'secret fixture'});
    assert.equal(result.release,DANGER_LAB_VERSION);
    assert.equal(result.capability,name);
    assert.equal(result.decision,'SIMULATED_ALLOW');
    assert.equal(result.authenticated,false);
    assert.equal(result.executed,false);
    assert.equal(result.hostEffects,false);
    assert.equal(result.fullCoreAccessVerified,false);
    assert.equal(result.networkListenerCreated,false);
    assert.equal(result.payloadSha256.length,64);
    assert.doesNotMatch(JSON.stringify(result),/secret fixture/);
  }
});

test('model cannot be used as an unbounded data channel', () => {
  for (const name of ['', 'x'.repeat(129), 'line\nbreak']) {
    assert.throws(()=>simulateDangerLabRequest(name,null),/DANGER_LAB_CAPABILITY_INVALID/);
  }
  assert.throws(()=>simulateDangerLabRequest('shell',{'big':'x'.repeat(17000)}),/DANGER_LAB_PAYLOAD_TOO_LARGE/);
  assert.throws(()=>simulateDangerLabRequest('shell',undefined),/DANGER_LAB_PAYLOAD_NOT_JSON/);
});

test('danger-lab status never advertises real privilege elevation', () => {
  const status=dangerLabStatus();
  assert.equal(status.simulatedSecurityGates,'OFF_IN_MODEL_ONLY');
  assert.equal(status.actualSecurityGates,'UNCHANGED');
  assert.equal(status.networkListenerCreated,false);
  assert.equal(status.physicalCoreActivated,false);
  assert.equal(status.hostEffectsAllowed,false);
});

test('isolated model has no imports or dynamic references to side-effectful executors', () => {
  const content=readFileSync(path.join(root,'src/agent/danger-lab.ts'),'utf8');
  assert.doesNotMatch(content,/\b(?:fetch|spawn|exec|execFile|listen|createServer|writeFile|Register-ScheduledTask)\s*\(/);
  assert.doesNotMatch(content,/from ['"](?:node:(?:child_process|http|net|fs)|\.\/privileged-broker|\.\/native-agent|\.\/executors)/);
  assert.doesNotMatch(content,/\bimport\s*\(/);
});
