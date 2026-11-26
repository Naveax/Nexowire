// #539 / W-702: old completion must not mutate a still-pending newer load.
// Offline fake DOM; no live HTTP or authorization claims.
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const metrics = ['users','users-detail','online-devices','devices-total','calls','success-rate','owner-spend','capacity'];
const ids = [...metrics,'admin-pill','admin-metrics','admin-error','admin-error-message'];
const overview = { users:{total:3,active24h:1,paid:0}, devices:{online:1,total:2}, usage:{calls24h:4,successRate:100}, infrastructure:{ownerPaidSpendAllowed:false,providerAutoUpgradeAllowed:false,freeCapacityPercent:null} };
const response = status => ({ok:status===200,status,json:async()=>overview});
const deferred = () => { let settle; const promise = new Promise(r=>{settle=r;}); return {promise,settle}; };

export async function probePending(source, olderStatus, newerStatus) {
  if (![200,403].includes(olderStatus) || ![200,403].includes(newerStatus) || olderStatus===newerStatus) throw new RangeError('opposite 200/403 required');
  const nodes = new Map(ids.map(id=>{
    const classes=new Set(id==='admin-error'?['hidden']:[]), attrs=new Map();
    return [id,{textContent:'',className:'',classList:{add:x=>classes.add(x),remove:x=>classes.delete(x),contains:x=>classes.has(x)},setAttribute:(k,v)=>attrs.set(k,String(v)),getAttribute:k=>attrs.get(k)}];
  }));
  const snapshot = () => ({pill:nodes.get('admin-pill').textContent, busy:nodes.get('admin-metrics').getAttribute('aria-busy'), values:metrics.map(id=>nodes.get(id).textContent), errorVisible:!nodes.get('admin-error').classList.contains('hidden'), error:nodes.get('admin-error-message').textContent});
  const older=deferred(), newer=deferred(), requests=[];
  const ctx={Intl,document:{getElementById:id=>{if(!nodes.has(id))throw new Error('unknown id '+id);return nodes.get(id);}},fetch:(url,options)=>{requests.push({url,options});if(requests.length===1)return older.promise;if(requests.length===2)return newer.promise;throw new Error('unexpected fetch');}};
  const first=runInNewContext(source,ctx,{timeout:1000});
  const second=runInNewContext('load()',ctx,{timeout:1000});
  const before=snapshot();
  older.settle(response(olderStatus));
  await first;
  const pending=snapshot();
  newer.settle(response(newerStatus));
  await second;
  const final=snapshot();
  const loading=before.pill==='Yükleniyor'&&before.busy==='true'&&before.values.every(v=>v==='—')&&!before.errorVisible&&before.error==='';
  const stable=JSON.stringify(before)===JSON.stringify(pending);
  const settled=final.busy==='false'&&(newerStatus===200?final.pill==='Zero-spend aktif'&&final.values[0]==='3'&&!final.errorVisible&&final.error==='':final.pill==='Yetki yetersiz'&&final.values.every(v=>v==='—')&&final.errorVisible&&final.error.includes('403'));
  const contract=requests.length===2&&requests.every(({url,options})=>url==='/api/v1/admin/overview'&&options?.credentials==='include'&&(options.method??'GET')==='GET');
  return {olderStatus,newerStatus,pass:loading&&stable&&settled&&contract,loading,stable,settled,contract,before,pending,final};
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    if(!process.argv[2])throw new Error('supply exact web/admin.js');
    const source=readFileSync(resolve(process.argv[2]),'utf8');
    const cases=[await probePending(source,200,403),await probePending(source,403,200)];
    console.log(JSON.stringify({passed:cases.filter(c=>c.pass).length,total:cases.length,cases},null,2));
    process.exitCode=cases.every(c=>c.pass)?0:1;
  } catch(error) {console.error('PROBE ERROR:',error);process.exitCode=2;}
}
