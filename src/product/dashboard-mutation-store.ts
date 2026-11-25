import {createHash,randomUUID} from 'node:crypto';
import type {D1DatabaseLike,D1PreparedStatementLike} from './d1-control-plane-store.js';
import type {PairingRecord} from './pairing.js';

export type DashboardMutationKind='pairing'|'core-enable'|'core-disable'|'core-consent';
export interface DashboardMutationIntent {
  readonly mutationId:string;readonly ownerAccountId:string;readonly deviceId:string;
  readonly kind:DashboardMutationKind;readonly payloadSha256:string;
  readonly expectedRevision:number|null;readonly createdAt:string;
}
export interface DashboardMutationStatus {
  mutationId:string;deviceId:string;kind:DashboardMutationKind;
  state:'PENDING'|'APPLIED';expectedRevision:number|null;
}
/** Header is an identity only, not authentication or authority. */
export function validDashboardMutationId(id:unknown,kind?:DashboardMutationKind):id is string{
  if(typeof id!=='string')return false;
  const pairing=/^pairing-v1:[a-f0-9]{64}$/.test(id);
  const core=/^core-v1:[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id);
  return kind===undefined?pairing||core:kind==='pairing'?pairing:core;
}
export function dashboardMutationIntent(input:{mutationId:string;ownerAccountId:string;deviceId:string;
  kind:DashboardMutationKind;expectedRevision:number|null;semanticPayload:readonly (string|number|boolean|null)[];createdAt:string}):DashboardMutationIntent{
  if(!validDashboardMutationId(input.mutationId,input.kind))throw Error('INVALID_MUTATION_ID');
  if(input.kind==='pairing'?input.expectedRevision!==null:
    !Number.isSafeInteger(input.expectedRevision)||input.expectedRevision===null||input.expectedRevision<1)
    throw Error('INVALID_MUTATION_REVISION');
  if(!/^[A-Za-z0-9._:-]{1,128}$/.test(input.deviceId)||
    typeof input.ownerAccountId!=='string'||!input.ownerAccountId||input.ownerAccountId.length>128)
    throw Error('INVALID_MUTATION_SCOPE');
  return Object.freeze({mutationId:input.mutationId,ownerAccountId:input.ownerAccountId,
    deviceId:input.deviceId,kind:input.kind,expectedRevision:input.expectedRevision,
    createdAt:input.createdAt,payloadSha256:createHash('sha256').update(JSON.stringify([
      'dashboard-mutation-v1',input.ownerAccountId,input.deviceId,input.kind,input.expectedRevision,...input.semanticPayload
    ]),'utf8').digest('hex')});
}
const ready="d.platform='win32' AND d.access_mode='full' AND d.online=1 AND d.privilege_mode='broker' AND d.admin_bridge_ready=1 AND COALESCE(b.desired_mode,'auto')<>'off'";
const joins=`FROM devices d JOIN accounts a ON a.id=d.owner_account_id
 JOIN dashboard_core_revisions v ON v.device_id=d.id
 JOIN device_core_console_authority c ON c.device_id=d.id
 LEFT JOIN device_maintenance_preferences p ON p.device_id=d.id AND p.owner_account_id=d.owner_account_id
 LEFT JOIN device_bridge_preferences b ON b.device_id=d.id AND b.owner_account_id=d.owner_account_id`;
