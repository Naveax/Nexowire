import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {ArtifactBridgeStore,ArtifactBridgeError}
  from '../../../src/workspace/artifact-bridge.js';
import {ingestDeviceArtifact,type ArtifactSourceOps}
  from '../../../src/mcp/artifact-bridge-device-ingest.js';

// #588 / T-672: final ACK loss does NOT waive source SHA readback. No real
// device, network or shared state is involved; one disposable local store.
test('T-672 lost final ACK followed by inconsistent source readback stays uncommitted',async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'k18-p006-digest-'));
  try{
    const bytes=Buffer.alloc(225_281,0x65);
    const sha=createHash('sha256').update(bytes).digest('hex');
    const scope={accountId:'account:test',projectId:'Nexowire',deviceId:'k18-digest'};
    const input={scope,sourcePath:'C:\\synthetic-only\\ack-replay.bin',
      artifactPath:'k18/p006-final-ack.bin',repository:'Naveax/Nexowire',
      commitSha:'3'.repeat(40),producerOperationId:'k18-p006-digest-replay',
      testStatus:'unverified' as const,acceptanceStatus:'pending' as const,
      maxChunks:16};
    const store=new ArtifactBridgeStore(directory);
    const stable:ArtifactSourceOps={
      stat:async()=>({type:'file',size:bytes.length}),
      sha256:async()=>sha,
      read:async(_,offset,count)=>{
        const chunk=bytes.subarray(offset,offset+count);
        return {sourceBytes:bytes.length,offsetBytes:offset,
          bytesRead:chunk.length,contentBase64:chunk.toString('base64')};
      },
    };
    let lost=false;
    const missingAck=new Proxy(store,{
      get(target,property){
        if(property==='putChunk')return async(
          ...args:Parameters<ArtifactBridgeStore['putChunk']>
        )=>{
          const result=await target.putChunk(...args);
          if(!lost&&args[2]===3*65_536){
            lost=true;
            throw Error('ISOLATED_FINAL_ACK_MISSING');
          }
          return result;
        };
        const value=Reflect.get(target,property,target);
        return typeof value==='function'?value.bind(target):value;
      },
    });
    await assert.rejects(ingestDeviceArtifact(missingAck,stable,input),
      /ISOLATED_FINAL_ACK_MISSING/);
    assert.equal(lost,true);
    assert.equal(await store.get(scope,input.artifactPath),null);

    // The receiver has every byte in its durable stage. The source's first
    // hash can be unchanged, while its final readback is different. Resumed
    // publication must fail closed rather than trusting the old chunk ACK.
    let hashes=0;
    const changedReadback:ArtifactSourceOps={...stable,
      sha256:async()=>++hashes===1?sha:'f'.repeat(64)};
    await assert.rejects(ingestDeviceArtifact(store,changedReadback,input),
      (error:unknown)=>error instanceof ArtifactBridgeError&&
        error.code==='INGEST_SOURCE_CHANGED');
    assert.equal(hashes,2);
    assert.equal(await store.get(scope,input.artifactPath),null);

    // Only a fresh matching digest plus the committed stage may finish.
    const recovered=await ingestDeviceArtifact(store,stable,input);
    assert.equal(recovered.state,'COMPLETE');
    assert.equal(recovered.transferredBytes,0);
    assert.equal(recovered.sha256,sha);
    assert.equal((await store.get(scope,input.artifactPath))?.sha256,sha);
    assert.equal((await store.get(scope,input.artifactPath))?.acceptanceStatus,'pending');
  }finally{await fs.rm(directory,{recursive:true,force:true})}
});
