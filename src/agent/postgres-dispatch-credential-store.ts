import * as z from 'zod';
import type {DispatchStorePool,DispatchStoreConnection} from './postgres-broker-dispatch-authority.js';
import type {IndependentProvenanceCheck} from './postgres-monotonic-witness.js';
import {createProtectedPostgresDispatchPool} from './protected-postgres-dispatch-pool.js';
import {startProtectedBrokerDispatchService,type ProtectedBrokerDispatchServiceOptions,
  type ProtectedDispatchCredentialRecord,type ProtectedDispatchCredentialStore}
  from './protected-broker-dispatch-service.js';

const uuid=z.string().uuid(),digest=z.string().regex(/^[a-f0-9]{64}$/);
const schema=z.strictObject({credentialSha256:digest,certificateSha256:digest,
  brokerId:uuid,ownerId:uuid,deviceId:uuid,installationId:uuid,deviceEpoch:uuid,sessionEpoch:uuid,
  state:z.literal('ACTIVE'),notBeforeMs:z.number().int().nonnegative().safe(),
  expiresAtMs:z.number().int().positive().safe()});
type VerifyInstallation=(record:ProtectedDispatchCredentialRecord,signal:AbortSignal)=>Promise<boolean>;

const roleCheck="SELECT session_user=current_user AS same_role, "+
  "NOT EXISTS (SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname=current_user)) AS no_memberships, "+
  "(SELECT NOT (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolreplication) FROM pg_roles WHERE rolname=current_user) AS restricted, "+
  "NOT has_schema_privilege(current_user,'core_dispatch','CREATE') AS no_ddl, "+
  "has_table_privilege(current_user,'core_dispatch.broker_credentials','SELECT') AND "+
  "has_table_privilege(current_user,'core_dispatch.grants','SELECT') AS can_read, "+
  "NOT (has_any_column_privilege(current_user,'core_dispatch.broker_credentials','INSERT,UPDATE,REFERENCES') OR "+
  "has_table_privilege(current_user,'core_dispatch.broker_credentials','DELETE,TRUNCATE,TRIGGER') OR "+
  "has_any_column_privilege(current_user,'core_dispatch.grants','INSERT,UPDATE,REFERENCES') OR "+
  "has_table_privilege(current_user,'core_dispatch.grants','DELETE,TRUNCATE,TRIGGER') OR "+
  "has_any_column_privilege(current_user,'core_dispatch.authorities','INSERT,UPDATE,REFERENCES') OR "+
  "has_table_privilege(current_user,'core_dispatch.authorities','DELETE,TRUNCATE,TRIGGER') OR "+
  "has_any_column_privilege(current_user,'core_dispatch.claims','INSERT,UPDATE,REFERENCES') OR "+
  "has_table_privilege(current_user,'core_dispatch.claims','DELETE,TRUNCATE,TRIGGER')) AS no_write, "+
  "NOT pg_is_in_recovery() AS primary_only";
const lookupSql='SELECT c.credential_sha256 AS "credentialSha256",c.certificate_sha256 AS "certificateSha256",'+
  'c.broker_id::text AS "brokerId",c.owner_id::text AS "ownerId",c.device_id::text AS "deviceId",'+
  'c.installation_id::text AS "installationId",c.device_epoch::text AS "deviceEpoch",'+
  'c.session_epoch::text AS "sessionEpoch",c.state,c.not_before_ms AS "notBeforeMs",'+
  'c.expires_at_ms AS "expiresAtMs" FROM core_dispatch.broker_credentials c '+
  'JOIN core_dispatch.grants g ON g.authority_id=c.authority_id AND g.device_id=c.device_id '+
  'AND g.owner_id=c.owner_id AND g.broker_id=c.broker_id AND g.device_epoch=c.device_epoch AND g.session_epoch=c.session_epoch '+
  "WHERE c.authority_id=$1 AND c.credential_sha256=$2 AND c.state='ACTIVE' "+
  'AND c.not_before_ms<=floor(extract(epoch from statement_timestamp())*1000) '+
  'AND c.expires_at_ms>floor(extract(epoch from statement_timestamp())*1000)';

/** Independent SELECT-only credential store. The grant join checks identity,
 * not grant state: a scoped release must remain possible after grant revoke.
 * The authority, not this store, serializes grant admission and native drain.
 * Credential lookup is NOT atomic with a separate authority transaction. */
