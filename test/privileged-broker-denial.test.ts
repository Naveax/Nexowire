import test from 'node:test';
import assert from 'node:assert/strict';
import {
  explainPrivilegedBrokerDenial,
  PrivilegedBrokerModeDeniedError,
} from '../src/agent/privileged-broker-denial.js';

test('broker denials distinguish owner approval, Windows token, and task integrity',()=>{
  const samples=[
    ['BROKER_MODE_CONFIRMATION_REQUIRED','BROKER_OWNER_CONFIRMATION_REQUIRED','owner'],
    ['BROKER_MODE_LOCAL_ELEVATION_REQUIRED','BROKER_WINDOWS_ELEVATION_REQUIRED','windows-token'],
    ['Access is denied','BROKER_OS_ACCESS_DENIED_UNATTRIBUTED','unknown'],
    ['BROKER_TASK_OWNER_MISMATCH','BROKER_CANONICAL_TASK_REQUIRED','task-identity'],
    ['PRIVILEGED_BROKER_ACL_UNTRUSTED','BROKER_PROTECTED_SOURCE_REQUIRED','source-integrity'],
    ['BROKER_MODE_OFF_NOT_VERIFIED','BROKER_TASK_TRANSITION_UNVERIFIED','task-postcondition'],
    ['BROKER_MODE_INVALID','BROKER_MODE_INVALID','input'],
  ] as const;
  for(const [input,code,boundary] of samples){
    const explanation=explainPrivilegedBrokerDenial(new Error(input));
    assert.equal(explanation.code,code);
    assert.equal(explanation.boundary,boundary);
    assert.ok(explanation.requiredPermission.length>5);
    assert.ok(explanation.safeNextAction.length>20);
    assert.equal(explanation.retrySafe,false);
    assert.equal(explanation.elevatedFallbackAllowed,false);
  }
});

test('unrecognized raw PowerShell details are redacted, not turned into a success or retry',()=>{
  const privateText='unrecognized failure C:\\Users\\secret\\some-key.txt MY_SECRET=abc';
  const explanation=explainPrivilegedBrokerDenial(new Error(privateText));
  const error=new PrivilegedBrokerModeDeniedError(new Error(privateText));
  assert.equal(explanation.code,'BROKER_ACCESS_FAILURE_UNCLASSIFIED');
  assert.equal(error.code,'BROKER_ACCESS_FAILURE_UNCLASSIFIED');
  assert.equal(error.authorizationExplain.elevatedFallbackAllowed,false);
  assert.equal(error.authorizationExplain.retrySafe,false);
  assert.doesNotMatch(JSON.stringify(error.authorizationExplain),/MY_SECRET|abc|some-key/);
  assert.doesNotMatch(error.message,/MY_SECRET|abc|some-key/);
});
