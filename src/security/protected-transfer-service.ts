import type {DispatchStorePool,DispatchStoreConnection} from '../agent/postgres-broker-dispatch-authority.js';
import type {SignedHelperEvidenceConfig,HelperEvidenceChallenge} from './signed-helper-selection-evidence.js';
import type {HelperAuthorityEvidenceRequest} from './postgres-helper-selection-authority.js';
import {createProtectedPostgresDispatchPool} from '../agent/protected-postgres-dispatch-pool.js';
import {createProtectedTransferAuthorityServer} from './protected-transfer-authority.js';
import {PostgresProtectedTransferAuthority,composeTransferDrainObserver,type PostgresProtectedTransferConfig} from './postgres-protected-transfer-authority.js';

/** Called only inside the selection authority's existing transaction, which
 * already holds the shared core_dispatch.authorities row lock. Read on a
 * separate connection without acquiring that lock again. The native observer
 * must still supply its own fresh signed proof; no ledger state is a native
 * drain proof. No release or maintenance while any intent is unresolved. */
export function bindTransferClaimDrainEvidence(pool:DispatchStorePool,authorityId:string,native:SignedHelperEvidenceConfig):SignedHelperEvidenceConfig {
  if(typeof pool?.connect!=='function'||!authorityId||typeof native?.requestProof!=='function')
    throw Error('TRANSFER_HELPER_DRAIN_CONFIG_INVALID');
  const requestProof=native.requestProof;
  return Object.freeze({...native,async requestProof(challenge:HelperEvidenceChallenge,request:HelperAuthorityEvidenceRequest){
    if(request.scope.authorityId!==authorityId)throw Error('TRANSFER_HELPER_DRAIN_SCOPE_MISMATCH');
    if(!['RELEASE','BEGIN_DEPLOYMENT','COMMIT'].includes(request.phase))return requestProof(challenge,request);
    const started=process.hrtime.bigint();
    let db:DispatchStoreConnection|undefined,begun=false,destroy=false;
    try{
      db=await pool.connect();
      await db.query('BEGIN READ ONLY');begun=true;
      await db.query("SET LOCAL statement_timeout='1500ms'");
      await db.query("SET LOCAL lock_timeout='750ms'");
      const rows=(await db.query("SELECT COUNT(*)::bigint AS n FROM transfer_authority.claims c JOIN transfer_authority.jobs j ON j.id=c.job_id WHERE j.authority_id=$1 AND j.owner_id=$2 AND (j.source_device_id=$3 OR j.target_device_id=$3) AND c.state NOT IN ('APPLIED','NO_EFFECT')",[authorityId,request.scope.ownerId,request.scope.deviceId])).rows;
      if(rows.length!==1||!(rows[0]?.n===0||rows[0]?.n==='0'||rows[0]?.n===0n))
        throw Error('TRANSFER_HELPER_DRAIN_UNRESOLVED');
      await db.query('ROLLBACK');begun=false;
    }catch(error){destroy=true;throw error;}
    finally{if(db){if(begun&&!destroy)try{await db.query('ROLLBACK');}catch{destroy=true;}db.release(destroy);}}
    if(process.hrtime.bigint()-started>=BigInt(native.timeoutMs??3000)*1000000n)throw Error('TRANSFER_HELPER_DRAIN_DEADLINE');
    return requestProof(challenge,request);
  }});
}

/** Explicit off-host composition only; no default credentials, migration,
 * listening socket, owner enrollment, or startup enablement. */
export function createPostgresProtectedTransferService(config:{
  database:Parameters<typeof createProtectedPostgresDispatchPool>[0];
  authority:Omit<PostgresProtectedTransferConfig,'pool'>;
  server:Omit<Parameters<typeof createProtectedTransferAuthorityServer>[0],'backend'>;
}){
  if(config.authority.authorityId!==config.server.authorityId)throw Error('TRANSFER_PG_AUTHORITY_ID_MISMATCH');
  const database=createProtectedPostgresDispatchPool(config.database);
  try{
    const backend=new PostgresProtectedTransferAuthority({...config.authority,pool:database.pool});
    const server=createProtectedTransferAuthorityServer({...config.server,backend});
    return {server,backend,bindSelectionEvidence(native:SignedHelperEvidenceConfig){return bindTransferClaimDrainEvidence(database.pool,config.authority.authorityId,native);},composeDrain(verifyNativeDrain:Parameters<typeof composeTransferDrainObserver>[0]['verifyNativeDrain']){
      return composeTransferDrainObserver({pool:database.pool,authorityId:config.authority.authorityId,verifyNativeDrain});
    },async close(){
      try{if(server.listening){server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));}}finally{await database.close();}
    }};
  }catch(error){void database.close().catch(()=>undefined);throw error;}
}
