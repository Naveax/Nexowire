import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ArtifactBridgeStore, ArtifactBridgeError, type ArtifactScope } from '../src/workspace/artifact-bridge.js';
import { WorkspaceStore } from '../src/workspace/store.js';
import { ArtifactCheckpointAdapter } from '../src/workspace/artifact-checkpoint-adapter.js';

const digest = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const expect = (value: unknown, message: string) => { if (!value) throw new Error('ACCEPTANCE_FAILED: ' + message); };
const sourceA = process.env.NEXOWIRE_ACCEPTANCE_WORKPC_FILE;
const sourceB = process.env.NEXOWIRE_ACCEPTANCE_NAVEAX_FILE;
const target = process.env.NEXOWIRE_ACCEPTANCE_TARGET;
if (!sourceA || !sourceB || !target) throw new Error('Three explicit synthetic lab file paths are required.');
// Fail closed: only create a NEW target. Never delete or overwrite existing user files.
await fs.mkdir(target, { recursive: false });
const root = path.join(target, 'hub-state');
const store = new ArtifactBridgeStore(root);
const workspaces = new WorkspaceStore(root);
const adapter = new ArtifactCheckpointAdapter(workspaces, store);
const accountId = 'synthetic-account-artifact-acceptance-20261018';
const commitSha = '340494f49ad52277cddf09cbf71d7b6bb5d9b661';
const witnesses: Array<{ deviceId: string; path: string; bytes: Buffer; sha256: string }> = [];
for (const [deviceId, sourcePath] of [['work-pc', sourceA], ['Naveax', sourceB]] as const) {
  const bytes = await fs.readFile(sourcePath);
  expect(bytes.length > 1000 && bytes.length <= 1000000, 'Source fixture must be bounded and synthetic.');
  witnesses.push({ deviceId, path: sourcePath, bytes, sha256: digest(bytes) });
}
expect(witnesses[0]!.sha256 !== witnesses[1]!.sha256, 'Identically named fixtures must hold different content.');
const results: Record<string, unknown> = {
  scope: 'synthetic-owner/project/origin-device', mergedRepositorySha: commitSha,
  evidenceType: 'physical Agent file transfer followed by isolated source-code Hub ingestion',
  explicitLimit: 'Not a hosted Hub runtime deployment or WAN TLS attestation',
};
for (const witness of witnesses) {
  const scope: ArtifactScope = { accountId, projectId: 'Nexowire', deviceId: witness.deviceId };
  const descriptor = {
    scope, artifactPath: 'results/same-name.bin', repository: 'Naveax/Nexowire',
    commitSha, producerOperationId: 'synthetic:physical-transfer',
    size: witness.bytes.length, sha256: witness.sha256,
    testStatus: 'unverified' as const, acceptanceStatus: 'pending' as const,
  };
  const begin = await store.begin(descriptor);
  expect(begin.state === 'OPEN' && begin.sessionId, 'Expected open session.');
  const id = begin.sessionId!;
  const firstLength = Math.min(32766, witness.bytes.length);
  const first = witness.bytes.subarray(0, firstLength);
  await store.putChunk(scope, id, 0, first.toString('base64'));
  const restart = new ArtifactBridgeStore(root);
  const resumed = await restart.begin(descriptor);
  expect(resumed.offset === firstLength && resumed.sessionId === id, 'Resume offset or session was not stable.');
  const replay = await restart.putChunk(scope, id, 0, first.toString('base64'));
  expect(replay.state === 'ALREADY_WRITTEN', 'Chunk replay was not idempotent.');
  let rejectedGap = false;
  try { await restart.putChunk(scope, id, firstLength + 1, Buffer.from('x').toString('base64')); }
  catch (e) { rejectedGap = e instanceof ArtifactBridgeError && e.code === 'OFFSET_MISMATCH'; }
  expect(rejectedGap, 'Sparse/future offset must be denied.');
  await restart.putChunk(scope, id, firstLength,
    witness.bytes.subarray(firstLength).toString('base64'));
  const final = await restart.commit(scope, id);
  expect(final.sha256 === witness.sha256, 'Committed SHA-256 mismatch.');
  const wrongProject = await restart.get({ ...scope, projectId: 'OtherProject' }, descriptor.artifactPath);
  expect(wrongProject === null, 'Wrong project must not access manifest.');
  const wrongDevice = await restart.get({ ...scope, deviceId: 'third-device' }, descriptor.artifactPath);
  expect(wrongDevice === null, 'Wrong device must not access manifest.');
  const checkpointId = 'synthetic-' + witness.deviceId;
  await workspaces.save({
    deviceId: witness.deviceId, workspaceId: checkpointId,
    summary: 'Synthetic physical transfer proof ' + witness.sha256,
    completed: ['SHA-256 verified'], remaining: ['Hosted Hub production acceptance'],
    lastCommands: ['artifact_bridge_ingest_device_file'],
  });
  await adapter.importLegacy({
    scope, workspaceId: checkpointId, repository: 'Naveax/Nexowire',
    commitSha, artifactPaths: [descriptor.artifactPath],
  });
  const independent = new ArtifactCheckpointAdapter(new WorkspaceStore(root), new ArtifactBridgeStore(root));
  const recovered = await independent.get(scope, checkpointId);
  expect(recovered?.artifacts[0]?.sha256 === witness.sha256,
    'Another store instance could not retrieve pinned checkpoint.');
  results[witness.deviceId] = {
    size: witness.bytes.length, sha256: witness.sha256, resumedOffset: resumed.offset,
    duplicateChunk: replay.state, futureOffsetDenied: rejectedGap,
    correctScope: true, wrongProjectDenied: true, wrongDeviceDenied: true,
    checkpointRetrievedFromNewInstance: true,
  };
}
const scopeA: ArtifactScope = { accountId, projectId: 'Nexowire', deviceId: 'work-pc' };
const old = witnesses[0]!;
const modified = Buffer.from(old.bytes);
modified[0] = modified[0]! ^ 0xff;
const nextHash = digest(modified);
let rejectedCAS = false;
try {
  await store.begin({ scope: scopeA, artifactPath: 'results/same-name.bin',
    repository: 'Naveax/Nexowire', commitSha,
    producerOperationId: 'synthetic:cas-replace', size: modified.length, sha256: nextHash,
    testStatus: 'unverified', acceptanceStatus: 'pending',
    expectedPreviousSha256: 'f'.repeat(64),
  });
} catch (e) { rejectedCAS = e instanceof ArtifactBridgeError && e.code === 'COMPARE_AND_SWAP_FAILED'; }
expect(rejectedCAS, 'Incorrect previous digest must not replace existing artifact.');
const acceptedCAS = await store.begin({
  scope: scopeA, artifactPath: 'results/same-name.bin', repository: 'Naveax/Nexowire',
  commitSha, producerOperationId: 'synthetic:cas-replace', size: modified.length,
  sha256: nextHash, testStatus: 'unverified', acceptanceStatus: 'pending',
  expectedPreviousSha256: old.sha256,
});
expect(acceptedCAS.state === 'OPEN' && acceptedCAS.sessionId, 'Expected valid CAS session.');
let changedCheckpointDenied = false;
for (let offset = 0; offset < modified.length; offset += 65536) { await store.putChunk(scopeA, acceptedCAS.sessionId!, offset, modified.subarray(offset, offset + 65536).toString('base64')); }
await store.commit(scopeA, acceptedCAS.sessionId!);
try { await adapter.get(scopeA, 'synthetic-work-pc'); }
catch (e) { changedCheckpointDenied = e instanceof ArtifactBridgeError &&
  e.code === 'CHECKPOINT_ARTIFACT_CHANGED'; }
expect(changedCheckpointDenied, 'Old checkpoint must detect replacement of pinned manifest.');
results.cas = { staleExpectedRejected: rejectedCAS, matchingExpectedAccepted: true,
  oldCheckpointStaleDetected: changedCheckpointDenied,
  previousSha256: old.sha256, replacementSha256: nextHash };
const report = path.join(target, 'artifact-acceptance-evidence.json');
const handle = await fs.open(report, 'wx', 0o600);
try { await handle.writeFile(JSON.stringify(results, null, 2) + '\n'); await handle.sync(); }
finally { await handle.close(); }
console.log(JSON.stringify({ ok: true, report,
  originalHashWorkPc: witnesses[0]!.sha256, originalHashNaveax: witnesses[1]!.sha256,
  evidenceSha256: digest(Buffer.from(await fs.readFile(report))) }));
