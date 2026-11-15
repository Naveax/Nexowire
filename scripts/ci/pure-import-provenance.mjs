/**
 * Read-only source and import provenance gate for eight independently reviewed,
 * pure-contract root suites. Does NOT approve any other tests.
 */
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFileSync,lstatSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import ts from 'typescript';
import {readTestInventory} from './test-inventory.mjs';
import {APPROVED_ROOT_TEST_FILES} from './portable-root-execution-receipt.mjs';

const EXPECTED=Object.freeze({
  'test/agent-protocol.test.ts':'6eeaec135201e8bb6a7ab08382098223b6e05747',
  'test/product-usage-policy.test.ts':'708d91d1f79c4a6f1be8d3c2b342fc6e01a83a37',
  'test/product-transport-policy.test.ts':'47fa693c290a7a57408bfa7d477cd1a982b26f14',
  'test/task-os-sandbox-policy-p07.test.ts':'387ce6e5351678d5c19afb5f293d2083d8d54829',
  'test/bridge-guardian-policy.test.ts':'e45398adeaa4b3840889027e532013e4f69aa23a',
  'test/product-pairing.test.ts':'1d2f8738bb4eebeac1094231644e496280f15492',
  'test/daily-quota-proposal.test.ts':'2f4abf418858d3bfd507d9e6f7593c18a767f455',
  'test/product-usage-ledger.test.ts':'970a9502cadd2e1df37839e866646fba471db8cc',
  'src/protocol/agent.ts':'6bd55d19f898021fd1e70e78045ddba656aaf4e5',
  'src/protocol/capabilities.ts':'5e92ce4db343bb4c1fda33d5da0603dfd35f4e84',
  'src/product/plans.ts':'9ac634f06f475d4c4ae9c12032ebda68e2b2ee04',
  'src/product/usage-policy.ts':'8bcc7539dbdb6ac85e080791306dd60432a59d7d',
  'src/product/transport-policy.ts':'ea0593dfc9bf29b6be40120cc4a1cb2a61f46788',
  'src/agent/task-os-sandbox-policy.ts':'a35e1b25d40b2a0d796dd9fdd51d7079370e6730',
  'src/agent/bridge-guardian-policy.ts':'61fc71fe63a4103b7028f7214f07e00c190fc812',
  'src/protocol/admin-bridge-intent.ts':'2b083e49d0612f0573790a4edf0d2594803d7a02',
  'src/product/pairing.ts':'7528c7902f5b63fce98187721325098a88735c5d',
  'src/product/daily-quota-proposal.ts':'779be3e17cdfe7c02edc8818b6acf257c1677084',
  'src/product/usage-ledger.ts':'0e1fd3e8c966ecc4743e3b949964d4e703f9e68c',
});
export const PURE_REVIEWED_FILES=EXPECTED;
export const PURE_ENTRYPOINTS=Object.freeze([
  'test/agent-protocol.test.ts',
  'test/product-usage-policy.test.ts',
  'test/product-transport-policy.test.ts',
  'test/task-os-sandbox-policy-p07.test.ts',
  'test/bridge-guardian-policy.test.ts',
  'test/product-pairing.test.ts',
  'test/daily-quota-proposal.test.ts',
  'test/product-usage-ledger.test.ts',
]);
const external=new Set(['node:test','node:assert/strict','node:crypto','zod']);
const SHA=/^[a-f0-9]{40}$/;
function deny(reason){throw new Error('PURE_IMPORT_PROVENANCE_'+reason)}
function blobHash(data) {
  const b=Buffer.isBuffer(data)?data:Buffer.from(data,'utf8');
  return createHash('sha1').update('blob '+b.length+'\0').update(b).digest('hex');
}
export function parseImports(source,pathName) {
  const tree=ts.createSourceFile(pathName,source.toString(),ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
  if(tree.parseDiagnostics.length)deny('PARSE_FAILED');
  const imports=[];
  for(const statement of tree.statements) {
    if(ts.isImportEqualsDeclaration(statement))deny('IMPORT_EQUALS_DENIED');
    if((ts.isImportDeclaration(statement)||ts.isExportDeclaration(statement))&&
       statement.moduleSpecifier){
      if(!ts.isStringLiteral(statement.moduleSpecifier))deny('NON_LITERAL_IMPORT');
      imports.push(statement.moduleSpecifier.text);
    }
  }
  function walk(node) {
    if(ts.isCallExpression(node) &&
       (node.expression.kind===ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression)&&['require','eval'].includes(node.expression.text))))
      deny('DYNAMIC_IMPORT_OR_EVAL_DENIED');
    ts.forEachChild(node,walk);
  }
  walk(tree);
  return [...new Set(imports)].sort();
}
export function tracePureGraph(sourceMap,starting=PURE_ENTRYPOINTS,allowed=external) {
  const visited=new Set(),imports=new Set(),stack=[...starting];
  while(stack.length){
    const f=stack.pop();
    if(visited.has(f))continue;
    if(!Object.hasOwn(sourceMap,f))deny('UNREVIEWED_LOCAL_FILE_'+f.replaceAll('/','_'));
    visited.add(f);
    for(const spec of parseImports(sourceMap[f],f)) {
      if(spec.startsWith('.')) {
        if(!spec.endsWith('.js'))deny('UNSUPPORTED_LOCAL_EXTENSION');
        const target=path.posix.normalize(path.posix.join(path.posix.dirname(f),spec.slice(0,-3)+'.ts'));
        if(target.startsWith('..')||target.startsWith('/')||!Object.hasOwn(sourceMap,target))
          deny('UNREVIEWED_LOCAL_IMPORT');
        stack.push(target);
      }else {
        if(!allowed.has(spec))deny('EXTERNAL_IMPORT_NOT_REVIEWED');
        imports.add(spec);
      }
    }
  }
  if(visited.size!==Object.keys(sourceMap).length)deny('UNUSED_REVIEWED_SOURCE');
  return {paths:[...visited].sort(),externalImports:[...imports].sort()};
}
function readGitEntries(root,paths,args,recordPattern) {
  const data=execFileSync('git',args,{cwd:root,encoding:'buffer',maxBuffer:2*1024*1024});
  const found=new Map();
  for(const record of data.toString('utf8').split('\0')) {
    if(!record)continue;
    const m=recordPattern.exec(record);
    if(!m)deny('INVALID_GIT_RECORD');
    const [,mode,blob,relative]=m;
    if(mode!=='100644'||!SHA.test(blob)||found.has(relative)||!paths.includes(relative))
      deny('UNTRUSTED_GIT_ENTRY');
    found.set(relative,blob);
  }
  if(found.size!==paths.length)deny('SOURCE_MISSING_IN_GIT');
  return found;
}
export function attestPureImportProvenance(root,expectedSha=null) {
  const {report}=readTestInventory(root);
  if(expectedSha!==null&&(!SHA.test(expectedSha)||expectedSha!==report.commitSha))
    deny('EXPECTED_HEAD_SHA_MISMATCH');
  for(const f of PURE_ENTRYPOINTS)
    if(!APPROVED_ROOT_TEST_FILES.includes(f))deny('PURE_SUITE_NOT_ALLOWLISTED');
  const paths=Object.keys(EXPECTED).sort();
  const tree=readGitEntries(root,paths,
    ['ls-tree','-z','HEAD','--',...paths],
    /^(100[0-7]{3}) blob ([a-f0-9]{40})\t(.+)$/);
  const index=readGitEntries(root,paths,
    ['ls-files','--stage','-z','--',...paths],
    /^(100[0-7]{3}) ([a-f0-9]{40}) 0\t(.+)$/);
  const source={};
  for(const f of paths){
    if(tree.get(f)!==EXPECTED[f]||index.get(f)!==EXPECTED[f])
      deny('REVIEWED_GIT_BLOB_CHANGED');
    const abs=path.resolve(root,...f.split('/'));
    const st=lstatSync(abs);
    if(!st.isFile()||st.isSymbolicLink())deny('NOT_REGULAR_SOURCE');
    const data=readFileSync(abs);
    if(blobHash(data)!==EXPECTED[f])deny('WORKTREE_CONTENT_CHANGED');
    source[f]=data;
  }
  const graph=tracePureGraph(source);
  return {
    schemaVersion:1,
    sourceCommitSha:report.commitSha,
    sourceManifestSha256:report.manifestSha256,
    reviewedTestFileCount:PURE_ENTRYPOINTS.length,
    reviewedDependencyFileCount:paths.length-PURE_ENTRYPOINTS.length,
    directAndTransitiveLocalSourceFiles:graph.paths.map(f=>({path:f,gitBlobSha:EXPECTED[f]})),
    externalPackagesReviewedAsDirectImports:graph.externalImports,
    scope:'EXACT_TWO_PURE_SUITES_STATIC_LOCAL_IMPORT_CLOSURE',
    externalPackageImplementationProvenance:'NOT_ATTESTED',
    runtimeDynamicCodeProvenance:'NOT_INFERRED',
    physicalWindowsAcceptance:'NOT_INFERRED',
  };
}
const invoked=process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url;
if(invoked) {
  try {
    if(process.argv.length!==3||process.argv[2]!=='--json')deny('USAGE');
    const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
    const expectedSha=process.env.NEXOWIRE_EXPECTED_COMMIT_SHA??null;
    if(process.env.CI==='true'&&expectedSha===null)deny('EXPECTED_HEAD_SHA_REQUIRED_IN_CI');
    process.stdout.write(JSON.stringify(attestPureImportProvenance(root,expectedSha))+'\n');
  }catch(e){
    process.stderr.write((e instanceof Error?e.message:'PURE_IMPORT_PROVENANCE_UNKNOWN')+'\n');
    process.exitCode=1;
  }
}
