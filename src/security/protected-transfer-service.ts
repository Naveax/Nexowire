import {createProtectedPostgresDispatchPool} from '../agent/protected-postgres-dispatch-pool.js';
import {createProtectedTransferAuthorityServer} from './protected-transfer-authority.js';
import {PostgresProtectedTransferAuthority,composeTransferDrainObserver,type PostgresProtectedTransferConfig} from './postgres-protected-transfer-authority.js';

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
    return {server,backend,composeDrain(verifyNativeDrain:Parameters<typeof composeTransferDrainObserver>[0]['verifyNativeDrain']){
      return composeTransferDrainObserver({pool:database.pool,authorityId:config.authority.authorityId,verifyNativeDrain});
    },async close(){
      try{if(server.listening){server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));}}finally{await database.close();}
    }};
  }catch(error){void database.close().catch(()=>undefined);throw error;}
}
