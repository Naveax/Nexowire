import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,mkdirSync,rmSync,truncateSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {gzipSync} from 'node:zlib';
import {verifyReleaseTree} from '../scripts/verify-release-tree.js';

const hash=(b:Uint8Array|string)=>createHash('sha256').update(b).digest('hex');
function tarFile(name:string,content:Buffer,type='0'):Buffer{
  const header=Buffer.alloc(512);
  header.write(name,0,100,'utf8');
  header.write('0000644\0',100,'ascii');
  header.write('0000000\0',108,'ascii');
  header.write('0000000\0',116,'ascii');
  header.write(content.length.toString(8).padStart(11,'0')+'\0',124,'ascii');
  header.write('00000000000\0',136,'ascii');
  header.fill(32,148,156);
  header.write(type,156,'ascii');
  header.write('ustar\0',257,'ascii');
  header.write('00',263,'ascii');
  let checksum=0;
  for(const x of header)checksum+=x;
  header.write(checksum.toString(8).padStart(6,'0')+'\0 ',148,'ascii');
  return Buffer.concat([header,content,Buffer.alloc((512-content.length%512)%512)]);
}
function makeFixture(){
  const root=mkdtempSync(path.join(tmpdir(),'nexowire-release-tree-test-'));
  const extracted=path.join(root,'extracted');
  const archive=path.join(root,'nexowire-1.0.5.tgz');
  const checksum=path.join(root,'SHA256SUMS');
  mkdirSync(path.join(extracted,'dist','src'),{recursive:true});
  const pkg=Buffer.from(JSON.stringify({name:'nexowire',version:'1.0.5',bin:{nexowire:'dist/src/cli.js'}}));
  const cli=Buffer.from('#!/usr/bin/env node\nconsole.log("test")\n');
  const files=[['package/package.json',pkg],['package/dist/src/cli.js',cli]] as const;
  for(const [p,c] of files){
    const relative=p.slice('package/'.length);
    writeFileSync(path.join(extracted,...relative.split('/')),c);
  }
  const tgz=gzipSync(Buffer.concat([...files.map(([p,c])=>tarFile(p,c)),Buffer.alloc(1024)]));
  writeFileSync(archive,tgz);
  writeFileSync(checksum,hash(tgz)+'  nexowire-1.0.5.tgz\n');
  return {root,extracted,archive,checksum,tgz,cli};
}
function options(f:ReturnType<typeof makeFixture>){
  return {archivePath:f.archive,checksumPath:f.checksum,extractedRoot:f.extracted,
    expectedVersion:'1.0.5',expectedArchiveSha256:hash(f.tgz),expectedCliSha256:hash(f.cli)};
}
test('read-only full content attestation passes matching tarball and extracted files',async()=>{
  const f=makeFixture();
  try{
    const result=await verifyReleaseTree(options(f));
    assert.equal(result.status,'MATCHED');
    assert.equal(result.checkedFiles,2);
    assert.match(result.treeDigest,/^[a-f0-9]{64}$/);
    assert.equal(result.cliSha256,hash(f.cli));
    assert.equal(result.codeSignatureVerified,false);
    assert.equal(result.protectedAclVerified,false);
    assert.equal(result.authorizedInstallerVerified,false);
    assert.equal(result.safeToElevate,false);
    assert.equal(result.productionModified,false);
  }finally{rmSync(f.root,{recursive:true,force:true})}
});
test('tampered extracted CLI, extra files and file count fail closed',async()=>{
  const f=makeFixture();
  try{
    const file=path.join(f.extracted,'dist','src','cli.js');
    writeFileSync(file,'tampered');
    await assert.rejects(verifyReleaseTree(options(f)),/RELEASE_TREE_EXTRACTED_CONTENT_MISMATCH/);
    writeFileSync(file,f.cli);
    writeFileSync(path.join(f.extracted,'injected.js'),'bad');
    await assert.rejects(verifyReleaseTree(options(f)),/RELEASE_TREE_EXTRACTED_COUNT_MISMATCH/);
  }finally{rmSync(f.root,{recursive:true,force:true})}
});
test('published checksum cannot replace separately pinned digest',async()=>{
  const f=makeFixture();
  try{
    await assert.rejects(verifyReleaseTree({...options(f),expectedArchiveSha256:'0'.repeat(64)}),/RELEASE_TREE_PINNED_DIGEST_MISMATCH/);
    writeFileSync(f.checksum,'0'.repeat(64)+'  nexowire-1.0.5.tgz\n');
    await assert.rejects(verifyReleaseTree(options(f)),/RELEASE_TREE_CHECKSUM_FILE_MISMATCH/);
  }finally{rmSync(f.root,{recursive:true,force:true})}
});
test('archive traversal, symlink and duplicate casing are rejected before extraction',async()=>{
  const f=makeFixture();
  try{
    const variants=[
      {entries:[tarFile('package/../evil',Buffer.from('bad')),tarFile('package/package.json',Buffer.from('{}'))],code:'PATH_UNSAFE'},
      {entries:[tarFile('package/outside',Buffer.alloc(0),'2'),tarFile('package/package.json',Buffer.from('{}'))],code:'LINK_OR_SPECIAL_ENTRY'},
      {entries:[tarFile('package/a.js',Buffer.from('one')),tarFile('package/A.js',Buffer.from('two'))],code:'TAR_DUPLICATE_CASE_INSENSITIVE'},
    ];
    for(const {entries,code} of variants){
      const tgz=gzipSync(Buffer.concat([...entries,Buffer.alloc(1024)]));
      writeFileSync(f.archive,tgz);
      writeFileSync(f.checksum,hash(tgz)+'  nexowire-1.0.5.tgz\n');
      await assert.rejects(verifyReleaseTree({...options(f),expectedArchiveSha256:hash(tgz)}),new RegExp('RELEASE_TREE_'+code));
    }
  }finally{rmSync(f.root,{recursive:true,force:true})}
});
test('extracted extra files cannot exceed the aggregate tar safety budget',async()=>{
  const f=makeFixture();
  try{
    const a=path.join(f.extracted,'oversized-extra-1.bin');
    const b=path.join(f.extracted,'oversized-extra-2.bin');
    writeFileSync(a,'');
    writeFileSync(b,'');
    // Sparse files; only read the first file, then reject at the second stat.
    truncateSync(a,33*1024*1024);
    truncateSync(b,33*1024*1024);
    await assert.rejects(verifyReleaseTree(options(f)),/RELEASE_TREE_EXTRACTED_TOTAL_BYTES_LIMIT/);
  }finally{rmSync(f.root,{recursive:true,force:true})}
});
test('archive with valid pinned digest still rejects incorrect CLI pin',async()=>{
  const f=makeFixture();
  try{
    await assert.rejects(verifyReleaseTree({...options(f),expectedCliSha256:'0'.repeat(64)}),/RELEASE_TREE_PINNED_CLI_MISMATCH/);
  }finally{rmSync(f.root,{recursive:true,force:true})}
});
