import {execFileSync,spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFileSync,lstatSync,mkdirSync,writeFileSync,existsSync} from 'node:fs';
import path from 'node:path';
import {assertTapSummary} from './assert-tap-summary.mjs';
import {WINDOWS_PLAN,COMPOSITION_IMPORTS,validateWindowsPlan,assertCoreExactTap} from './ai08-core-authority-plan.mjs';
import {readTestInventory} from './test-inventory.mjs';
const LEDGER='test/postgres-core-approval-ledger.test.ts';
const OWNER_TITLES=["approval ledger requires independent native/restore witnesses before opening any database","real PostgreSQL approval: consume verifies the provisioned key, updates counter and preserves scoped readback","real PostgreSQL approval: two service instances racing a counterless assertion consume exactly once","real PostgreSQL approval: lost COMMIT ACK is terminal across a new authority instance","real PostgreSQL approval: caller flags, forged key and substituted owner/session are never enrollment evidence","real PostgreSQL approval: stale native witness, revoke and re-pair invalidate consume and prior readback","real PostgreSQL approval: provenance and native binding are re-read after cryptographic verification","real PostgreSQL approval: controlled expiry during final witness await denies before durable consume","real PostgreSQL approval: a controlled late ACK denies the receipt and retains its consumed tombstone","real PostgreSQL approval: credential counters cannot be replayed through a different fresh challenge","real PostgreSQL approval: revoke after COMMIT blocks final readback and preserves one-use history","real PostgreSQL approval: even a forged consumed DB flag cannot replace the authenticator signature in readback","real PostgreSQL approval: key rewrite, history erase/reopen and counter rollback are denied","real PostgreSQL enrollment: approval readback cannot replace the separate one-use D1 handoff","real PostgreSQL enrollment: requested issuer must match independent protected readback","real PostgreSQL enrollment: issuer changes during native witness await deny before INSERT","real PostgreSQL enrollment: issuer rotation after DB clock read denies handoff before INSERT","real PostgreSQL enrollment: issuer changes after COMMIT deny ACK but preserve tombstone","real PostgreSQL enrollment: independent verifiers racing the same receipt admit exactly one","real PostgreSQL enrollment: lost handoff COMMIT ACK never becomes a successful retry","real PostgreSQL enrollment: forged receipt fields and current native session changes deny handoff","real PostgreSQL enrollment: database-clock expiry and final-witness revoke reject without reopening history","real PostgreSQL enrollment: revoke after handoff COMMIT suppresses readback and preserves the tombstone","real PostgreSQL enrollment: a controlled late ACK denies success without undoing consumption","real PostgreSQL restart: native approval tombstone and counter survive actual database restart","real PostgreSQL enrollment: unbound legacy approval and issuer substitution never authorize enrollment","real PostgreSQL owner ceremony: exact native helper args, durable assertion and stale-owner denial"];
const windows={...WINDOWS_PLAN,
 'test/ai03/native-effect-startup-boundary.test.ts':['ac0b8808742debe2d05d7ed76002fa6a959e5b5d',3],
 'test/core-webauthn-approval.test.ts':['02079777129550e2218d61800c1b4d9bd7f4e363',10]};
const postgres={
 'test/ai08/credential-atomicity-live.test.ts':['a4d64489c5589500ad7f60a0421472bf13520fac',3],
 [LEDGER]:['ffa8bdd43088f7871467112aa97b1f49c9e589db',27]};
