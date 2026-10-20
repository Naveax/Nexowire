/**
 * Dedicated synthetic worker PROCESS for SQLite WAL multi-writer evidence.
 * NOT a Cloudflare Worker isolate and NOT a real Cloudflare D1 deployment.
 * Its only inputs are disposable file paths and fake account credentials.
 */
import {DatabaseSync, type StatementSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import type {
  D1DatabaseLike,D1PreparedStatementLike,D1ResultLike,
} from '../../src/product/d1-control-plane-store.js';
import {ProposedV2QuotaD1Ledger} from '../../src/product/v2-quota-d1-staging.js';
import type {QuotaEntitlementDecisionV2} from '../../src/product/subscription-entitlements-v2-proposal.js';

type Grant=Extract<QuotaEntitlementDecisionV2,{status:'allowed'}>;
type Work={invocationId:string;fingerprintSeed?:string;at:string;credits:number};
type Input={kind:'go';entitlement:Grant;tasks:Work[]};

class Stmt implements D1PreparedStatementLike {
  constructor(private readonly s:StatementSync,private readonly a:unknown[]=[]){}
  bind(...args:unknown[]):D1PreparedStatementLike{return new Stmt(this.s,args)}
  async first<T>():Promise<T|null>{
    return (this.s.get(...this.a as Parameters<StatementSync['get']>)??null) as T|null;
  }
  async all<T>():Promise<D1ResultLike<T>>{
    return {success:true,results:this.s.all(...this.a as Parameters<StatementSync['all']>) as T[]};
  }
  async run<T>():Promise<D1ResultLike<T>>{
    return {success:true,meta:{changes:Number(this.s.run(...this.a as Parameters<StatementSync['run']>).changes)}};
  }
}
class DB implements D1DatabaseLike {
  constructor(private readonly db:DatabaseSync){}
  prepare(sql:string):D1PreparedStatementLike{return new Stmt(this.db.prepare(sql))}
  async batch(items:D1PreparedStatementLike[]):Promise<D1ResultLike[]>{
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const results=[];
      for(const item of items)results.push(await item.run());
      this.db.exec('COMMIT');
      return results;
    }catch(error){this.db.exec('ROLLBACK');throw error}
  }
}

const file=process.argv[2];
if(!file)throw new Error('ISOLATED_STAGING_DB_REQUIRED');
const sqlite=new DatabaseSync(file);
sqlite.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=15000; PRAGMA journal_mode=WAL;');
const ledger=new ProposedV2QuotaD1Ledger(new DB(sqlite));
process.send?.({kind:'ready'});
let started=false;
process.on('message',(raw:Input)=>{
  if(started||raw?.kind!=='go')return;
  started=true;
  void (async()=>{
    try{
      const statuses:string[]=[];
      for(const t of raw.tasks){
        const result=await ledger.reserve({
          entitlement:raw.entitlement,
          invocationId:t.invocationId,
          requestFingerprint:createHash('sha256')
            .update(t.fingerprintSeed??'canonical-root:'+t.invocationId).digest('hex'),
          now:new Date(t.at),
          toolCredits:t.credits,
        });
        statuses.push(result.status);
      }
      sqlite.close();
      process.send?.({kind:'result',statuses},()=>process.exit(0));
    }catch(error){
      try{sqlite.close()}catch{}
      process.send?.({
        kind:'error',
        error:error instanceof Error?error.name+':'+error.message:'Unknown worker failure',
      },()=>process.exit(1));
    }
  })();
});
