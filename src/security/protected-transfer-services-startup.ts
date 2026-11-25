import {isIP} from 'node:net';
import {createPostgresProtectedTransferService} from './protected-transfer-service.js';
import {createRollbackGuardedHelperSelectionService} from './protected-helper-rollback-guard.js';
import {assertHelperStartupScope,composeHelperSelectionRevokeDrain} from './protected-helper-revoke-drain.js';
import {createProtectedPostgresDispatchPool} from '../agent/protected-postgres-dispatch-pool.js';
import {startProtectedBrokerDispatchService,type ProtectedBrokerDispatchServiceOptions} from '../agent/protected-broker-dispatch-service.js';
import type {LargeTransferScope} from '../mcp/durable-large-transfer.js';

type TransferConfig=Parameters<typeof createPostgresProtectedTransferService>[0];
type SelectionConfig=Parameters<typeof createRollbackGuardedHelperSelectionService>[0];
type Database=TransferConfig['database'];
type RevokeRequest=Parameters<ProtectedBrokerDispatchServiceOptions['verifyNativeDrain']>[0];
export interface ProtectedTransferServicesStartup {
  transfer:TransferConfig;
  selection:SelectionConfig;
  core:ProtectedBrokerDispatchServiceOptions;
  transferHost:string;
  transferPort:number;
  selectionHost:string;
  selectionPort:number;
  startupScope:LargeTransferScope;
  /** Independent permanent drain of the target Publisher/runtime and helper
   * lifecycle effects, scoped to the actual revoke. Never a socket ACK or
   * empty DB result. Must not call a selection READ while CORE holds its lock. */
  verifyTransferRuntimeDrain:(request:RevokeRequest,signal?:AbortSignal)=>Promise<boolean>;
}
const sameDatabase=(a:Database,b:Database)=>a.host===b.host&&a.port===b.port&&a.database===b.database&&a.caPem===b.caPem;
const endpoint=(host:string,port:number)=>typeof host==='string'&&isIP(host)!==0&&Number.isInteger(port)&&port>0&&port<=65535;
type Listener=ReturnType<typeof createPostgresProtectedTransferService>['server'];
async function listen(server:Listener,host:string,port:number){
  await new Promise<void>((resolve,reject)=>{
    const failed=()=>reject(Error('TRANSFER_AUTHORITY_LISTEN_FAILED'));
    server.once('error',failed);
    server.listen({host,port,exclusive:true},()=>{server.off('error',failed);resolve();});
  });
  const address=server.address();
  if(!address||typeof address==='string')throw Error('TRANSFER_AUTHORITY_LISTEN_FAILED');
  return address;
}
/** Off-host production entrypoint. Three actual TLS listeners share the
 * independent authority row. No implicit enrollment, migration, signing,
 * native evidence issuer, or local fallback. */
export async function startProtectedTransferAndCoreServices(config:ProtectedTransferServicesStartup){
  const {core,transfer,selection,transferHost,transferPort,selectionHost,selectionPort,startupScope}=config;
  const scope=selection?.authority?.scope;
  if(!core||!transfer||!selection||!scope||!startupScope||!transfer.database||!core.database||!selection.database||
    !transfer.authority||!transfer.server||core.authorityId!==transfer.authority.authorityId||
    core.authorityId!==transfer.server.authorityId||core.authorityId!==scope.authorityId||
    scope.ownerId!==startupScope.ownerId||scope.deviceId!==startupScope.targetDeviceId||
    !sameDatabase(core.database,transfer.database)||!sameDatabase(core.database,selection.database)||
    typeof core.verifyNativeDrain!=='function'||typeof config.verifyTransferRuntimeDrain!=='function'||
    typeof transfer.server.verifyIndependentProvenance!=='function'||typeof selection.authority.verifyProvenance!=='function'||
    !endpoint(transferHost,transferPort)||!endpoint(selectionHost,selectionPort)||
    new Set([core.port,transferPort,selectionPort]).size!==3)
    throw Error('TRANSFER_CORE_SHARED_AUTHORITY_STARTUP_REQUIRED');
  const service=createPostgresProtectedTransferService(transfer);
  let helper:ReturnType<typeof createRollbackGuardedHelperSelectionService>|undefined;
  let helperReadPool:ReturnType<typeof createProtectedPostgresDispatchPool>|undefined;
  let coreService:Awaited<ReturnType<typeof startProtectedBrokerDispatchService>>|undefined;
  let closing:Promise<void>|undefined;
  const close=()=>closing??=(async()=>{
    try{await coreService?.close();}finally{try{await helper?.close();}finally{try{await helperReadPool?.close();}finally{await service.close();}}}
  })();
  try{
    if(await transfer.server.verifyIndependentProvenance()!==true)throw Error('TRANSFER_AUTHORITY_PROVENANCE_UNVERIFIED');
    const p=await selection.authority.verifyProvenance();
    if(!p||p.verified!==true||p.authorityId!==scope.authorityId||!Number.isSafeInteger(p.validUntil)||p.validUntil<=Date.now())
      throw Error('HELPER_AUTHORITY_PROVENANCE_UNVERIFIED');
    await service.backend.assertGrant(startupScope);
    helper=createRollbackGuardedHelperSelectionService(selection);
    helperReadPool=createProtectedPostgresDispatchPool(selection.database);
    await assertHelperStartupScope(helperReadPool.pool,scope);
    const verifyCoreDrain:(request:RevokeRequest,signal?:AbortSignal)=>Promise<boolean>=core.verifyNativeDrain;
    const helperDrain=composeHelperSelectionRevokeDrain({pool:helperReadPool.pool,scope,nativeEvidence:selection.nativeEvidence,
      verifyExistingNativeDrain:async (request,signal)=>!signal?.aborted&&await verifyCoreDrain(request,signal)===true&&!signal?.aborted&&await config.verifyTransferRuntimeDrain(request,signal)===true&&!signal?.aborted});
    coreService=await startProtectedBrokerDispatchService({...core,
      verifyNativeDrain:(request:RevokeRequest,signal?:AbortSignal)=>service.composeDrain(async bound=>
        !signal?.aborted&&bound.ownerId===request.ownerId&&bound.deviceId===request.deviceId&&await helperDrain(request,signal)===true&&!signal?.aborted)(request),
    });
    if(await transfer.server.verifyIndependentProvenance()!==true)throw Error('TRANSFER_AUTHORITY_PROVENANCE_UNVERIFIED');
    const transferAddress=await listen(service.server,transferHost,transferPort);
    const helperAddress=await listen(helper.server,selectionHost,selectionPort);
    service.server.on('error',()=>{void close().catch(()=>{});});
    helper.server.on('error',()=>{void close().catch(()=>{});});
    return Object.freeze({transferAddress:transferAddress.address,transferPort:transferAddress.port,
      selectionAddress:helperAddress.address,selectionPort:helperAddress.port,
      coreAddress:coreService.address,corePort:coreService.port,physicalAcceptance:'NOT_PROVEN' as const,close});
  }catch(error){
    await close().catch(()=>{});
    throw error;
  }
}
