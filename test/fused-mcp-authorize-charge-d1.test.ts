import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {DatabaseSync,type StatementSync} from 'node:sqlite';
import {
  D1ControlPlaneStore,
  type D1DatabaseLike,type D1PreparedStatementLike,type D1ResultLike,
} from '../src/product/d1-control-plane-store.js';
import {ControlPlaneService} from '../src/product/control-plane-service.js';
import {createFusedMcpAuthorizeChargeHandler} from '../src/product/fused-mcp-authorize-charge.js';

class SQLiteStatement implements D1PreparedStatementLike {
  constructor(
    private readonly statement:StatementSync,
    private readonly values:unknown[]=[],
  ) {}
  bind(...values:unknown[]):D1PreparedStatementLike {
    return new SQLiteStatement(this.statement,values);
  }
  async first<T>():Promise<T|null>{
    return (this.statement.get(...(this.values as Parameters<StatementSync['get']>))??null) as T|null;
  }
  async all<T>():Promise<D1ResultLike<T>>{
    return {success:true,results:this.statement.all(
      ...(this.values as Parameters<StatementSync['all']>),
    ) as T[]};
  }
  async run<T>():Promise<D1ResultLike<T>>{
    const output=this.statement.run(
      ...(this.values as Parameters<StatementSync['run']>),
    );
    return {success:true,meta:{changes:Number(output.changes)}};
  }
}
class SQLiteAdapter implements D1DatabaseLike {
  constructor(private readonly db:DatabaseSync){}
  prepare(sql:string):D1PreparedStatementLike{
    return new SQLiteStatement(this.db.prepare(sql));
  }
  async batch(statements:D1PreparedStatementLike[]):Promise<D1ResultLike[]>{
    this.db.exec('BEGIN');
    try {
      const results=[];
      for(const statement of statements)results.push(await statement.run());
      this.db.exec('COMMIT');
      return results;
    } catch(error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}
function migrate(db:DatabaseSync){
  for(const name of [
    '0001_control_plane.sql','0002_external_identities.sql',
    '0003_quota_subject_device_anchor.sql','0004_device_credential_lookup.sql',
    '0009_device_access_mode.sql','0010_device_runtime_telemetry.sql',
    '0011_device_root_mode_leases.sql','0012_owner_device_folders.sql',
    '0013_owner_device_selection.sql','0014_device_maintenance_preferences.sql',
    '0015_device_bridge_preferences.sql','0016_device_bridge_commands.sql',
  ]){
    db.exec(readFileSync(path.join(process.cwd(),'cloudflare','migrations',name),'utf8'));
  }
}
function req(id:string) {
  return new Request('https://test.example/api/v1/internal/mcp/authorize-charge',{
    method:'POST',headers:{
      'content-type':'application/json',
      authorization:'Bearer VALID_SERVICE',
    },
    body:JSON.stringify({
      accessToken:'nwx_mcp_valid-token-from-oauth',
      toolName:'machine_health',invocationId:id,
    }),
  });
}

test('fused MCP handler reuses real SQLite D1 idempotency ledger and Free quota',async()=>{
  const db=new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);
  try {
    const store=new D1ControlPlaneStore(new SQLiteAdapter(db));
    const service=new ControlPlaneService(store,{
      now:()=>new Date('2026-10-15T14:00:00.000Z'),
    });
    await service.ensureAccount({id:'d1-fused-account'});
    const handler=createFusedMcpAuthorizeChargeHandler({
      authenticateService:async r=>r.headers.get('authorization')==='Bearer VALID_SERVICE',
      authenticateAccessToken:async token=>
        token==='nwx_mcp_valid-token-from-oauth'
          ?{accountId:'d1-fused-account',scopes:['mcp']}:null,
      store,
      chargeUsage:input=>service.chargeUsage(input),
    });
    const outcomes=await Promise.all(Array.from({length:10},()=>
      handler(req('s1-sqlite-replay-01'))));
    assert.equal(outcomes.filter(x=>x.status===200).length,1);
    assert.equal(outcomes.filter(x=>x.status===409).length,9);
    const account=await service.dashboard({accountId:'d1-fused-account',role:'user'});
    assert.equal(account.usage.usedCredits,1);

    await service.chargeUsage({
      accountId:'d1-fused-account',eventId:'fill-the-current-month',
      toolName:'machine_health',baseCredits:999,
    });
    const expired=await handler(req('s1-sqlite-overflow-02'));
    assert.equal(expired.status,429);
    const after=await service.dashboard({accountId:'d1-fused-account',role:'user'});
    assert.equal(after.usage.usedCredits,1000);
    const body=JSON.stringify(await expired.json());
    assert.equal(body.includes('d1-fused-account'),false);
    assert.equal(body.includes('nwx_mcp_valid-token'),false);
  } finally { db.close(); }
});
