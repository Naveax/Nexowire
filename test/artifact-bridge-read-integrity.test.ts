import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { ArtifactBridgeStore } from '../src/workspace/artifact-bridge.js';
test('verified read must reject object changed between full hash and chunk open', async () => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'bridge-toctou-synthetic-'));
  try {
    const scope={accountId:'synthetic-owner',projectId:'Nexowire',deviceId:'synthetic-device'};
    const bytes=Buffer.alloc(12000,0x41);
    const digest=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
    const store=new ArtifactBridgeStore(root);
    const artifactPath='untrusted/change.bin';
    const params={scope, artifactPath, repository:'Naveax/Nexowire',
      commitSha:'cb819d17ee581093d39626f13e985976def17f30',
      producerOperationId:'controlled-race',size:bytes.length,sha256:digest(bytes),
      testStatus:'unverified' as const,acceptanceStatus:'pending' as const};
    const begun=await store.begin(params);
    assert.equal(begun.state,'OPEN');
    await store.putChunk(scope,begun.sessionId!,0,bytes.toString('base64'));
    await store.commit(scope,begun.sessionId!);
    // Find ONLY the new synthetic blob in this disposable directory.
    async function walk(dir:string):Promise<string[]> {
      const out:string[]=[];for(const e of await fs.readdir(dir,{withFileTypes:true})){
        const target=path.join(dir,e.name);if(e.isDirectory())out.push(...await walk(target));
        else if(e.name===digest(bytes))out.push(target);
      }return out;
    }
    const matches=await walk(root);assert.equal(matches.length,1);
    const object=matches[0]!;
    const original=fs.open.bind(fs);
    let injected=false;
    Object.defineProperty(fs,'open',{configurable:true,writable:true,value:async (...args:Parameters<typeof fs.open>)=>{
      if(String(args[0])===object && args[1]==='r' && !injected){
        injected=true;
        await fs.writeFile(object,Buffer.alloc(bytes.length,0x42));
      }
      return original(...args);
    }});
    try {
      await assert.rejects(store.readChunk(scope,artifactPath,0,128),
        (e: unknown) => e instanceof Error && 'code' in e &&
          (e.code === 'ARTIFACT_CHANGED' || e.code === 'CORRUPT_ARTIFACT'),
        'Tampering between metadata verification and content read must be denied.');
    } finally {
      Object.defineProperty(fs,'open',{configurable:true,writable:true,value:original});
    }
    assert.ok(injected,'test must have changed the object at the read boundary');
  } finally {await fs.rm(root,{recursive:true,force:true});}
});
test('verified random-access chunk comes from one pinned descriptor across a 64 KiB boundary', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-pinned-range-'));
  try {
    const scope = { accountId: 'synthetic-owner', projectId: 'Nexowire', deviceId: 'synthetic-device' };
    const payload = Buffer.alloc(175111);
    for (let i = 0; i < payload.length; i++) payload[i] = i % 251;
    const digest = (b: Buffer) => createHash('sha256').update(b).digest('hex');
    const store = new ArtifactBridgeStore(root);
    const artifactPath = 'pinned/range.bin';
    const session = await store.begin({ scope, artifactPath, repository: 'Naveax/Nexowire',
      commitSha: 'cb819d17ee581093d39626f13e985976def17f30',
      producerOperationId: 'bounded-range', size: payload.length, sha256: digest(payload),
      testStatus: 'unverified', acceptanceStatus: 'pending' });
    assert.equal(session.state, 'OPEN');
    for (let offset = 0; offset < payload.length; offset += 65536) {
      await store.putChunk(scope, session.sessionId!, offset, payload.subarray(offset, offset + 65536).toString('base64'));
    }
    await store.commit(scope, session.sessionId!);
    let opens = 0;
    const previous = fs.open.bind(fs);
    Object.defineProperty(fs, 'open', { configurable: true, writable: true,
      value: async (...args: Parameters<typeof fs.open>) => {
        if (String(args[0]).endsWith(digest(payload)) && args[1] === 'r') opens++;
        return previous(...args);
      } });
    let chunk;
    try { chunk = await store.readChunk(scope, artifactPath, 65530, 8192); }
    finally { Object.defineProperty(fs, 'open', { configurable: true, writable: true, value: previous }); }
    assert.equal(opens, 1);
    assert.equal(chunk.sha256, digest(payload));
    assert.deepEqual(Buffer.from(chunk.contentBase64, 'base64'), payload.subarray(65530, 65530 + 8192));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
test('empty content still requires the full SHA-256 and allows a zero-length EOF chunk', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-empty-object-'));
  try {
    const scope = { accountId: 'synthetic-owner', projectId: 'Nexowire', deviceId: 'synthetic-device' };
    const sha = createHash('sha256').update(Buffer.alloc(0)).digest('hex');
    const store = new ArtifactBridgeStore(root);
    const session = await store.begin({ scope, artifactPath: 'empty/zero.txt',
      repository: 'Naveax/Nexowire', commitSha: 'cb819d17ee581093d39626f13e985976def17f30',
      producerOperationId: 'zero-content', size: 0, sha256: sha, testStatus: 'unverified',
      acceptanceStatus: 'pending' });
    assert.equal(session.state, 'OPEN');
    await store.commit(scope, session.sessionId!);
    const got = await store.readChunk(scope, 'empty/zero.txt', 0, 4096);
    assert.equal(got.totalSize, 0);
    assert.equal(got.size, 0);
    assert.equal(got.sha256, sha);
    assert.equal(got.contentBase64, '');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
