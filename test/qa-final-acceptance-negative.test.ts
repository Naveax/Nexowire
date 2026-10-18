import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import path from 'node:path';

const manifestPath=path.resolve('docs/qa/cross-project-final-acceptance.json');
const manifest=JSON.parse(readFileSync(manifestPath,'utf8')) as {
 schema:string; baselineSha:string; independentReleaseApproval:null|{reviewer:string; approvedSha:string; signedManifestSha256:string; originalIncidentRetests:string[]};
 requirements:Array<{
  id:string;title:string;source:string;test:string;negativeCase:string;physicalGate:string;
  levels:Record<'source'|'staging'|'production'|'incident',{status:string;evidence:string|null}>;
 }>;
 incidents:Array<{name:string;incident:string;requirements:string[];physicalGate:string}>;
 pullRequests:Array<{pr:string;state:string;requirements:string[];originalIncident:string;reproducer:string;missingAcceptance:string}>;
};
const valid=new Set(['PASS','FAIL','BLOCKED','NOT_TESTED']);
const stages=['source','staging','production','incident'] as const;
type Requirement=(typeof manifest.requirements)[number];

function validate(rec:Requirement):string[]{
 const errors:string[]=[];
 if(!/^R(0[1-9]|1[0-9]|2[0-2])$/.test(rec.id))errors.push('invalid requirement ID');
 for(const key of ['title','source','test','negativeCase','physicalGate'] as const){
  if(typeof rec[key]!=='string'||!rec[key].trim())errors.push('missing '+key);
 }
 for(const level of stages){
  const val=rec.levels[level];
  if(!val||!valid.has(val.status)) {errors.push('invalid '+level);continue}
  if(val.status==='PASS' && (!val.evidence||!val.evidence.trim())){
   errors.push('ungrounded PASS '+level);
  }
 }
 if(rec.levels.staging.status==='PASS' && rec.levels.source.status!=='PASS'){
  errors.push('staging without source');
 }
 if(rec.levels.production.status==='PASS' && rec.levels.staging.status!=='PASS'){
  errors.push('production without staging');
 }
 if(rec.levels.incident.status==='PASS' && rec.levels.production.status!=='PASS'){
  errors.push('incident without production');
 }
 return errors;
}
function releasePass(rows:Requirement[], approval=manifest.independentReleaseApproval):boolean {
 if(!approval || !approval.reviewer || approval.approvedSha!==manifest.baselineSha ||
    !/^[a-f0-9]{64}$/.test(approval.signedManifestSha256) ||
    approval.originalIncidentRetests.length!==22)return false;
 return rows.length===22 && rows.every(rec=>
  validate(rec).length===0 && stages.every(level=>rec.levels[level].status==='PASS'));
}
const deepClone=<T>(data:T):T=>JSON.parse(JSON.stringify(data)) as T;

test('22 distinct R01-R22 requirements are individually tracked with physical gates',()=>{
 assert.equal(manifest.schema,'nexowire.independent-qa.v1');
 assert.match(manifest.baselineSha,/^[a-f0-9]{40}$/);
 assert.deepEqual(manifest.requirements.map(x=>x.id).sort(),
   Array.from({length:22},(_,i)=>'R'+String(i+1).padStart(2,'0')));
 for(const rec of manifest.requirements)assert.deepEqual(validate(rec),[],rec.id);
 assert.equal(releasePass(manifest.requirements),false,
   'CI/source cannot silently upgrade staging, production or original incidents');
});

test('negative: a merged PR with no production or original incident evidence cannot pass',()=>{
 const fake=deepClone(manifest.requirements);
 fake.forEach(x=>{x.levels.source.status='PASS'; x.levels.source.evidence='synthetic-only'});
 assert.equal(releasePass(fake),false);
});

test('negative: four fabricated PASS strings cannot replace independent approval',()=>{
 const fake=deepClone(manifest.requirements);
 for(const rec of fake)for(const level of stages){
  rec.levels[level]={status:'PASS',evidence:'claimed acceptance without verified physical receipt'};
 }
 assert.equal(releasePass(fake),false);
});
test('negative: invented PASS with no evidence is rejected',()=>{
 const fake=deepClone(manifest.requirements[0]!);
 for(const level of stages)fake.levels[level]={status:'PASS',evidence:null};
 assert.ok(validate(fake).some(e=>e.startsWith('ungrounded PASS')));
 assert.equal(releasePass([fake]),false);
});

test('negative: incident PASS without staging and deployed runtime is rejected',()=>{
 const fake=deepClone(manifest.requirements[0]!);
 fake.levels.incident={status:'PASS',evidence:'claimed incident fixed'};
 assert.ok(validate(fake).includes('incident without production'));
});

test('negative: staging success cannot stand in for source failure',()=>{
 const fake=deepClone(manifest.requirements[0]!);
 fake.levels.source.status='FAIL';
 fake.levels.staging={status:'PASS',evidence:'synthetic staged result'};
 assert.ok(validate(fake).includes('staging without source'));
});

test('all 12 incident histories map to existing requirements and physical gates',()=>{
 const expected=['LG G3','Debian/Win7','Syntavra','Roblox','PSMatrix',
  'NXB V11','Catalog','ReVoltVPN','GuardAdaptive','Scale v2','Kripto botu','Search-Tool'];
 assert.deepEqual(manifest.incidents.map(x=>x.name).sort(),expected.sort());
 const ids=new Set(manifest.requirements.map(x=>x.id));
 for(const item of manifest.incidents){
  assert.ok(item.incident&&item.physicalGate);
  assert.ok(item.requirements.length>0);
  item.requirements.forEach(r=>assert.ok(ids.has(r),r));
 }
});

test('reviewed PRs retain exact reproducers and unresolved acceptance requirements',()=>{
 const known=new Set(manifest.requirements.map(x=>x.id));
 for(const pr of manifest.pullRequests){
  assert.match(pr.pr,/^#\d+$/);
  assert.ok(pr.originalIncident&&pr.reproducer&&pr.missingAcceptance);
  assert.ok(pr.requirements.length>0);
  pr.requirements.forEach(id=>assert.ok(known.has(id)));
 }
 assert.ok(manifest.pullRequests.some(x=>x.pr==='#543'&&x.state==='MERGED'));
 assert.equal(releasePass(manifest.requirements),false);
});