const pins={
 '.gitattributes':'c039ea0d6cdd0a0551d278dc728c257973164c5b',
 'scripts/ci/ai08-core-authority-plan.mjs':'f55dc476f2ad3687f6b0e45682f303a33abcb2ee',
 'src/agent/broker-dispatch-authority-handler.ts':'4a8733f9b53f75af58ca0cbd18686d33b64ff579',
 'src/agent/postgres-broker-dispatch-authority.ts':'2379c6f9d293ec8bb701b6c94ed941c186caf2c8',
 'src/agent/broker-external-dispatch-fence.ts':'95f96ce8160c84d743557f38c638261c08bfc363',
 'src/agent/protected-broker-dispatch-service.ts':'a316ac46e2a34191d6c49f230daf733660efc87a',
 'src/agent/postgres-dispatch-credential-store.ts':'acd931e125e01c8ccc601acde2a5cf7d8956049b',
 'src/agent/https-broker-dispatch-authority.ts':'40e044f35b4ea55a4f2b35a6ff0ef75fcc66bb74',
 'src/agent/broker-dispatch-mtls-fetch.ts':'a5e8dc574a047095f77f7b9dec1278e30b3555a9',
 'src/agent/protected-dispatch-native-installation-readback.ts':'4d5502266fc1f9789cc578abcb9d66ab2a8d4260',
 'src/agent/protected-postgres-dispatch-pool.ts':'65d65241171c71b436a5e7606a77aeb9d0fcb0cc',
 'src/agent/native-atomic-effect-admission.ts':'7799559aa34a311eecde9f2773020a8a49e89b5e',
 'src/agent/privileged-broker.ts':'6fe4ade7e4f79fe981703717f6d3271d595b99a3',
 'src/security/windows-privileged-runtime-trust.ts':'2eb3029f9790cd7b94aa7bf87711a2296e3d3df3',
 'src/security/postgres-core-approval-ledger.ts':'13c1cf64080548e1d1ace9f8aeb84c5fefb4053e',
 'src/security/protected-owner-consent-authority.ts':'a7f1ad35ff6757b76a3c253e4d20217ceb33763f',
 'src/security/core-webauthn-approval.ts':'4b66824edb04d0fea503012f83b70c068a8c5c14',
 'src/agent/windows-core-console-provider.ts':'2e305fbaefa8f3fdcbfe26d98aefc5e4564bd317',
 'src/agent/windows-core-consent-transport.ts':'bcf994f6d23bc139ce43b26dcb77f8e1fdaf9cab',
 'src/protocol/core-native-consent-transport.ts':'9a64ded9ef6d6c50bfd5e3d627495e253c2f14ee',
 'src/security/core-native-verifier-service.ts':'2dcc44d341dd0c98e3ed099ed910fcbb5b42ced5',
 'src/security/core-native-verifier-server.ts':'78ffdc36ff6728ae8880b10db21d2fc5bf225394',
 'src/security/core-native-mtls-fetch.ts':'d824def6dd40ad2973d4d21a07c2425e2d09a0cb',
 'sql/core-broker-dispatch-authority.sql':'a120585a92d7ab41bb2d1a3aaf5c0bc31f9ca74b',
 'sql/core-broker-dispatch-credentials.sql':'4cd511f8246025c7293202070527c66710b80a62',
 'sql/core-broker-dispatch-credential-fence.sql':'6c847b5386312a2550318f68792822feb5a93192',
 'sql/core-native-approval-ledger.sql':'5bd2a1510902165a04ba3ded49d30d5dc9f9580b',
 'native/windows-core-webauthn-approval.c':'7b84ebff60a1d5ae284ce908deb60abf0a00dbbb',
 'scripts/build-windows-core-webauthn.ps1':'d769bcde8ba2f6d906377fc64b3132d0b8e388d7',
 ...Object.fromEntries(Object.entries(COMPOSITION_IMPORTS).map(([f,p])=>[f,p.blob])),
 ...Object.fromEntries(Object.entries({...windows,...postgres}).map(([f,[b]])=>[f,b]))
};
const lane=process.argv[2],tests=lane==='windows'?windows:lane==='postgres'?postgres:null;
if(!tests||process.platform!==(lane==='windows'?'win32':'linux')||process.env.GITHUB_ACTIONS!=='true'||process.env.RUNNER_ENVIRONMENT!=='github-hosted'||
 process.versions.node.split('.')[0]!==process.env.NX_EXPECTED_NODE||!/^\d+$/.test(process.env.NX_JOB_ID??'')||!/^\d+$/.test(process.env.GITHUB_RUN_ID??''))throw Error('HOSTED_EXACT_TARGET_REQUIRED');
