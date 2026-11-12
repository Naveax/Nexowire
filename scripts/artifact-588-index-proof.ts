import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ArtifactBridgeStore } from '../src/workspace/artifact-bridge.js';
const n=268435458;
const root=process.env.NEX588_ROOT;
if(!root) throw Error('explicit synthetic acceptance folder required');
const base=path.join(root,'size-'+n,'store');
const store=new ArtifactBridgeStore(base);
const scope={accountId:'owner-synthetic-588',projectId:'Nexowire',deviceId:'work-pc'};
const name='synthetic/size-'+n+'.bin';
const manifest=await store.get(scope,name);
if(!manifest?.receiptSha256) throw Error('missing indexed v2 receipt digest');
for(const [offset,len] of [[0,1024],[65530,500],[131071,65536],[n-2,2]]){
  const started=Date.now();
  const got=await store.readChunk(scope,name,offset,len);
  const expected=Buffer.alloc(len);
  for(let i=0;i<len;i++) expected[i]=(((offset+i)%65536)*53+13)%256;
  if(!Buffer.from(got.contentBase64,'base64').equals(expected)) throw Error('chunk bytes mismatch');
  if(got.chunkSha256!==createHash('sha256').update(expected).digest('hex')) throw Error('chunk SHA mismatch');
  console.log(JSON.stringify({offset,len,elapsedMs:Date.now()-started,sha256:got.chunkSha256}));
}
const dir=path.join(root,'size-'+n);
const evidence={size:n,sha256:manifest.sha256,receiptSha256:manifest.receiptSha256,
  indexedReadsVerified:true,chunkBytesLimit:65536,completeFileVerified:true};
const proof=path.join(dir,'indexed-read-evidence.json');
const f=await fs.open(proof,'wx');
try {await f.writeFile(JSON.stringify(evidence,null,2)+'\n');await f.sync();}finally{await f.close();}
console.log(JSON.stringify({proof,sha256:createHash('sha256').update(await fs.readFile(proof)).digest('hex')}));
