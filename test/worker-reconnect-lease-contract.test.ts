import test from 'node:test';
import assert from 'node:assert/strict';
import {
  reviewWorkerLeaseReconnect,
  type WorkerMutationIdentity,
  type WorkerLeaseCheckpoint,
  type WorkerAuthorityReadback,
} from '../src/coding/worker-reconnect-lease-contract.js';
const id: WorkerMutationIdentity = Object.freeze({
  ownerAccountId:'tenant-a', deviceId:'device-a',
  deviceSignerSpkiSha256:'a'.repeat(64), ownerEpoch:7, oauthSessionEpoch:9,
  pairingEpoch:4, issuerEpoch:3, taskId:'task-1',worktreeId:'wt-1',
  sourceSha:'b'.repeat(40), stepId:'step-1',
  logicalMutationId:'logical-a',originalRequestId:'request-a',
});
const cp: WorkerLeaseCheckpoint = {
  identity:id, leaseId:'lease-1', localSessionId:'session-1',
  connectionEpoch:2, wssSessionGeneration:12, expiresAtMs:1000,
  mutationState:'not_sent',
};
const current: WorkerAuthorityReadback = {
  ownerAccountId:id.ownerAccountId,deviceId:id.deviceId,
  deviceSignerSpkiSha256:id.deviceSignerSpkiSha256,
  ownerEpoch:id.ownerEpoch,oauthSessionEpoch:id.oauthSessionEpoch,
  pairingEpoch:id.pairingEpoch,issuerEpoch:id.issuerEpoch,
  localSessionId:cp.localSessionId,connectionEpoch:cp.connectionEpoch,
  wssSessionGeneration:cp.wssSessionGeneration,
  online:true,oauthActive:true,ownerRevoked:false,pairingRevoked:false,
  leaseRevoked:false,readbackVerified:true,
};
function check(changes: {
  checkpoint?: Partial<WorkerLeaseCheckpoint>;
  attemptedIdentity?: Partial<WorkerMutationIdentity>;
  current?: Partial<WorkerAuthorityReadback> | null;
  nowMs?: number;
} = {}) {
  return reviewWorkerLeaseReconnect({
    checkpoint:{...cp,...changes.checkpoint},
    attemptedIdentity:{...id,...changes.attemptedIdentity},
    ...(changes.current===null ? {} : {current:{...current,...changes.current}}),
    nowMs:changes.nowMs??100,
  });
}
function deny(reason: string, actual: ReturnType<typeof check>) {
  assert.equal(actual.reason,reason);
  assert.equal(actual.mayDispatch,false);
  assert.equal(actual.mayReplayMutation,false);
  assert.equal(actual.mayLaunchNativeTool,false);
}

test('even same-session, intact NOT_SENT is BLOCKED without real independent CAS',()=> {
  deny('BLOCKED_EXTERNAL_CAS_UNAVAILABLE',check());
});
test('reconnect creates a distinct local session, not another logical mutation',()=> {
  const result=check({current:{localSessionId:'session-2',connectionEpoch:3,wssSessionGeneration:13}});
  deny('RECONNECT_REQUIRES_NEW_EXTERNAL_COMMIT',result);
  assert.equal(result.originalLogicalMutationId,id.logicalMutationId);
  assert.equal(result.originalRequestId,id.originalRequestId);
});
test('lost OS ACK and delayed ACK after new WSS are never replayed',()=> {
  for (const mutationState of ['dispatch_pending','ack_lost','journal_unknown'] as const){
    deny('RECONCILE_REQUIRED',check({checkpoint:{mutationState},current:{localSessionId:'session-new',connectionEpoch:3,wssSessionGeneration:13}}));
  }
});
test('cloned task, changed Git SHA, worktree, step, logical ID, request ID all deny',()=> {
  const changes: Partial<WorkerMutationIdentity>[]=[
    {taskId:'task-clone'},{worktreeId:'wt-clone'},{sourceSha:'c'.repeat(40)},
    {stepId:'step-2'},{logicalMutationId:'logical-b'},{originalRequestId:'request-b'},
    {deviceId:'device-b'},{ownerAccountId:'tenant-b'},
  ];
  for (const attemptedIdentity of changes)
    deny('IMMUTABLE_MUTATION_IDENTITY_CHANGED',check({attemptedIdentity}));
});
test('owner epoch, OAuth logout generation, pairing revision and signer rotation deny',()=> {
  for(const currentChange of [
    {ownerEpoch:8},{oauthSessionEpoch:10},{pairingEpoch:5},
    {issuerEpoch:4},{deviceSignerSpkiSha256:'c'.repeat(64)},
    {deviceId:'device-b'}, {ownerAccountId:'tenant-b'},
  ]) deny('OWNER_DEVICE_AUTHORITY_CHANGED',check({current:currentChange}));
});
test('revocation / OAuth logout deny even with a cached valid-looking snapshot',()=> {
  for(const change of [{oauthActive:false},{ownerRevoked:true},{pairingRevoked:true},{leaseRevoked:true}])
    deny('OWNER_LOGOUT_OR_REVOCATION',check({current:change}));
});
test('offline and forged/non-verified authority readback fail closed',()=> {
  for(const change of [{online:false},{readbackVerified:false},{connectionEpoch:-1},{localSessionId:''}])
    deny('OFFLINE_OR_UNVERIFIED_READBACK',check({current:change}));
  assert.equal(reviewWorkerLeaseReconnect({checkpoint:cp,attemptedIdentity:id,nowMs:100}).mayDispatch,false);
});
test('expired lease and clock nonsense cannot resurrect dispatch',()=> {
  deny('EXPIRED_LEASE',check({nowMs:1000}));
  deny('INVALID_OR_MISSING_PROVENANCE',check({nowMs:Number.NaN}));
  deny('INVALID_OR_MISSING_PROVENANCE',check({checkpoint:{expiresAtMs:Number.POSITIVE_INFINITY}}));
});
test('invalid signer hash/source SHA and partial logical identity reject',()=> {
  for(const attemptedIdentity of [{sourceSha:'bad'},{deviceSignerSpkiSha256:'bad'},{logicalMutationId:''}])
    deny('INVALID_OR_MISSING_PROVENANCE',check({attemptedIdentity}));
});
test('unknown stays UNKNOWN after renewal even if authority claims a fully new live session',()=> {
  const first=check({checkpoint:{mutationState:'ack_lost'}, current:{localSessionId:'session-2',connectionEpoch:3}});
  const second=check({checkpoint:{mutationState:'ack_lost'}, current:{localSessionId:'session-3',connectionEpoch:4}});
  assert.equal(first.state,'RECONCILE_REQUIRED');
  assert.deepEqual(first,second);
});
