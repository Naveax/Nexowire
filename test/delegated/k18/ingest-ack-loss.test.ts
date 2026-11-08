import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {ArtifactBridgeStore,ArtifactBridgeError} from '../../../src/workspace/artifact-bridge.js';
import {
  ingestDeviceArtifact,
  type ArtifactSourceOps,
} from '../../../src/mcp/artifact-bridge-device-ingest.js';

// #588 read-only QA of the actual bounded ingest implementation. This is a
// disposable local store; it uses no live Agent, Hub, WSS or customer file.
const scope={accountId:'account:test',projectId:'Nexowire',deviceId:'k18-qa'};
const input={scope,sourcePath:'C:\\synthetic-only\\225KiB.bin',
  artifactPath:'k18/ack-loss.bin',repository:'Naveax/Nexowire',
  commitSha:'1'.repeat(40),producerOperationId:'synthetic-k18-ack-loss',
  testStatus:'unverified' as const,acceptanceStatus:'pending' as const,
  maxChunks:16};
const bytes=Buffer.alloc(225_281);
for(let i=0;i<bytes.length;i++)bytes[i]=(i*17+3)%251;
const sha=createHash('sha256').update(bytes).digest('hex');
const source:ArtifactSourceOps={
  stat:async()=>({type:'file',size:bytes.length}),
  sha256:async()=>sha,
  read:async(_path,offset,count)=>{
    const chunk=bytes.subarray(offset,offset+count);
    return {sourceBytes:bytes.length,offsetBytes:offset,bytesRead:chunk.length,
      contentBase64:chunk.toString('base64')};
  },
};

async function withStore(run:(store:ArtifactBridgeStore)=>Promise<void>){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'nexowire-k18-ack-'));
  try{await run(new ArtifactBridgeStore(directory))}
  finally{await fs.rm(directory,{recursive:true,force:true})}
}

function withLostReceipt(store:ArtifactBridgeStore,loseAtOffset:number,
  mode:'THROW'|'WRONG_OFFSET'){
  let lost=0;
  const sourceStore=new Proxy(store,{
    get(target,property){
      if(property==='putChunk')return async (
        ...args:Parameters<ArtifactBridgeStore['putChunk']>
      )=>{
        const result=await target.putChunk(...args); // bytes durably persisted
        if(args[2]===loseAtOffset&&lost++===0){
          if(mode==='THROW')throw Error('ISOLATED_ACK_LOST');
          return {...result,offset:result.offset-1};
        }
        return result;
      };
      const value=Reflect.get(target,property,target);
      return typeof value==='function'?value.bind(target):value;
    },
  });
  return {sourceStore,lostCount:()=>lost};
}

test('T-498 #588 lost final chunk ACK cannot publish 100% even if bytes reached stage',()=>
  withStore(async store=>{
    const finalOffset=3*65_536; // fourth and final chunk for 225,281 bytes
    const {sourceStore,lostCount}=withLostReceipt(store,finalOffset,'THROW');
    await assert.rejects(ingestDeviceArtifact(sourceStore,source,input),/ISOLATED_ACK_LOST/);
    assert.equal(lostCount(),1);
    assert.equal(await store.get(scope,input.artifactPath),null);
    // Re-invocation must read verified persisted prefix and commit the digest.
    const recovered=await ingestDeviceArtifact(store,source,input);
    assert.equal(recovered.state,'COMPLETE');
    assert.equal(recovered.sha256,sha);
    assert.equal(recovered.offset,bytes.length);
    assert.equal(recovered.transferredBytes,0);
    assert.equal((await store.get(scope,input.artifactPath))?.sha256,sha);
  }));

test('T-501 #588 wrong first ACK offset aborts 225KiB ingest and cleanly resumes',()=>
  withStore(async store=>{
    const {sourceStore,lostCount}=withLostReceipt(store,0,'WRONG_OFFSET');
    await assert.rejects(ingestDeviceArtifact(sourceStore,source,input),
      (error:unknown)=>error instanceof ArtifactBridgeError&&
        error.code==='INGEST_OFFSET_MISMATCH');
    assert.equal(lostCount(),1);
    assert.equal(await store.get(scope,input.artifactPath),null);
    const recovered=await ingestDeviceArtifact(store,source,input);
    assert.equal(recovered.state,'COMPLETE');
    assert.equal(recovered.offset,bytes.length);
    assert.equal(recovered.transferredBytes,bytes.length-65_536);
    assert.equal((await store.get(scope,input.artifactPath))?.size,bytes.length);
  }));
