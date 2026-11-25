/**
 * Read-only source and import provenance gate for twenty-eight independently reviewed,
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
  'test/github-app-manifest.test.ts':'2c6608e65c6b86fc0064edbb9540ffa6143f8a5c',
  'test/daily-quota-proposal.test.ts':'2f4abf418858d3bfd507d9e6f7593c18a767f455',
  'test/product-usage-ledger.test.ts':'970a9502cadd2e1df37839e866646fba471db8cc',
  'test/progress-supervisor.test.ts':'a6f62bbc58657585d516e36f7caf26fa36acce7b',
  'test/guardian-key-enrollment-proof.test.ts':'f9d52ebbcbcd7d5667069c1f3fd27e9a35d09588',
  'test/guardian-signed-receipt.test.ts':'9eddfb2267a6a7defe2a8e69c43cd6c96ebb17d8',
  'test/private-display-plan.test.ts':'84e416cfc6f8ca183ba6400a362e80ef2325ea6d',
  'test/owner-public-wss-p256-migration-proposal.test.ts':'e3b95ef518676022766d1edefda55ef729835717',
  'test/agent-request-cache.test.ts':'745865fb0a79aa4b271d703f4b924bb601cff9a5',
  'test/owner-public-wss-stream-flow-staging.test.ts':'a6c5d85e137e30237de8e3e3a72362f37b388751',
'test/scale-elastic-capacity-model.test.ts':'ce9012cd2048eef83c31535f8b35a4fd8ddcbbaf',
  'test/scale-s5-cost-envelope.test.ts':'4bbf0f7949be9c86c48fda1a7ce1470adc64b868',
  'test/scale-worker-capacity-overflow.test.ts':'d2ba84e59b45ec6973d4177360d7e9fbecebafe4',
  'test/scale-s5-resource-reconciliation.test.ts':'bd60b7b10bc22be4219155b165e401de34b4d277',
  'test/scale-s5-durable-object-cost.test.ts':'b483dddfb16d683fed0b5fa898ce446bcf992618',
  'test/scale-s5-chunk-receipt-audit.test.ts':'1b70d6bc7112d2e21c2ebdf165a237a68fe51848',
  'test/scale-transport-metrics.test.ts':'7a5cf2d1fac5cdff68f33367bef682edb972c092',
  'test/scale-s5-provider-meter-evidence.test.ts':'995e600846f2d314cedb1bdb571220b13c98868f',
  'test/security-tokens.test.ts':'92ea5c61df1c707f2970e1305a34b56d5cf7b8e0',
  'test/scale-s5-staging-acceptance.test.ts':'b381c0cc734d7a29f650bf922beb168074817e3d',
  'src/protocol/agent.ts':'6bd55d19f898021fd1e70e78045ddba656aaf4e5',
  'src/protocol/capabilities.ts':'f661b6e27794184bacf7dfbcf3f53e7fc5f5919d',
  'src/product/plans.ts':'9ac634f06f475d4c4ae9c12032ebda68e2b2ee04',
  'src/product/usage-policy.ts':'8bcc7539dbdb6ac85e080791306dd60432a59d7d',
  'src/product/transport-policy.ts':'ea0593dfc9bf29b6be40120cc4a1cb2a61f46788',
  'src/agent/task-os-sandbox-policy.ts':'a35e1b25d40b2a0d796dd9fdd51d7079370e6730',
  'src/agent/bridge-guardian-policy.ts':'61fc71fe63a4103b7028f7214f07e00c190fc812',
  'src/protocol/admin-bridge-intent.ts':'2b083e49d0612f0573790a4edf0d2594803d7a02',
  'src/product/pairing.ts':'7528c7902f5b63fce98187721325098a88735c5d',
  'src/product/github-app-manifest.ts':'eaeda3495cd0492df04bd01567a29aeafe80f08e',
  'src/product/daily-quota-proposal.ts':'779be3e17cdfe7c02edc8818b6acf257c1677084',
  'src/product/usage-ledger.ts':'0e1fd3e8c966ecc4743e3b949964d4e703f9e68c',
  'src/agent/progress-supervisor.ts':'c407c72667df20bb844ef0eb7e9ca736d257a69c',
  'src/protocol/guardian-key-enrollment-proof.ts':'7e64ff644b03cb154e75ab8658ea95d2b9a4f533',
  'src/protocol/guardian-signed-receipt.ts':'304b2da32957d18797afa1a900cbd1e25b93e9b5',
  'src/agent/windows-private-display-plan.ts':'5cd669c9077a453b36e374e7ccab716d5314a012',
  'src/mcp/tool-capabilities.ts':'0e420f2d69e65bd38ae044dbb3d1b9980b2e1523',
  'src/product/owner-public-wss-p256-migration-proposal.ts':'5f66b24ba73ef64051c791b5d95523184f321ffe',
  'src/agent/request-cache.ts':'dc5c3da93f29a0860415235d3bad648b976c765b',
  'src/product/owner-public-wss-stream-flow-proposal.ts':'0b0784299b8f17904695263b130bfb13eacb66c1',
'src/ops/scale-elastic-capacity-model.ts':'0671e7e568510de58af8377b3f0e8775a1f1b791',
  'src/ops/scale-s5-cost-envelope.ts':'2c01c3e9fda8e04aa7c6a2fe5e4f50c9cdac9b22',
  'src/ops/scale-worker-capacity-model.ts':'0ba30bd7101061f92455b3df10204d91077c43b8',
  'src/ops/scale-s5-resource-reconciliation.ts':'4b6cfc9850ee2a130317b8d030fc35f5772550ab',
  'src/ops/scale-s5-durable-object-cost.ts':'c2e2a897d21cfd2c388213de2437bad345411454',
  'src/ops/scale-s5-chunk-receipt-audit.ts':'e381342b779999026bf0f15e0c8205192c503fa9',
  'src/ops/scale-transport-metrics.ts':'bb79ba0635f862dfb19f92b9d4a461bc185cde48',
  'src/ops/scale-s5-provider-meter-evidence.ts':'ffdcf7e513a3eb58a49d008f4c57c580941c95cb',
  'src/security/tokens.ts':'8587293f920b7910388e432baf2b84239b02c782',
  'src/ops/scale-s5-staging-acceptance.ts':'4b1cc45ad5150bf82e90dd4edff425e85acb605b',
  'test/core-elevation-effective-truth-matrix.test.ts':'09d970538d6ce22b20edb25c9da1fcbed8929c4c',
  'test/core-console-enrollment-policy.test.ts':'416167d7389f722d378f6fcd2b9ed61da813713b',
  'src/agent/core-console-enrollment-policy.ts':'8383e94acaa2c3accac6960bbf75c6daa1954c1f',
  'src/security/authorization-explain.ts':'a916ba1cffb24472d533630ceceb93febc8c46e2',
  'src/security/privilege.ts':'64c79bd868e43448ecb34d9bc83624282b04b5c7',
});
export const PURE_REVIEWED_FILES=EXPECTED;
export const PURE_ENTRYPOINTS=Object.freeze([
  'test/agent-protocol.test.ts',
  'test/product-usage-policy.test.ts',
  'test/product-transport-policy.test.ts',
  'test/task-os-sandbox-policy-p07.test.ts',
  'test/bridge-guardian-policy.test.ts',
  'test/product-pairing.test.ts',
  'test/github-app-manifest.test.ts',
  'test/daily-quota-proposal.test.ts',
  'test/product-usage-ledger.test.ts',
  'test/progress-supervisor.test.ts',
  'test/guardian-key-enrollment-proof.test.ts',
  'test/guardian-signed-receipt.test.ts',
  'test/private-display-plan.test.ts',
  'test/owner-public-wss-p256-migration-proposal.test.ts',
  'test/agent-request-cache.test.ts',
  'test/owner-public-wss-stream-flow-staging.test.ts',
'test/scale-elastic-capacity-model.test.ts',
  'test/scale-s5-cost-envelope.test.ts',
  'test/scale-worker-capacity-overflow.test.ts',
  'test/scale-s5-resource-reconciliation.test.ts',
  'test/scale-s5-durable-object-cost.test.ts',
  'test/scale-s5-chunk-receipt-audit.test.ts',
  'test/scale-transport-metrics.test.ts',
  'test/scale-s5-provider-meter-evidence.test.ts',
  'test/security-tokens.test.ts',
  'test/scale-s5-staging-acceptance.test.ts',
  'test/core-elevation-effective-truth-matrix.test.ts',
  'test/core-console-enrollment-policy.test.ts',
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
