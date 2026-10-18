import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {AgentOperationJournal} from '../src/agent/operation-journal.js';

const fingerprint='a'.repeat(64);

/** A disposable, already-killed process leaves an authentic hot SQLite WAL. */
async function hotWal(t:import('node:test').TestContext) {
  const dir=await mkdtemp(path.join(os.tmpdir(),'nw-wal-proof-'));
  const file=path.join(dir,'operations.sqlite');
  const id=randomUUID();
  const source=new URL('../src/agent/operation-journal.ts',import.meta.url).href;
  const script=[
    'import {AgentOperationJournal} from '+JSON.stringify(source)+';',
    'const journal=new AgentOperationJournal('+JSON.stringify(file)+');',
    'await journal.begin('+JSON.stringify(id)+','+JSON.stringify(fingerprint)+',"shell.exec");',
    'await journal.markDispatched('+JSON.stringify(id)+','+JSON.stringify(fingerprint)+');',
    'console.log("JOURNAL_READY");',
    'setInterval(()=>{},1000);',
  ].join('\n');
  const child=spawn(process.execPath,
    ['--import','tsx','--input-type=module','-e',script],
    {cwd:process.cwd(),stdio:['ignore','pipe','pipe']});
  t.after(async()=>{
    if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');
    await rm(dir,{recursive:true,force:true});
  });
  await new Promise<void>((resolve,reject)=>{
    let output='',stderr='';
    const timeout=setTimeout(()=>reject(new Error(
      'Disposable child did not commit journal: '+stderr.slice(0,300))),20000);
    const clear=()=>clearTimeout(timeout);
    child.stdout?.on('data',chunk=>{
      output+=String(chunk);
      if(output.includes('JOURNAL_READY')){clear();resolve()}
    });
    child.stderr?.on('data',chunk=>{stderr+=String(chunk)});
    child.once('error',e=>{clear();reject(e)});
    child.once('exit',code=>{
      if(!output.includes('JOURNAL_READY')){
        clear();reject(new Error('Child exited '+code+': '+stderr.slice(0,300)));
      }
    });
  });
  assert.equal(child.kill('SIGKILL'),true);
  await new Promise<void>(resolve=>child.once('exit',()=>resolve()));
  const original=await readFile(file+'-wal');
  assert.ok(original.length>32+24);
  const magic=original.readUInt32BE(0);
  assert.ok(magic===0x377f0682||magic===0x377f0683);
  return {file,id,original};
}

test('authentic hot WAL passes frame checks and recovers as UNKNOWN',async t=>{
  const {file,id,original}=await hotWal(t);
  const journal=new AgentOperationJournal(file);
  try{
    const result=await journal.inspect(id);
    assert.equal(result?.status,'unknown');
    assert.ok(result?.dispatchedAt);
    assert.equal((await journal.begin(id,fingerprint,'shell.exec')).created,false);
  }finally{journal.close()}
  assert.ok(original.length>4000);
});

for(const [name,corrupt] of [
  ['frame data checksum', (buffer:Buffer)=>{
    buffer[32+24+47]!^=0x40;
  }],
  ['frame checksum field',(buffer:Buffer)=>{
    buffer[32+16]!^=0x40;
  }],
  ['header checksum field',(buffer:Buffer)=>{
    buffer[24]!^=0x40;
  }],
  ['valid magic but invalid page size',(buffer:Buffer)=>{
    buffer.writeUInt32BE(127,8);
  }],
] as const) {
  test('WAL '+name+' damage fails closed before SQLite recovery',async t=>{
    const {file,id,original}=await hotWal(t);
    const broken=Buffer.from(original);
    corrupt(broken);
    await writeFile(file+'-wal',broken);
    const journal=new AgentOperationJournal(file);
    await assert.rejects(journal.inspect(id),{
      code:'AGENT_JOURNAL_WAL_CORRUPT',
    });
    assert.deepEqual(await readFile(file+'-wal'),broken);
  });
}

test('torn final WAL frame refuses recovery instead of silently truncating',async t=>{
  const {file,id,original}=await hotWal(t);
  const truncated=original.subarray(0,original.length-1);
  await writeFile(file+'-wal',truncated);
  const journal=new AgentOperationJournal(file);
  await assert.rejects(journal.begin(id,fingerprint,'shell.exec'),{
    code:'AGENT_JOURNAL_WAL_CORRUPT',
  });
  assert.deepEqual(await readFile(file+'-wal'),truncated);
});
