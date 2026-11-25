import {isIP} from 'node:net';
import {createPostgresProtectedTransferService} from './protected-transfer-service.js';
import {startProtectedBrokerDispatchService,type ProtectedBrokerDispatchServiceOptions} from '../agent/protected-broker-dispatch-service.js';
import type {LargeTransferScope} from '../mcp/durable-large-transfer.js';

type TransferConfig=Parameters<typeof createPostgresProtectedTransferService>[0];
export interface ProtectedTransferServicesStartup {
  transfer:TransferConfig;
  core:ProtectedBrokerDispatchServiceOptions;
  transferHost:string;
  transferPort:number;
  startupScope:LargeTransferScope;
}
/** Off-host production entrypoint: start both actual mTLS listeners with the
 * existing shared PostgreSQL authority row and transfer-aware CORE drain.
 * Separate least-privilege DB roles are allowed; cluster/database/trust
 * configuration and authority identity must agree. No local fallback. */
export async function startProtectedTransferAndCoreServices(config:ProtectedTransferServicesStartup){
  const {core,transfer,transferHost,transferPort,startupScope}=config;
  if(!core||!transfer||!startupScope||!transfer.database||!core.database||
    !transfer.authority||!transfer.server||core.authorityId!==transfer.authority.authorityId||
    core.authorityId!==transfer.server.authorityId||
    core.database.host!==transfer.database.host||core.database.port!==transfer.database.port||
    core.database.database!==transfer.database.database||core.database.caPem!==transfer.database.caPem||
    typeof core.verifyNativeDrain!=='function'||typeof transfer.server.verifyIndependentProvenance!=='function'||
    typeof transferHost!=='string'||isIP(transferHost)===0||!Number.isInteger(transferPort)||transferPort<1||transferPort>65535||
    (transferHost===core.host&&transferPort===core.port))
    throw Error('TRANSFER_CORE_SHARED_AUTHORITY_STARTUP_REQUIRED');
  const service=createPostgresProtectedTransferService(transfer);
  let coreService:Awaited<ReturnType<typeof startProtectedBrokerDispatchService>>|undefined;
  let closing:Promise<void>|undefined;
  const close=()=>closing??=(async()=>{
    try{await coreService?.close();}finally{await service.close();}
  })();
  try{
    // This read-only startup check actually reaches the protected DB and
    // validates its role, durability, provenance, exact grant and row lock.
    if(await transfer.server.verifyIndependentProvenance()!==true)throw Error('TRANSFER_AUTHORITY_PROVENANCE_UNVERIFIED');
    await service.backend.assertGrant(startupScope);
    coreService=await startProtectedBrokerDispatchService({...core,
      verifyNativeDrain:request=>service.composeDrain(async scope=>
        scope.ownerId===request.ownerId&&scope.deviceId===request.deviceId&&await core.verifyNativeDrain(request)===true)(request),
    });
    if(await transfer.server.verifyIndependentProvenance()!==true)throw Error('TRANSFER_AUTHORITY_PROVENANCE_UNVERIFIED');
    await new Promise<void>((resolve,reject)=>{
      const failed=()=>reject(Error('TRANSFER_AUTHORITY_LISTEN_FAILED'));
      service.server.once('error',failed);
      service.server.listen({host:transferHost,port:transferPort,exclusive:true},()=>{
        service.server.off('error',failed);resolve();
      });
    });
    service.server.on('error',()=>{void close().catch(()=>{});});
    const address=service.server.address();
    if(!address||typeof address==='string')throw Error('TRANSFER_AUTHORITY_LISTEN_FAILED');
    return Object.freeze({transferAddress:address.address,transferPort:address.port,
      coreAddress:coreService.address,corePort:coreService.port,physicalAcceptance:'NOT_PROVEN' as const,close});
  }catch(error){
    await close().catch(()=>{});
    throw error;
  }
}
