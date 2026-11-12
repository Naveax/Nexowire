'use strict';
// Controlled local test only: no network, crypto exchange, GPU or production work.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const [root, mode, runId, sessionId] = process.argv.slice(2);
if (!root || !['complete', 'false_progress', 'tampered', 'failed', 'gpu_silent'].includes(mode) ||
    !runId || !sessionId) process.exit(2);
fs.mkdirSync(path.join(root, 'results'), {recursive:true});
const outcomes = mode === 'gpu_silent' ? [] :
  mode === 'false_progress' ? ['completed'] :
  mode === 'failed' ? ['completed', 'failed'] : ['completed', 'completed'];
const artifacts = [];
const digestEntries = [];
for (let i = 0; i < outcomes.length; i++) {
  const itemId = 'unit-' + i;
  const filename = itemId + '.json';
  const content = Buffer.from(JSON.stringify({
    schemaVersion: 1, runId, itemId, outcome: outcomes[i], payload: {result: i * 7},
  }));
  fs.writeFileSync(path.join(root, 'results', filename), content);
  const sha256 = createHash('sha256').update(content).digest('hex');
  artifacts.push({itemId, filename, sha256});
  digestEntries.push({itemId, outcome: outcomes[i], sha256});
}
fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({
  schemaVersion: 1, scope: {
    ownerAccountId: 'owner-fixture', deviceId: 'device-fixture',
    projectId: 'project-fixture', runId, sessionId,
  }, expectedCount: 2,
  sealed: mode === 'complete' || mode === 'failed' || mode === 'tampered',
  artifacts,
}));
if (mode === 'tampered') {
  fs.appendFileSync(path.join(root, 'results', artifacts[0].filename), 'TAMPER');
}
const digest = createHash('sha256').update('NEXOWIRE_RESULT_SET_V1\n');
for (const e of digestEntries) digest.update(JSON.stringify([e.itemId,e.outcome,e.sha256]) + '\n');
const fake = mode === 'false_progress';
const claimed = {
  completed_count: fake ? 2 : outcomes.filter(x => x === 'completed').length,
  pending_count: fake ? 0 : 2 - outcomes.length,
  failure_count: outcomes.filter(x => x === 'failed').length,
  result_artifact_sha256: digest.digest('hex'),
};
if (mode === 'gpu_silent') claimed.diagnosis = 'gpu_saturated';
process.stdout.write('NEXOWIRE_PROGRESS_V1 ' + JSON.stringify(claimed) + '\n');
