import type { D1DatabaseLike } from './d1-control-plane-store.js';

/**
 * Read-only STAGING acceptance. No D1 migration or production write occurs.
 * Missing/partial legacy schemas must never be mistaken for verified
 * session revoke support, especially after a partially deployed worker.
 */
export async function assertRootSessionMigrationStaged(
  db: D1DatabaseLike,
): Promise<Readonly<{ready:true; scope:'schema-only'; privilegedExecutionProven:false}>> {
  try {
    const schema=await db.prepare(
      "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name IN ("+
      "'control_plane_revoked_sessions','device_root_session_grants',"+
      "'idx_control_plane_revoked_session_expiry','idx_root_session_grants_session',"+
      "'device_root_mode_leases')",
    ).all<{type:string;name:string;tbl_name:string;sql:string|null}>();
    if(schema.success!==true || !Array.isArray(schema.results))throw Error('SCHEMA_UNAVAILABLE');
    const rows=new Map(schema.results.map(r=>[r.name,r]));
    if(rows.size!==5 || schema.results.length!==5)throw Error('SCHEMA_INCOMPLETE');
    for(const table of ['control_plane_revoked_sessions','device_root_session_grants',
      'device_root_mode_leases']) {
      const row=rows.get(table);
      if(!row || row.type!=='table' || row.tbl_name!==table || !row.sql) {
        throw Error('TABLE_MISSING_OR_WRONG_TYPE');
      }
    }
    for(const [name,parent] of [
      ['idx_control_plane_revoked_session_expiry','control_plane_revoked_sessions'],
      ['idx_root_session_grants_session','device_root_session_grants'],
    ] as const) {
      const row=rows.get(name);
      if(!row || row.type!=='index' || row.tbl_name!==parent || !row.sql) {
        throw Error('INDEX_MISSING');
      }
    }
    const indexes = [
      ['idx_control_plane_revoked_session_expiry',['expires_at']],
      ['idx_root_session_grants_session',['owner_account_id','session_hash']],
    ] as const;
    for(const [index,expectedColumns] of indexes){
      const result=await db.prepare("PRAGMA index_info('"+index+"')").all<{
        seqno:number;name:string;
      }>();
      if(result.success!==true || result.results?.length!==expectedColumns.length ||
        result.results.some((column,i)=>column.seqno!==i ||
          column.name!==expectedColumns[i])){
        throw Error('INDEX_COLUMNS_MISMATCH');
      }
    }
    const expected:ReadonlyArray<readonly [string,ReadonlyArray<readonly [string,string,number,number]>]>=[
      ['control_plane_revoked_sessions',[
        ['session_hash','TEXT',1,1],['owner_account_id','TEXT',1,0],
        ['expires_at','TEXT',1,0],['revoked_at','TEXT',1,0],
      ]],
      ['device_root_session_grants',[
        ['device_id','TEXT',1,1],['owner_account_id','TEXT',1,0],
        ['session_hash','TEXT',1,0],['issued_at','TEXT',1,0],
        ['expires_at','TEXT',1,0],
      ]],
      ['device_root_mode_leases',[
        ['device_id','TEXT',1,1],['owner_account_id','TEXT',1,0],
        ['expires_at','TEXT',1,0],['updated_at','TEXT',1,0],
      ]],
    ];
    for(const [table,columns] of expected) {
      // Only hardcoded table names. SQLite D1 PRAGMAs are read-only here.
      const result=await db.prepare("PRAGMA table_info('"+table+"')").all<{
        name:string;type:string;notnull:number;pk:number;
      }>();
      if(result.success!==true || result.results?.length!==columns.length) {
        throw Error('COLUMN_COUNT_MISMATCH');
      }
      for(let i=0;i<columns.length;i++){
        const actual=result.results[i], [name,type,notnull,pk]=columns[i]!;
        if(!actual || actual.name!==name || actual.type.toUpperCase()!==type ||
          actual.notnull!==notnull || actual.pk!==pk)throw Error('COLUMN_MISMATCH');
      }
      const sql=(rows.get(table)?.sql||'').replace(/\s+/g,' ').toUpperCase();
      if(table!=='device_root_mode_leases' &&
        !/CHECK\s*\(\s*LENGTH\s*\(\s*SESSION_HASH\s*\)\s*=\s*64\s*\)/.test(sql)){
        throw Error('HASH_CHECK_MISSING');
      }
      if(table==='device_root_session_grants' &&
        !/CHECK\s*\(\s*EXPIRES_AT\s*>\s*ISSUED_AT\s*\)/.test(sql)){
        throw Error('EXPIRY_CHECK_MISSING');
      }
    }
    const fks=await db.prepare(
      "PRAGMA foreign_key_list('device_root_session_grants')",
    ).all<{table:string;from:string;to:string;on_delete:string}>();
    if(fks.success!==true || !fks.results?.some(f=>
      f.table==='devices' && f.from==='device_id' && f.to==='id' &&
      f.on_delete.toUpperCase()==='CASCADE'))throw Error('FK_MISSING');
    return Object.freeze({
      ready:true as const,scope:'schema-only' as const,
      privilegedExecutionProven:false as const,
    });
  } catch {
    // No schema details should be used to convert an UNKNOWN auth outcome
    // into an allowed/retried mutation.
    throw new Error('ROOT_SESSION_MIGRATION_NOT_STAGED');
  }
}
