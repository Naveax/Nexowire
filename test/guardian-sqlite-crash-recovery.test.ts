import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {
  GUARDIAN_REPLAY_SCHEMA,
  createGuardianSqliteReplayReserve,
} from '../src/agent/guardian-sqlite-replay-ledger.js';

const request='11111111-1111-4111-8111-111111111111';
const deviceId='device-1';
const binding='a'.repeat(64);
const revision='owner-revision-1';
const pairing={
  deviceId,credentialBinding:binding,preferenceRevision:revision,
  currentlyAuthorized:true,
  approvedRequestId:request,approvedPreferenceRevision:revision,
};

type CrashPoint='after_commit'|'before_commit';

function createFixture(){
  const directory=mkdtempSync(path.join(tmpdir(),'guardian-crash-replay-'));
  const filename=path.join(directory,'replay.sqlite');
  const db=new DatabaseSync(filename);
  try{db.exec(GUARDIAN_REPLAY_SCHEMA)}finally{db.close()}
  return {
    directory,filename,
    cleanup:()=>rmSync(directory,{recursive:true,force:true}),
  };
}

/**
 * The child holds its own SQLite connection alive after reporting READY.
 * Parent force-terminates only this child, then reopens the disposable DB.
 * This models abrupt process loss, NOT physical power loss or storage flush.
 */
async function crashChild(filename:string,point:CrashPoint):Promise<void>{
  const library=new URL('../src/agent/guardian-sqlite-replay-ledger.ts',import.meta.url).href;
  const code=[
    "import {DatabaseSync} from 'node:sqlite';",
    'const {createGuardianSqliteReplayReserve}=await import('+JSON.stringify(library)+');',
    'const db=new DatabaseSync(process.argv[1]);',
    "if(process.argv[2]==='before_commit'){",
    " db.exec('PRAGMA journal_mode=DELETE;PRAGMA synchronous=EXTRA;BEGIN IMMEDIATE');",
    " db.prepare('INSERT INTO guardian_used_requests (request_digest,device_digest,binding_digest,revision_digest) VALUES (?,?,?,?)').run('b'.repeat(64),'c'.repeat(64),'d'.repeat(64),'e'.repeat(64));",
    '} else {',
    ' const reserve=createGuardianSqliteReplayReserve({',
    '  database:db,assertProtected:()=>{},',
    '  readCurrentPairing:async()=>({',
    "   deviceId:'device-1',credentialBinding:'a'.repeat(64),",
    "   preferenceRevision:'owner-revision-1',currentlyAuthorized:true,",
    "   approvedRequestId:'11111111-1111-4111-8111-111111111111',",
    "   approvedPreferenceRevision:'owner-revision-1',",
    '  }),',
    ' });',
    " const won=await reserve('11111111-1111-4111-8111-111111111111','device-1','a'.repeat(64),'owner-revision-1');",
    " if(!won)process.exit(8);",
    '}',
    "process.stdout.write('READY\\n',()=>setInterval(()=>{},1000));",
  ].join('\n');
  const child=spawn(process.execPath,[
    '--import','tsx','--input-type=module','-e',code,filename,point,
  ],{windowsHide:true,stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data',(chunk:string)=>{stderr+=chunk;});
  let readyTimer:ReturnType<typeof setTimeout>|undefined;
  const ready=new Promise<void>((resolve,reject)=>{
    readyTimer=setTimeout(()=>reject(new Error('CHILD_READY_TIMEOUT: '+stderr)),25000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data',(chunk:string)=>{
      stdout+=chunk;
      if(stdout.includes('READY\n')){
        if(readyTimer)clearTimeout(readyTimer);
        resolve();
      }
    });
    child.once('error',reject);
    child.once('exit',(code,signal)=>{
      reject(new Error('CHILD_EXITED_BEFORE_READY: '+code+' '+signal+' '+stderr));
    });
  });
  let closeTimer:ReturnType<typeof setTimeout>|undefined;
  const closed=new Promise<void>((resolve,reject)=>{
    child.once('close',()=>resolve());
    child.once('error',reject);
  });
  try{
    await ready;
    assert.equal(child.kill('SIGKILL'),true,'must terminate only isolated child');
    await Promise.race([
      closed,
      new Promise<never>((_,reject)=>{
        closeTimer=setTimeout(()=>reject(new Error('CHILD_EXIT_TIMEOUT')),10000);
      }),
    ]);
  }finally{
    if(readyTimer)clearTimeout(readyTimer);
    if(closeTimer)clearTimeout(closeTimer);
    if(!child.killed)child.kill('SIGKILL');
  }
}

for(const point of ['after_commit','before_commit'] as const){
  test('Guardian SQLite abrupt process death '+point+' has safe replay semantics',{
    timeout:60000,
  },async()=>{
    const f=createFixture();
    try{
      await crashChild(f.filename,point);
      const db=new DatabaseSync(f.filename);
      try{
        const reserve=createGuardianSqliteReplayReserve({
          database:db,
          readCurrentPairing:async()=>pairing,
          assertProtected:()=>{},
        });
        const accepted=await reserve(request,deviceId,binding,revision);
        assert.equal(accepted,point==='before_commit',
          'committed requests must be consumed; uncommitted markers must roll back');
        const row=(db.prepare(
          'SELECT COUNT(*) AS total FROM guardian_used_requests',
        ).get() as {total:number}).total;
        assert.equal(row,1,'one durable replay marker after recovery');
      }finally{db.close()}
    }finally{f.cleanup()}
  });
}
