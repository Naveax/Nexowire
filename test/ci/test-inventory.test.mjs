import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync, spawnSync} from 'node:child_process';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseGitStageEntries, parseGitCommitTreeEntries, summarizeTestFiles, readTestInventory} from '../../scripts/ci/test-inventory.mjs';

const BLOB = 'a'.repeat(40);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const item = (file, mode = '100644') => mode + ' ' + BLOB + ' 0\t' + file + '\0';

test('stable test inventory includes root, one-directory, and deep tracked test files', () => {
  const entries = parseGitStageEntries(Buffer.from(
    item('test/z/b/c.test.ts') + item('test/top.test.ts') + item('test/z/a.test.ts') +
    item('test/misc/readme.md')
  ));
  assert.deepEqual(entries.map(x => x.path),[
    'test/top.test.ts','test/z/a.test.ts','test/z/b/c.test.ts',
  ]);
  const report = summarizeTestFiles(entries, 'b'.repeat(40));
  assert.deepEqual(report.byDepth,{root:1,oneDirectory:1,deeper:1});
  assert.equal(report.trackedTsTestFiles,3);
  assert.equal(report.legacyBashGlob.matchedWithoutGlobstar,1);
  assert.equal(report.legacyBashGlob.omittedWithoutGlobstar,2);
  assert.equal(report.physicalWindowsAcceptance,'NOT_INFERRED');
  assert.equal(report.manifestSha256.length,64);
  assert.deepEqual(
    parseGitStageEntries(Buffer.from(item('test/z/a.test.ts') + item('test/top.test.ts') + item('test/z/b/c.test.ts'))),
    entries
  );
});

test('rejects duplicate entries, unsafe paths, symlink tests, unmerged entries and an empty candidate', () => {
  for (const bad of [
    item('test/a.test.ts') + item('test/a.test.ts'),
    item('test/../escape.test.ts'),
    item('test/evil\\path.test.ts'),
    item('test/a.test.ts','120000'),
    '100644 ' + BLOB + ' 2\ttest/a.test.ts\0',
    'garbage\0',
  ]) {
    assert.throws(() => parseGitStageEntries(Buffer.from(bad)), /TEST_INVENTORY_/);
  }
  assert.throws(() => summarizeTestFiles([], 'b'.repeat(40)), /EMPTY_OR_UNPINNED/);
  assert.throws(() => summarizeTestFiles([{path:'test/a.test.ts',blob:BLOB,mode:'100644'}], 'bad'),
    /EMPTY_OR_UNPINNED/);
});

test('immutable Git HEAD inventory rejects staged or uncommitted test edits',()=>{
  const repo=mkdtempSync(path.join(os.tmpdir(),'nx-test-inventory-source-'));
  const call=(...args)=>execFileSync('git',args,{
    cwd:repo,encoding:'utf8',maxBuffer:1024*1024,
  });
  try {
    mkdirSync(path.join(repo,'test'));
    writeFileSync(path.join(repo,'test','sample.test.ts'),"export const n = 1;\n");
    call('init','-q');
    call('add','--','test/sample.test.ts');
    call('-c','user.name=Nexowire QA','-c','user.email=qa@example.invalid',
      'commit','-qm','synthetic committed test fixture');
    const {report:committed}=readTestInventory(repo);
    assert.equal(committed.trackedTsTestFiles,1);
    assert.match(committed.commitSha,/^[a-f0-9]{40}$/);

    // A changed checkout cannot inherit the committed test SHA even without staging.
    writeFileSync(path.join(repo,'test','sample.test.ts'),"export const n = 2;\n");
    assert.throws(()=>readTestInventory(repo),/TEST_INVENTORY_TRACKED_TEST_WORKTREE_DIRTY/);

    // A staged edit must also fail: the index blob is not the HEAD tree blob.
    call('add','--','test/sample.test.ts');
    assert.throws(()=>readTestInventory(repo),/TEST_INVENTORY_INDEX_HEAD_TREE_MISMATCH/);

    call('restore','--staged','--worktree','--','test/sample.test.ts');
    assert.deepEqual(readTestInventory(repo).report,committed);
  }finally{
    rmSync(repo,{recursive:true,force:true,maxRetries:5,retryDelay:100});
  }
});

test('commit tree parser fails closed on symlink, duplicate and malformed Git records',()=>{
  const t=(file,mode='100644')=>mode+' blob '+BLOB+'\t'+file+'\0';
  assert.deepEqual(parseGitCommitTreeEntries(Buffer.from(t('test/a.test.ts'))),[
    {path:'test/a.test.ts',mode:'100644',blob:BLOB},
  ]);
  for(const bad of [
    t('test/a.test.ts')+t('test/a.test.ts'),
    t('test/../outside.test.ts'),
    t('test/a.test.ts','120000'),
    'garbage\0',
  ])assert.throws(()=>parseGitCommitTreeEntries(Buffer.from(bad)),/TEST_INVENTORY_/);
});

test('CLI explicitly denies a false all-tests-covered claim and emits a complete path list', () => {
  const bin = path.join(ROOT,'scripts/ci/test-inventory.mjs');
  const denied = spawnSync(process.execPath,[bin,'--assert-legacy-complete'],{
    cwd:ROOT,encoding:'utf8',timeout:10000,
  });
  assert.equal(denied.status,1);
  assert.match(denied.stderr,/TEST_INVENTORY_LEGACY_BASH_GLOB_INCOMPLETE_[1-9][0-9]*/);
  const listed = spawnSync(process.execPath,[bin,'--list'],{
    cwd:ROOT,encoding:'utf8',timeout:10000,
  });
  assert.equal(listed.status,0);
  const list = listed.stdout.trim().split(/\r?\n/);
  assert.equal(list.length,new Set(list).size);
  assert.ok(list.includes('test/hub-boot-hidden-task-visibility.test.ts'));
  assert.ok(list.length > 500);
});

test('read-only live inventory binds to exact commit tree and discovers every tracked TypeScript test', () => {
  const {entries,report} = readTestInventory(ROOT);
  assert.equal(report.commitSha,execFileSync('git',['rev-parse','HEAD'],{
    cwd:ROOT,encoding:'utf8',
  }).trim());
  assert.equal(entries.length, report.trackedTsTestFiles);
  assert.ok(report.byDepth.root > 0);
  assert.ok(report.byDepth.oneDirectory > 0);
  assert.ok(report.byDepth.deeper > 0);
  assert.ok(report.legacyBashGlob.omittedWithoutGlobstar > 0);
  assert.match(report.manifestSha256,/^[a-f0-9]{64}$/);
  const paths = entries.map(x => x.path);
  assert.equal(new Set(paths).size,paths.length);
  assert.ok(paths.includes('test/hub-boot-hidden-task-visibility.test.ts'));
  assert.ok(paths.includes('test/ci/assert-tap-summary.test.mjs') === false);
});
