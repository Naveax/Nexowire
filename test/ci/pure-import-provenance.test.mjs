import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  attestPureImportProvenance,parseImports,tracePureGraph, PURE_ENTRYPOINTS,PURE_REVIEWED_FILES,
} from '../../scripts/ci/pure-import-provenance.mjs';
import {readTestInventory} from '../../scripts/ci/test-inventory.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const getSource=()=>Object.fromEntries(Object.keys(PURE_REVIEWED_FILES).map(f=>
  [f,readFileSync(path.join(root,...f.split('/')))]));
test('commit-pinned local import graph includes twenty-five reviewed suites and thirty source dependencies',()=>{
  const result=attestPureImportProvenance(root);
  assert.equal(result.sourceCommitSha,readTestInventory(root).report.commitSha);
  assert.equal(result.reviewedTestFileCount,25);
  assert.equal(result.reviewedDependencyFileCount,30);
  assert.equal(result.directAndTransitiveLocalSourceFiles.length,55);
  assert.deepEqual(result.externalPackagesReviewedAsDirectImports,
    ['node:assert/strict','node:crypto','node:test','zod']);
  assert.equal(result.physicalWindowsAcceptance,'NOT_INFERRED');
  assert.equal(result.externalPackageImplementationProvenance,'NOT_ATTESTED');
  assert.equal(result.runtimeDynamicCodeProvenance,'NOT_INFERRED');
  assert.deepEqual(tracePureGraph(getSource()).paths,
    Object.keys(PURE_REVIEWED_FILES).sort());
});
test('rejects source HEAD mismatch',()=>{
  assert.throws(()=>attestPureImportProvenance(root,'0'.repeat(40)),
    /PURE_IMPORT_PROVENANCE_EXPECTED_HEAD_SHA_MISMATCH/);
});
test('dynamic imports, require and eval are not statically approved',()=>{
  for(const text of [
    "import('./effects.js')",
    "require('./effects.js')",
    "eval('42')",
  ])assert.throws(()=>parseImports(text,'fixture.ts'),/DYNAMIC_IMPORT_OR_EVAL_DENIED/);
});
test('new local import cannot silently widen reviewed source graph',()=>{
  const s=getSource();
  s['test/agent-protocol.test.ts']=Buffer.concat([
    s['test/agent-protocol.test.ts'],Buffer.from("\nimport '../src/privileged-broker.js';\n")]);
  assert.throws(()=>tracePureGraph(s),/UNREVIEWED_LOCAL_IMPORT/);
});
test('unapproved external dependencies and extra unused files are rejected',()=>{
  const s=getSource();
  s['test/agent-protocol.test.ts']=Buffer.concat([
    s['test/agent-protocol.test.ts'],Buffer.from("\nimport 'child_process';\n")]);
  assert.throws(()=>tracePureGraph(s),/EXTERNAL_IMPORT_NOT_REVIEWED/);
  const extra=getSource();extra['src/unrelated.ts']=Buffer.from('export const x=1;');
  assert.throws(()=>tracePureGraph(extra),/UNUSED_REVIEWED_SOURCE/);
});
test('pure source audit requires exact CI HEAD and explicit JSON invocation',()=>{
  const script=path.join(root,'scripts/ci/pure-import-provenance.mjs');
  const env={...process.env,CI:'true'};
  delete env.NEXOWIRE_EXPECTED_COMMIT_SHA;
  let r=spawnSync(process.execPath,[script,'--json'],{
    cwd:root,env,encoding:'utf8',timeout:15000,maxBuffer:1024*1024,
  });
  assert.equal(r.status,1);
  assert.match(r.stderr,/EXPECTED_HEAD_SHA_REQUIRED_IN_CI/);
  r=spawnSync(process.execPath,[script,'--unsafe'],{
    cwd:root,encoding:'utf8',timeout:15000,maxBuffer:1024*1024,
  });
  assert.equal(r.status,1);
  assert.match(r.stderr,/PURE_IMPORT_PROVENANCE_USAGE/);
});