const columns='mutation_id,owner_account_id,device_id,kind,payload_sha256,execution_nonce,expected_revision,state,created_at';
const won="EXISTS (SELECT 1 FROM dashboard_mutation_claims WHERE mutation_id=? AND execution_nonce=? AND state='PENDING')";
const changed=(r:{success?:boolean;meta?:{changes?:number}}|undefined)=>r?.success!==false&&r?.meta?.changes===1;
export class D1DashboardMutationStore {
  constructor(private readonly db:D1DatabaseLike){}
  async revision(deviceId:string,ownerAccountId:string):Promise<number|null>{
    const row=await this.db.prepare(`SELECT v.revision FROM dashboard_core_revisions v JOIN devices d ON d.id=v.device_id
      WHERE d.id=? AND d.owner_account_id=?`).bind(deviceId,ownerAccountId).first<{revision:number}>();
    return row&&Number.isSafeInteger(row.revision)&&row.revision>=1?row.revision:null;
  }
  async read(mutationId:string,ownerAccountId:string):Promise<DashboardMutationStatus|null>{
    const row=await this.db.prepare(`SELECT mutation_id,device_id,kind,state,expected_revision FROM dashboard_mutation_claims
      WHERE mutation_id=? AND owner_account_id=?`).bind(mutationId,ownerAccountId).first<{
      mutation_id:string;device_id:string;kind:DashboardMutationKind;state:'PENDING'|'APPLIED';expected_revision:number|null}>();
    return row?{mutationId:row.mutation_id,deviceId:row.device_id,kind:row.kind,state:row.state,expectedRevision:row.expected_revision}:null;
  }
  private async conflict(i:DashboardMutationIntent):Promise<never>{
    const row=await this.db.prepare(`SELECT payload_sha256,device_id,kind,expected_revision,state
      FROM dashboard_mutation_claims WHERE mutation_id=? AND owner_account_id=?`)
      .bind(i.mutationId,i.ownerAccountId).first<Record<string,unknown>>();
    // No foreign-owner identity oracle, payload or stored token is exposed.
    if(row&&row.payload_sha256===i.payloadSha256&&row.device_id===i.deviceId&&row.kind===i.kind&&row.expected_revision===i.expectedRevision)
      throw Error(row.state==='APPLIED'?'DASHBOARD_MUTATION_ALREADY_APPLIED':'DASHBOARD_MUTATION_OUTCOME_UNKNOWN');
    throw Error('DASHBOARD_MUTATION_CONFLICT');
  }
  private bindClaim(i:DashboardMutationIntent,nonce:string){
    return [i.mutationId,i.ownerAccountId,i.deviceId,i.kind,i.payloadSha256,nonce,i.expectedRevision,i.createdAt];
  }
  private settle(i:DashboardMutationIntent,nonce:string,condition:string,values:unknown[]){
    return this.db.prepare("UPDATE dashboard_mutation_claims SET state='APPLIED' WHERE mutation_id=? AND execution_nonce=? AND state='PENDING' AND "+condition)
      .bind(i.mutationId,nonce,...values);
  }
  /** D1 batch is one transaction. The nonce is generated by this invocation;
   * losing duplicate statements cannot reach the write or settle statements.
   * A successful pairing challenge token is returned only to its first caller. */
  async createPairing(i:DashboardMutationIntent,record:PairingRecord):Promise<void>{
    if(i.kind!=='pairing'||i.expectedRevision!==null||record.ownerAccountId!==i.ownerAccountId||
      record.requestedDeviceId!==i.deviceId||record.consumedAt!==null)throw Error('INVALID_MUTATION_SCOPE');
    const nonce=randomUUID();
    const statements=[
      this.db.prepare(`INSERT INTO dashboard_mutation_claims(${columns})
       SELECT ?,?,?,?,?,?,?,'PENDING',? WHERE EXISTS(SELECT 1 FROM accounts WHERE id=?)
       AND NOT EXISTS(SELECT 1 FROM devices WHERE id=? AND owner_account_id<>?)
       ON CONFLICT(mutation_id) DO NOTHING`).bind(...this.bindClaim(i,nonce),i.ownerAccountId,i.deviceId,i.ownerAccountId),
      this.db.prepare(`INSERT INTO pairings(id,owner_account_id,requested_device_id,requested_device_name,token_hash,created_at,expires_at,consumed_at)
       SELECT ?,?,?,?,?,?,?,NULL WHERE ${won}`).bind(record.id,record.ownerAccountId,record.requestedDeviceId,
       record.requestedDeviceName,record.tokenHash,record.createdAt,record.expiresAt,i.mutationId,nonce),
      this.settle(i,nonce,'EXISTS(SELECT 1 FROM pairings WHERE id=? AND owner_account_id=? AND requested_device_id=? AND token_hash=?)',
        [record.id,record.ownerAccountId,record.requestedDeviceId,record.tokenHash])
    ];
    const result=await this.db.batch(statements);
    if(!changed(result[0]))return this.conflict(i);
    if(!changed(result[1])||!changed(result[2]))throw Error('DASHBOARD_MUTATION_OUTCOME_UNKNOWN');
  }
  /** Atomic revision comparison and preference/enrollment write. This does
   * not grant elevation, approve an owner ceremony, or assert native drain.
   * All readiness and same-owner predicates execute in the write transaction,
   * not only in a preceding dashboard GET. */
  async applyCore(i:DashboardMutationIntent):Promise<void>{
    if(i.kind==='pairing'||!Number.isSafeInteger(i.expectedRevision)||i.expectedRevision===null||i.expectedRevision<1)
      throw Error('INVALID_MUTATION_REVISION');
    const nonce=randomUUID();
    const eligible=i.kind==='core-disable'?"p.enabled=1":
      i.kind==='core-enable'?`${ready} AND COALESCE(p.enabled,0)=0 AND c.enrollment_id IS NULL`:
      `${ready} AND p.enabled=1 AND c.enrollment_id IS NULL AND c.enrollment_requested=0`;
    const claim=this.db.prepare(`INSERT INTO dashboard_mutation_claims(${columns})
      SELECT ?,?,?,?,?,?,?,'PENDING',? WHERE EXISTS(SELECT 1 ${joins}
        WHERE d.id=? AND d.owner_account_id=? AND v.revision=? AND (${eligible}))
      ON CONFLICT(mutation_id) DO NOTHING`).bind(...this.bindClaim(i,nonce),i.deviceId,i.ownerAccountId,i.expectedRevision);
    let write:D1PreparedStatementLike;
    if(i.kind==='core-consent'){
      write=this.db.prepare(`UPDATE device_core_console_authority SET enrollment_requested=1
        WHERE device_id=? AND enrollment_id IS NULL AND enrollment_requested=0 AND ${won}`)
        .bind(i.deviceId,i.mutationId,nonce);
    }else{
      write=this.db.prepare(`INSERT INTO device_maintenance_preferences(device_id,owner_account_id,enabled,updated_at)
        SELECT ?,?,?,? WHERE ${won}
        ON CONFLICT(device_id) DO UPDATE SET owner_account_id=excluded.owner_account_id,
          enabled=excluded.enabled,updated_at=excluded.updated_at`)
        .bind(i.deviceId,i.ownerAccountId,i.kind==='core-enable'?1:0,i.createdAt,i.mutationId,nonce);
    }
    const terminal=i.kind==='core-consent'
      ?'EXISTS(SELECT 1 FROM device_core_console_authority WHERE device_id=? AND enrollment_requested=1 AND enrollment_id IS NULL)'
      :'EXISTS(SELECT 1 FROM device_maintenance_preferences WHERE device_id=? AND owner_account_id=? AND enabled=? AND updated_at=?)';
    const terminalArgs=i.kind==='core-consent'?[i.deviceId]:[i.deviceId,i.ownerAccountId,i.kind==='core-enable'?1:0,i.createdAt];
    const result=await this.db.batch([claim,write,this.settle(i,nonce,
      terminal+' AND EXISTS(SELECT 1 FROM dashboard_core_revisions WHERE device_id=? AND revision>?)',
      [...terminalArgs,i.deviceId,i.expectedRevision])]);
    if(!changed(result[0]))return this.conflict(i);
    if(!changed(result[1])||!changed(result[2]))throw Error('DASHBOARD_MUTATION_OUTCOME_UNKNOWN');
  }
}
