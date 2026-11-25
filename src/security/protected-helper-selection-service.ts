import {createProtectedPostgresDispatchPool} from '../agent/protected-postgres-dispatch-pool.js';
import {PostgresHelperSelectionAuthority,type HelperSelectionAuthorityConfig} from './postgres-helper-selection-authority.js';
import {createProtectedHelperSelectionServer} from './protected-helper-selection-transport.js';
import {createSignedHelperSelectionEvidenceVerifier,type SignedHelperEvidenceConfig} from './signed-helper-selection-evidence.js';

/** Explicit off-host service composition. No ambient DB credentials, schema
 * migration, listener startup, local evidence issuer or owner enrollment. */
export function createPostgresHelperSelectionService(config:{
  database:Parameters<typeof createProtectedPostgresDispatchPool>[0];
  authority:Omit<HelperSelectionAuthorityConfig,'pool'|'verifyEvidence'>;
  nativeEvidence:SignedHelperEvidenceConfig;
  server:Omit<Parameters<typeof createProtectedHelperSelectionServer>[0],'backend'|'scope'>;
}){
  const db=createProtectedPostgresDispatchPool(config.database);
  try{
    const backend=new PostgresHelperSelectionAuthority({...config.authority,pool:db.pool,
      verifyEvidence:createSignedHelperSelectionEvidenceVerifier(config.nativeEvidence)});
    const server=createProtectedHelperSelectionServer({...config.server,scope:config.authority.scope,backend});
    let closing:Promise<void>|undefined;
    return {backend,server,close:()=>closing??=(async()=>{
      try{if(server.listening){server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));}}
      finally{await db.close();}
    })()};
  }catch(error){void db.close().catch(()=>{});throw error;}
}
