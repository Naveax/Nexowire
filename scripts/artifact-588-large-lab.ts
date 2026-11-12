import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ArtifactBridgeStore } from '../src/workspace/artifact-bridge.js';
// Deliberately bounded memory, fail-closed synthetic acceptance harness.
// Usage: NEX588_ROOT=path node --import tsx scripts/artifact-588-large-lab.ts size init|batch|commit
const n = Number(process.argv[2]), action = process.argv[3], root = process.env.NEX588_ROOT;
if (!Number.isSafeInteger(n) || n < 1 || !root || !['init','batch','commit'].includes(action)) {
  throw Error('Supply an explicit positive safe-integer size, root and operation.');
}
const dir = path.join(root, 'size-' + n);
const storage = path.join(dir, 'store');
const chunk = Buffer.allocUnsafe(65536);
for(let i=0;i<chunk.length;i++) chunk[i] = (i*53 + 13) % 256;
const hash=createHash('sha256');
for(let pos=0;pos<n;pos+=chunk.length) {
  hash.update(chunk.subarray(0,Math.min(chunk.length,n-pos)));
}
const sha256=hash.digest('hex');
const scope={accountId:'owner-synthetic-588',projectId:'Nexowire',deviceId:'work-pc'};
const filename = 'synthetic/size-' + n + '.bin';
const metadata={
  scope, artifactPath:filename, repository:'Naveax/Nexowire',
  commitSha:'4d8bb072a01981be525fd7d0f800c0e2a62332f7',
  producerOperationId:'test-588-size-' + n, size:n, sha256,
  testStatus:'unverified' as const, acceptanceStatus:'pending' as const,
};
const store=new ArtifactBridgeStore(storage);
if(action==='init'){
  await fs.mkdir(dir,{recursive:false});
  const opened=await store.begin(metadata);
  if(opened.state!=='OPEN'||opened.offset!==0) throw Error('Init not OPEN');
  console.log(JSON.stringify({size:n,state:opened.state,sessionId:opened.sessionId,sha256,offset:0}));
} else if(action==='batch') {
  const opened=await store.begin(metadata);
  if(opened.state==='ALREADY_PRESENT') throw Error('Artifact already committed.');
  if(opened.state!=='OPEN'||!opened.sessionId) throw Error('Missing session.');
  let offset=opened.offset, count=0;
  const max=4096;
  const start=Date.now();
  while (offset < n && count < max) {
    const take = Math.min(32, max - count);
    const receipt = await store.appendSourceChunks(scope, opened.sessionId, take,
      async (_at, size) => chunk.subarray(0, size).toString('base64'));
    if (receipt.offset <= offset || receipt.chunks < 1 || receipt.chunks > take) {
      throw Error('Bad bounded streaming receipt.');
    }
    offset = receipt.offset;
    count += receipt.chunks;
  }
  console.log(JSON.stringify({size:n,offset,count,done:offset===n,sha256,elapsedMs:Date.now()-start}));
} else {
  const session=await store.begin(metadata);
  if(session.offset!==n) throw Error('Stage is incomplete, no commit.');
  const manifest=await store.commit(scope,session.sessionId!);
  if(manifest.sha256!==sha256||manifest.size!==n) throw Error('Artifact manifest mismatch.');
  const after=await store.get(scope,filename);
  if(after?.sha256!==sha256) throw Error('Published object verification failed.');
  console.log(JSON.stringify({size:n,published:true,sha256,verified:true,scope,artifactPath:filename}));
}
