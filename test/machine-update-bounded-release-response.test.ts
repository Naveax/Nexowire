import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {readBoundedReleaseResponse} from '../src/update/machine-update.js';

const stream=(parts:Uint8Array[])=>new ReadableStream<Uint8Array>({
  start(controller){
    for(const part of parts)controller.enqueue(part);
    controller.close();
  },
});
const response=(parts:number[][],headers?:Record<string,string>)=>new Response(
  stream(parts.map(p=>Uint8Array.from(p))),{headers},
);

test('release asset accepts a bounded streamed body including exact limit',async()=>{
  const data=await readBoundedReleaseResponse(
    response([[1,2],[3,4,5],[6,7]]),7);
  assert.deepEqual([...data],[1,2,3,4,5,6,7]);
});

test('rejects excessive declared Content-Length before consuming any chunks',async()=>{
  let pulled=false;
  const body=new ReadableStream<Uint8Array>({
    pull(controller){pulled=true;controller.enqueue(Uint8Array.of(1));controller.close();},
  });
  const x=new Response(body,{headers:{'content-length':'1000000000000'}});
  await assert.rejects(()=>readBoundedReleaseResponse(x,1024),
    /MACHINE_UPDATE_ASSET_TOO_LARGE/);
  // The length header is rejected even though the body could stream indefinitely.
});

test('rejects streaming bytes above limit even when Content-Length is too small',async()=>{
  const res=response([[1,2,3,4],[5,6,7,8]],{'content-length':'1'});
  await assert.rejects(()=>readBoundedReleaseResponse(res,7),
    /MACHINE_UPDATE_ASSET_TOO_LARGE/);
});

test('rejects streamed bytes above limit when no Content-Length was provided',async()=>{
  await assert.rejects(()=>readBoundedReleaseResponse(response([[1,2],[3,4],[5]]),4),
    /MACHINE_UPDATE_ASSET_TOO_LARGE/);
});

test('rejects missing body or invalid asset budget',async()=>{
  await assert.rejects(()=>readBoundedReleaseResponse(new Response(null),8),
    /MACHINE_UPDATE_ASSET_BODY_MISSING/);
  for(const limit of [0,-1,1.2,NaN,Infinity]){
    await assert.rejects(()=>readBoundedReleaseResponse(response([[1]]),limit),
      /MACHINE_UPDATE_ASSET_LIMIT_INVALID/);
  }
});

test('download call sites bind limits to checksum, setup and compressed ZIP',()=>{
  const src=readFileSync(new URL('../src/update/machine-update.ts',import.meta.url),'utf8');
  assert.match(src,/MAX_RELEASE_CHECKSUM_BYTES=128\*1024/);
  assert.match(src,/MAX_RELEASE_SETUP_BYTES=2\*1024\*1024/);
  assert.match(src,/MAX_RELEASE_ZIP_BYTES=256\*1024\*1024/);
  assert.match(src,/fetchBuffer\(base \+ '\/SHA256SUMS-Windows',MAX_RELEASE_CHECKSUM_BYTES\)/);
  assert.match(src,/fetchBuffer\(base \+ '\/Nexowire-Setup.cmd',MAX_RELEASE_SETUP_BYTES\)/);
  assert.match(src,/fetchBuffer\(base \+ '\/Nexowire-Windows-x64.zip',MAX_RELEASE_ZIP_BYTES\)/);
  assert.doesNotMatch(src,/return Buffer\.from\(await response\.arrayBuffer\(\)\)/);
});