if(lane==='postgres'&&(process.env.NEXOWIRE_PG_DISPATCH_INTEGRATION!=='1'||process.env.NEXOWIRE_PG_DISPATCH_TEST_PORT!=='5432'||process.env.NEXOWIRE_PG_DISPATCH_RESTART_PHASE))throw Error('DISPOSABLE_POSTGRES_ONLY');
validateWindowsPlan(windows);
const git=(...a)=>execFileSync('git',a,{encoding:'utf8'}).trim();
const blob=b=>createHash('sha1').update('blob '+b.length+'\0').update(b).digest('hex');
const hash=b=>createHash('sha256').update(b).digest('hex');
const {report,entries}=readTestInventory(process.cwd());
if(report.commitSha!==process.env.NEXOWIRE_EXPECTED_COMMIT_SHA||git('rev-parse','HEAD')!==report.commitSha)throw Error('HEAD_MISMATCH');
const base='dc43966165a97c7d8ec651522308dfeee97b54e5';
execFileSync('git',['merge-base','--is-ancestor',base,report.commitSha]);
function check(){for(const [f,b] of Object.entries(pins)){
 const st=lstatSync(f);if(!st.isFile()||st.isSymbolicLink()||git('rev-parse','HEAD:'+f)!==b)throw Error('PIN_MISMATCH:'+f);
 const bytes=readFileSync(f);
 if(f.endsWith('.ps1')){
  const canonical=execFileSync('git',['cat-file','blob',b]);
  const text=canonical.toString('utf8');
  if(blob(canonical)!==b||text.includes('\r')||!Buffer.from(text).equals(canonical)||
    git('check-attr','eol','--',f)!==f+': eol: crlf'||
    !bytes.equals(Buffer.from(text.replaceAll('\n','\r\n'))))throw Error('CRLF_PIN_MISMATCH:'+f);
 }else if(blob(bytes)!==b)throw Error('PIN_MISMATCH:'+f);
}}
check();
for(const [f,b] of Object.entries(pins))if(f.startsWith('test/')&&!entries.some(e=>e.path===f&&e.blob===b))throw Error('INVENTORY_MISMATCH:'+f);
const dir='ai08-1315-receipts';mkdirSync(dir,{recursive:true});
const receipt={schemaVersion:1,sourceCommitSha:report.commitSha,reviewedSourceParent:base,sourceManifestSha256:report.manifestSha256,platform:process.platform,nodeVersion:process.version,runId:process.env.GITHUB_RUN_ID,jobId:process.env.NX_JOB_ID,runAttempt:process.env.GITHUB_RUN_ATTEMPT,lane,pins,files:[],physicalAcceptance:'NOT_PROVEN'};
const save=()=>writeFileSync(path.join(dir,'receipt.json'),JSON.stringify(receipt,null,2)+'\n');
save();
function assertLedger(tap){
 const lines=tap.split(/\r?\n/),counts=Object.create(null),expected={tests:27,pass:26,fail:0,cancelled:0,skipped:1,todo:0};
 for(const line of lines){const m=/^# (tests|pass|fail|cancelled|skipped|todo) (0|[1-9][0-9]*)$/.exec(line);if(!m)continue;if(Object.hasOwn(counts,m[1]))throw Error('LEDGER_DUPLICATE_COUNTER');counts[m[1]]=Number(m[2]);}
 for(const [k,v] of Object.entries(expected))if(counts[k]!==v)throw Error('LEDGER_COUNT_MISMATCH:'+k);
 const results=lines.filter(l=>/^\s*(?:not )?ok \d+ - /.test(l));
 if(results.length!==27||lines.filter(l=>l==='TAP version 13').length!==1||lines.filter(l=>/^\s*1\.\.\d+$/.test(l)).join(',')!=='1..27')throw Error('LEDGER_STRUCTURE_MISMATCH');
 for(const [i,t] of OWNER_TITLES.entries())if(results[i]!=='ok '+(i+1)+' - '+t+(i===24?' # SKIP separate staged real restart; physical NOT_PROVEN':''))throw Error('LEDGER_CASE_MISMATCH:'+t);
 return counts;
}
if(lane==='windows'){
 const exe='native/windows-core-webauthn-approval.exe';
 if(existsSync(exe))throw Error('PREEXISTING_NATIVE_ARTIFACT');
 const child=spawnSync('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-File','scripts/build-windows-core-webauthn.ps1'],{encoding:'utf8',timeout:240000,maxBuffer:8*1024*1024,windowsHide:true});
 const output=(child.stdout??'')+(child.stderr??'');writeFileSync(path.join(dir,'native-build.log'),output);process.stdout.write(output);
 if(child.error||child.signal||child.status!==0||!existsSync(exe)||!output.includes('WebAuthn component built; unsigned, uninstalled, no credential or CORE authority.'))throw Error('NATIVE_BUILD_FAILED');
 const bytes=readFileSync(exe),pe=bytes.readUInt32LE(0x3c);
 if(bytes.readUInt16LE(0)!==0x5a4d||bytes.readUInt32LE(pe)!==0x4550||bytes.readUInt16LE(pe+4)!==0x8664)throw Error('NATIVE_X64_PE_REQUIRED');
 receipt.nativeBuild={status:'PASS',sha256:hash(bytes),signed:false,installed:false,physicalApproval:false};save();
}
for(const [file,[b,expected]] of Object.entries(tests)){
 check();const r={file,blob:b,expected,status:'FAIL'};receipt.files.push(r);
 const child=spawnSync(process.execPath,['--test','--test-reporter=tap','--test-concurrency=1','--import','tsx',file],{encoding:'utf8',timeout:360000,maxBuffer:8*1024*1024,windowsHide:true});
 const tap=child.stdout??'';writeFileSync(path.join(dir,path.basename(file)+'.tap'),tap);process.stdout.write(tap);if(child.stderr)process.stderr.write(child.stderr);
 r.tapSha256=hash(tap);r.exitCode=child.status;
 try{if(child.error||child.signal||child.status!==0)throw Error('CHILD_FAILED');
  r.counts=file===LEDGER?assertLedger(tap):assertCoreExactTap(file,tap,expected);
  if(r.counts.tests!==expected)throw Error('EXACT_TEST_COUNT_MISMATCH');
  if(file===LEDGER)r.expectedSkip=OWNER_TITLES[24];
  r.status='PASS';
 }catch(e){r.failure=e.message;}
 save();
}
check();
receipt.totalPass=receipt.files.reduce((n,f)=>n+(f.counts?.pass??0),0);
receipt.totalSkipped=receipt.files.reduce((n,f)=>n+(f.counts?.skipped??0),0);
save();console.log(JSON.stringify(receipt));
if(receipt.files.some(f=>f.status!=='PASS')||receipt.totalPass!==(lane==='windows'?84:29)||receipt.totalSkipped!==(lane==='windows'?0:1))process.exitCode=1;