export class PostgresDispatchCredentialStore implements ProtectedDispatchCredentialStore{
  private readonly authorityId:string;
  private readonly pool:DispatchStorePool;
  private readonly verifyProvenance:IndependentProvenanceCheck;
  private readonly verifyInstallation:VerifyInstallation;
  constructor(config:{authorityId:string;pool:DispatchStorePool;
    verifyProvenance:IndependentProvenanceCheck;verifyInstallationBinding:VerifyInstallation}){
    this.authorityId=uuid.parse(config.authorityId);
    if(typeof config.pool?.connect!=='function'||typeof config.verifyProvenance!=='function'||
      typeof config.verifyInstallationBinding!=='function')throw Error('DISPATCH_CREDENTIAL_CONFIGURATION_REQUIRED');
    this.pool=config.pool;this.verifyProvenance=config.verifyProvenance;
    this.verifyInstallation=config.verifyInstallationBinding;
  }
  private async bounded<T>(work:(signal:AbortSignal)=>Promise<T>):Promise<T>{
    const controller=new AbortController();
    let timer:ReturnType<typeof setTimeout>|undefined;
    try{return await Promise.race([Promise.resolve().then(()=>work(controller.signal)),
      new Promise<never>((_,reject)=>{timer=setTimeout(()=>{
        controller.abort();reject(Error('DISPATCH_CREDENTIAL_READ_TIMEOUT'));
      },2000)})]);}
    finally{if(timer!==undefined)clearTimeout(timer);controller.abort()}
  }
  private async trusted():Promise<void>{
    const p=await this.bounded(()=>this.verifyProvenance());
    if(p?.verified!==true||p.authorityId!==this.authorityId||
      !Number.isSafeInteger(p.validUntil)||p.validUntil<=Date.now())
      throw Error('DISPATCH_CREDENTIAL_PROVENANCE_UNVERIFIED');
  }
  private async read<T>(work:(db:DispatchStoreConnection)=>Promise<T>):Promise<T>{
    await this.trusted();
    const db=await this.pool.connect();
    let began=false,destroy=false;
    try{
      await db.query('BEGIN READ ONLY');began=true;
      await db.query("SET LOCAL statement_timeout='2000ms'");
      await db.query("SET LOCAL lock_timeout='1000ms'");
      const check=(await db.query(roleCheck)).rows;
      if(check.length!==1||!['same_role','no_memberships','restricted','no_ddl','can_read','no_write','primary_only']
        .every(k=>check[0]?.[k]===true))throw Error('DISPATCH_CREDENTIAL_ROLE_UNVERIFIED');
      const result=await work(db);
      await db.query('ROLLBACK');began=false;
      await this.trusted();
      return result;
    }catch(error){destroy=true;throw error}
    finally{
      if(began){try{await db.query('ROLLBACK')}catch{destroy=true}}
      db.release(destroy);
    }
  }
  async assertReady():Promise<void>{await this.read(async()=>undefined)}
  async lookup(credentialSha256:string):Promise<ProtectedDispatchCredentialRecord|undefined>{
    if(!digest.safeParse(credentialSha256).success)return undefined;
    try{return await this.read(async db=>{
      const result=await db.query(lookupSql,[this.authorityId,credentialSha256]);
      if(result.rows.length!==1)return undefined;
      const raw=result.rows[0]!;
      const time=(v:unknown)=>typeof v==='string'&&/^[0-9]+$/.test(v)?Number(v):v;
      const parsed=schema.safeParse({...raw,notBeforeMs:time(raw.notBeforeMs),expiresAtMs:time(raw.expiresAtMs)});
      if(!parsed.success||parsed.data.credentialSha256!==credentialSha256||
        parsed.data.expiresAtMs<=parsed.data.notBeforeMs)return undefined;
      return Object.freeze(parsed.data);
    })}catch{return undefined}
  }
  async verifyLiveBinding(value:ProtectedDispatchCredentialRecord):Promise<boolean>{
    try{
      const parsed=schema.safeParse(value);
      if(!parsed.success)return false;
      const expected=Object.freeze(parsed.data);
      if(await this.bounded(signal=>this.verifyInstallation(expected,signal))!==true)return false;
      const fresh=await this.lookup(expected.credentialSha256);
      if(!fresh)return false;
      return (Object.keys(expected) as Array<keyof typeof expected>).every(k=>expected[k]===fresh[k]);
    }catch{return false}
  }
}

/** Explicit service composition with a separate least-privilege DB identity.
 * Native installation verification still requires a separately provisioned
 * real verifier. No automatic migration or enabling of CORE. */
export async function startBrokerDispatchWithPostgresCredentials(config:
  Omit<ProtectedBrokerDispatchServiceOptions,'credentials'>&{
    credentialDatabase:Parameters<typeof createProtectedPostgresDispatchPool>[0];
    verifyInstallationBinding:VerifyInstallation;
  }){
  const {credentialDatabase,verifyInstallationBinding,...service}=config;
  if(credentialDatabase.user===service.database.user)
    throw Error('DISPATCH_CREDENTIAL_ROLE_MUST_BE_SEPARATE');
  const db=createProtectedPostgresDispatchPool(credentialDatabase);
  try{
    const credentials=new PostgresDispatchCredentialStore({authorityId:service.authorityId,pool:db.pool,
      verifyProvenance:service.verifyProvenance,verifyInstallationBinding});
    await credentials.assertReady();
    const listener=await startProtectedBrokerDispatchService({...service,credentials});
    let closing:Promise<void>|undefined;
    return Object.freeze({...listener,close:()=>closing??=(async()=>{
      try{await listener.close()}finally{await db.close()}
    })()});
  }catch(error){await db.close().catch(()=>{});throw error}
}
