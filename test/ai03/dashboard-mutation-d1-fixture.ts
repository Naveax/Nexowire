/** Disposable SQLite/D1 transaction fixture only. Not hosted D1 or native approval. */
import {DatabaseSync,type StatementSync} from 'node:sqlite';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {D1ControlPlaneStore,type D1DatabaseLike,type D1PreparedStatementLike,type D1ResultLike}
  from '../../src/product/d1-control-plane-store.js';
import {ControlPlaneService} from '../../src/product/control-plane-service.js';
import {D1CoreConsoleAuthority} from '../../src/product/d1-core-console-authority.js';
class Statement implements D1PreparedStatementLike{
  constructor(private readonly stmt:StatementSync,private readonly args:unknown[]=[]){}
  bind(...args:unknown[]){return new Statement(this.stmt,args);}
  async first<T>():Promise<T|null>{return (this.stmt.get(...this.args as Parameters<StatementSync['get']>)??null) as T|null;}
  async all<T>():Promise<D1ResultLike<T>>{return {success:true,results:this.stmt.all(...this.args as Parameters<StatementSync['all']>) as T[]};}
  runSync():D1ResultLike{const result=this.stmt.run(...this.args as Parameters<StatementSync['run']>);
    return {success:true,meta:{changes:Number(result.changes)}};}
  async run<T>():Promise<D1ResultLike<T>>{return this.runSync() as D1ResultLike<T>;}
}
class Adapter implements D1DatabaseLike{
  loseNextAck=false;
  constructor(readonly db:DatabaseSync){}
  prepare(sql:string){return new Statement(this.db.prepare(sql));}
  async batch(statements:D1PreparedStatementLike[]):Promise<D1ResultLike[]>{
    this.db.exec('BEGIN IMMEDIATE');
    let results:D1ResultLike[];
    try{
      results=statements.map(s=>{
        if(!(s instanceof Statement))throw Error('unexpected fixture statement');
        return s.runSync();
      });
      this.db.exec('COMMIT');
    }catch(error){this.db.exec('ROLLBACK');throw error;}
    if(this.loseNextAck){this.loseNextAck=false;throw Error('fixture lost acknowledgement after COMMIT');}
    return results;
  }
}
export function dashboardMutationFixture(){
  const dir=mkdtempSync(path.join(tmpdir(),'nwx-dashboard-mutation-'));
  const file=path.join(dir,'authority.sqlite'),connections:DatabaseSync[]=[];
  const open=()=>{
    const db=new DatabaseSync(file);connections.push(db);
    db.exec('PRAGMA foreign_keys=ON;PRAGMA busy_timeout=3000');
    const adapter=new Adapter(db),store=new D1ControlPlaneStore(adapter),service=new ControlPlaneService(store);
    // Availability only: this fixture refuses every real consent or readback.
    const authority=new D1CoreConsoleAuthority(adapter,{verifyAndConsume:async()=>false,currentReadback:async()=>false});
    return {db,adapter,store,service,authority};
  };
  const first=open();
  const names=['0001_control_plane.sql','0002_external_identities.sql',
    '0003_quota_subject_device_anchor.sql','0004_device_credential_lookup.sql',
    '0009_device_access_mode.sql','0010_device_runtime_telemetry.sql',
    '0011_device_root_mode_leases.sql','0012_owner_device_folders.sql',
    '0013_owner_device_selection.sql','0014_device_maintenance_preferences.sql',
    '0015_device_bridge_preferences.sql','0016_device_bridge_commands.sql',
    '0019_core_console_authority.sql','0020_core_console_native_logon_binding.sql',
    '0021_core_console_native_claim_verified.sql','0022_remote_agent_authorization_epoch.sql',
    '0090_dashboard_mutation_identity.sql'];
  try{
    for(const name of names)first.db.exec(readFileSync(path.join(process.cwd(),'cloudflare','migrations',name),'utf8'));
  }catch(error){for(const db of connections)db.close();rmSync(dir,{recursive:true,force:true});throw error;}
  return {...first,open,close(){for(const db of connections)db.close();rmSync(dir,{recursive:true,force:true});}};
}
