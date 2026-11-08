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

// #588 test-only Agent/Hub adapter substitutes. No live credentials, devices,
// WSS or source paths. A virtual >256MiB file is never materialized in RAM.
const scope={accountId:'account:test',projectId:'Nexowire',deviceId:'p007-k18'};
const sha=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
const input=(artifactPath:string,maxChunks:number)=>({
  scope,sourcePath:'C:\\test-only\\virtual.bin',artifactPath,
  repository:'Naveax/Nexowire',commitSha:'4'.repeat(40),
  producerOperationId:'k18-p007-independent-hash',
  testStatus:'unverified' as const,acceptanceStatus:'pending' as const,maxChunks,
});
function source(bytes:Buffer,reportedHash=sha(bytes)):ArtifactSourceOps {
  return {
    stat:async()=>({type:'file',size:bytes.length}),
    sha256:async()=>reportedHash,
    read:async(_,offset,maxBytes)=>{
      const part=bytes.subarray(offset,offset+maxBytes);
      return {sourceBytes:bytes.length,offsetBytes:offset,
        bytesRead:part.length,contentBase64:part.toString('base64')};
    },
  };
}
async function fixture(run:(store:ArtifactBridgeStore)=>Promise<void>){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'nw-k18-p007-'));
  try{await run(new ArtifactBridgeStore(directory))}
  finally{await fs.rm(directory,{recursive:true,force:true})}
}

test('D-104/D-105 #588 1MiB resumable local ingest tracks per-call and cumulative bytes',()=>
  fixture(async store=>{
    const bytes=Buffer.alloc(1_048_576);
    for(let i=0;i<bytes.length;i++)bytes[i]=(i*7+11)%251;
    const digest=sha(bytes),artifactPath='k18/one-mib-resume.bin';
    const opts=input(artifactPath,2); // 128 KiB per call; 8 iterations
    const prefix:number[]=[];
    let cumulativeTransferred=0;
    for(let attempt=0;attempt<8;attempt++){
      const result=await ingestDeviceArtifact(store,source(bytes),opts);
      cumulativeTransferred+=result.transferredBytes;
      prefix.push(result.offset);
      assert.equal(result.offset,(attempt+1)*131_072);
      assert.equal(result.transferredBytes,131_072);
      assert.equal(result.size,bytes.length);
      if(attempt<7){
        assert.equal(result.state,'PARTIAL');
        assert.equal(await store.get(scope,artifactPath),null);
      }else{
        assert.equal(result.state,'COMPLETE');
        assert.equal(result.sha256,digest);
      }
    }
    assert.deepEqual(prefix,[131072,262144,393216,524288,655360,786432,917504,1048576]);
    assert.equal(cumulativeTransferred,bytes.length);
    const receiver=createHash('sha256');
    for(let offset=0;offset<bytes.length;offset+=65_536){
      const chunk=await store.readChunk(scope,artifactPath,offset,65_536);
      assert.equal(chunk.offset,offset);
      assert.equal(chunk.totalSize,bytes.length);
      receiver.update(Buffer.from(chunk.contentBase64,'base64'));
    }
    assert.equal(receiver.digest('hex'),digest); // independent receiver recomputation
    assert.equal((await store.get(scope,artifactPath))?.sha256,digest);
    assert.equal((await store.get(scope,artifactPath))?.acceptanceStatus,'pending');
  }));

test('D-105 #588 a lying sender SHA cannot defeat receiver recomputation',()=>
  fixture(async store=>{
    const bytes=Buffer.alloc(225_281,0x54);
    const claimedHash='f'.repeat(64);
    const artifactPath='k18/lying-sender-225281.bin';
    assert.notEqual(claimedHash,sha(bytes));
    await assert.rejects(
      ingestDeviceArtifact(store,source(bytes,claimedHash),input(artifactPath,8)),
      (error:unknown)=>error instanceof ArtifactBridgeError&&error.code==='HASH_MISMATCH',
    );
    assert.equal(await store.get(scope,artifactPath),null);
  }));

test('D-106 #588 >256MiB virtual source fails bounded ingest before allocation/read',()=>
  fixture(async store=>{
    // This is *metadata only*: no Buffer.alloc(268435457) and no live transfer.
    const virtualSize=268_435_457;
    let hashes=0,reads=0;
    const virtual:ArtifactSourceOps={
      stat:async()=>({type:'file',size:virtualSize}),
      sha256:async()=>{hashes++;throw Error('MUST_NOT_HASH_OVERSIZED_FILE')},
      read:async()=>{reads++;throw Error('MUST_NOT_READ_OVERSIZED_FILE')},
    };
    await assert.rejects(
      ingestDeviceArtifact(store,virtual,input('k18/virtual-256mib-plus.bin',1)),
      (error:unknown)=>error instanceof ArtifactBridgeError&&
        error.code==='INGEST_SOURCE_INVALID',
    );
    assert.equal(hashes,0);
    assert.equal(reads,0);
  }));
