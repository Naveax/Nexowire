import {createHash, timingSafeEqual} from 'node:crypto';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {gunzipSync} from 'node:zlib';
import {fileURLToPath} from 'node:url';

const MAX_ARCHIVE_BYTES=32*1024*1024;
const MAX_TAR_BYTES=64*1024*1024;
const MAX_ENTRIES=20_000;
const BLOCK=512;
const sha256=(bytes:Uint8Array|string):string=>createHash('sha256').update(bytes).digest('hex');
function fail(code:string):never{throw new Error('RELEASE_TREE_'+code)}
function validHash(input:string,name:string):string{
  if(!/^[0-9a-f]{64}$/i.test(input))fail(name+'_HASH_INVALID');
  return input.toLowerCase();
}
function constantEqual(a:string,b:string):boolean{
  return timingSafeEqual(Buffer.from(a,'hex'),Buffer.from(b,'hex'));
}
function tarText(bytes:Buffer):string{
  const end=bytes.indexOf(0);
  return bytes.subarray(0,end<0?bytes.length:end).toString('utf8');
}
function tarOctal(bytes:Buffer,field:string):number{
  const s=tarText(bytes).trim();
  if(!/^[0-7]+$/.test(s))fail(field+'_INVALID');
  const n=parseInt(s,8);
  if(!Number.isSafeInteger(n)||n<0)fail(field+'_OUT_OF_RANGE');
  return n;
}
function safeEntry(raw:string):string{
  if(!raw.startsWith('package/'))fail('TOP_LEVEL_UNEXPECTED');
  let p=raw.slice('package/'.length);
  if(p.endsWith('/'))p=p.slice(0,-1);
  if(!p||p.length>2048||p.includes('\\')||p.includes('//')||
    /[\x00-\x1f\x7f:<>"|?*]/.test(p))fail('PATH_INVALID');
  const pieces=p.split('/');
  if(pieces.some(x=>x==='.'||x==='..'||x.endsWith(' ')||x.endsWith('.')||
    /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(x)))fail('PATH_UNSAFE');
  return p;
}
export interface ReleaseTreeVerificationOptions{
  archivePath:string;
  checksumPath:string;
  extractedRoot:string;
  expectedArchiveSha256:string;
  expectedVersion:string;
  expectedCliSha256?:string;
}
export interface ReleaseTreeVerification{
  status:'MATCHED';
  archiveSha256:string;
  version:string;
  checkedFiles:number;
  treeDigest:string;
  cliSha256:string;
  codeSignatureVerified:false;
  protectedAclVerified:false;
  authorizedInstallerVerified:false;
  safeToElevate:false;
  productionModified:false;
}
interface TarItem{relative:string;data:Buffer}
function inspectTar(bytes:Buffer):Map<string,TarItem>{
  if(bytes.length%BLOCK!==0)fail('TAR_BLOCK_ALIGNMENT');
  const found=new Map<string,TarItem>();
  const identities=new Set<string>();
  let offset=0,zeroBlocks=0,entries=0;
  while(offset+BLOCK<=bytes.length){
    const header=bytes.subarray(offset,offset+BLOCK);
    if(header.every(b=>b===0)){
      zeroBlocks++;
      if(zeroBlocks>=2){
        if(!bytes.subarray(offset+BLOCK).every(b=>b===0))fail('TRAILING_DATA');
        break;
      }
      offset+=BLOCK;
      continue;
    }
    if(zeroBlocks)fail('TAR_PADDING_INVALID');
    const provided=tarOctal(header.subarray(148,156),'TAR_HEADER_CHECKSUM');
    let computed=0;
    for(let i=0;i<BLOCK;i++)computed+=i>=148&&i<156?32:header[i]!;
    if(provided!==computed)fail('TAR_HEADER_CHECKSUM_MISMATCH');
    const magic=header.subarray(257,263).toString('ascii');
    if(!magic.startsWith('ustar'))fail('TAR_FORMAT_UNSUPPORTED');
    const prefix=tarText(header.subarray(345,500));
    const name=tarText(header.subarray(0,100));
    const relative=safeEntry((prefix?prefix+'/':'')+name);
    const type=header[156]!;
    if(type!==0&&type!==48&&type!==53)fail('LINK_OR_SPECIAL_ENTRY');
    const size=tarOctal(header.subarray(124,136),'TAR_SIZE');
    if(type===53&&size!==0)fail('DIRECTORY_SIZE_UNEXPECTED');
    const next=offset+BLOCK+Math.ceil(size/BLOCK)*BLOCK;
    if(next>bytes.length||next<=offset)fail('TAR_TRUNCATED');
    entries++;
    if(entries>MAX_ENTRIES)fail('TAR_ENTRY_CAP');
    const key=relative.toLowerCase();
    if(identities.has(key))fail('TAR_DUPLICATE_CASE_INSENSITIVE');
    identities.add(key);
    if(type!==53){
      found.set(key,{relative,data:bytes.subarray(offset+BLOCK,offset+BLOCK+size)});
    }
    offset=next;
  }
  if(zeroBlocks<2||!found.size)fail('TAR_NOT_TERMINATED');
  return found;
}
async function inspectExtracted(root:string):Promise<Map<string,{relative:string;digest:string;size:number}>>{
  const rootStats=await fs.lstat(root);
  if(!rootStats.isDirectory()||rootStats.isSymbolicLink())fail('EXTRACTED_ROOT_UNSAFE');
  const files=new Map<string,{relative:string;digest:string;size:number}>();
  const all=new Set<string>();
  async function descend(dir:string,prefix:string,depth:number):Promise<void>{
    if(depth>64)fail('EXTRACTED_DEPTH_LIMIT');
    const entries=await fs.readdir(dir,{withFileTypes:true});
    for(const entry of entries){
      const relative=prefix?prefix+'/'+entry.name:entry.name;
      safeEntry('package/'+relative);
      const key=relative.toLowerCase();
      if(all.has(key))fail('EXTRACTED_DUPLICATE_CASE_INSENSITIVE');
      all.add(key);
      if(all.size>MAX_ENTRIES)fail('EXTRACTED_ENTRY_CAP');
      const full=path.join(dir,entry.name);
      const stat=await fs.lstat(full);
      if(stat.isSymbolicLink()||!stat.isFile()&&!stat.isDirectory())fail('EXTRACTED_LINK_OR_SPECIAL');
      if(stat.isDirectory()){
        await descend(full,relative,depth+1);
      }else{
        if(stat.size>MAX_TAR_BYTES)fail('EXTRACTED_FILE_TOO_LARGE');
        const bytes=await fs.readFile(full);
        files.set(key,{relative,digest:sha256(bytes),size:bytes.length});
      }
    }
  }
  await descend(root,'',0);
  return files;
}
/** Never executes or extracts the artifact; reads an already-extracted, untrusted copy. */
export async function verifyReleaseTree(input:ReleaseTreeVerificationOptions):Promise<ReleaseTreeVerification>{
  const expected=validHash(input.expectedArchiveSha256,'PINNED_ARCHIVE');
  if(input.expectedCliSha256)validHash(input.expectedCliSha256,'PINNED_CLI');
  if(!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(input.expectedVersion))fail('VERSION_INVALID');
  const stats=await fs.stat(input.archivePath);
  if(stats.size<=0||stats.size>MAX_ARCHIVE_BYTES)fail('ARCHIVE_SIZE_INVALID');
  const archive=await fs.readFile(input.archivePath);
  const actual=sha256(archive);
  if(!constantEqual(actual,expected))fail('PINNED_DIGEST_MISMATCH');
  const checksum=await fs.readFile(input.checksumPath,'utf8');
  const filename=path.basename(input.archivePath);
  if(!/^nexowire-\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?\.tgz$/.test(filename)||
    filename!=='nexowire-'+input.expectedVersion+'.tgz')fail('ARCHIVE_NAME_MISMATCH');
  const lines=checksum.trim().split(/\r?\n/);
  if(lines.length!==1||lines[0]!==actual+'  '+filename)fail('CHECKSUM_FILE_MISMATCH');
  let unpacked:Buffer;
  try{
    unpacked=gunzipSync(archive,{maxOutputLength:MAX_TAR_BYTES});
  }catch{fail('GZIP_INVALID_OR_TOO_LARGE')}
  const members=inspectTar(unpacked);
  const pkg=members.get('package.json');
  const cli=members.get('dist/src/cli.js');
  if(!pkg||!cli)fail('REQUIRED_ENTRIES_MISSING');
  let packageJson:unknown;
  try{packageJson=JSON.parse(pkg.data.toString('utf8'))}catch{fail('PACKAGE_JSON_INVALID')}
  const info=packageJson as {name?:unknown;version?:unknown;bin?:{nexowire?:unknown}};
  if(info.name!=='nexowire'||info.version!==input.expectedVersion||
    info.bin?.nexowire!=='dist/src/cli.js')fail('PACKAGE_IDENTITY_MISMATCH');
  const cliSha=sha256(cli.data);
  if(input.expectedCliSha256&&!constantEqual(cliSha,input.expectedCliSha256.toLowerCase()))fail('PINNED_CLI_MISMATCH');
  const disk=await inspectExtracted(input.extractedRoot);
  if(disk.size!==members.size)fail('EXTRACTED_COUNT_MISMATCH');
  const rootLines:string[]=[];
  for(const [key,item] of members){
    const saved=disk.get(key);
    if(!saved||saved.relative!==item.relative)fail('EXTRACTED_MISSING_OR_CASE_MISMATCH');
    const digest=sha256(item.data);
    if(saved.size!==item.data.length||!constantEqual(saved.digest,digest))fail('EXTRACTED_CONTENT_MISMATCH');
    rootLines.push(item.relative+'\0'+String(saved.size)+'\0'+digest+'\n');
  }
  rootLines.sort();
  return {
    status:'MATCHED',archiveSha256:actual,version:input.expectedVersion,
    checkedFiles:members.size,treeDigest:sha256(rootLines.join('')),
    cliSha256:cliSha,
    codeSignatureVerified:false,protectedAclVerified:false,
    authorizedInstallerVerified:false,safeToElevate:false,productionModified:false,
  };
}
async function main():Promise<void>{
  if(process.argv.length<7||process.argv.length>8){
    throw new Error('Usage: node --import tsx scripts/verify-release-tree.ts <tarball.tgz> <SHA256SUMS> <extracted-package-dir> <expected-version> <PINNED-tarball-sha256> [PINNED-cli-sha256]');
  }
  const [, ,archivePath,checksumPath,extractedRoot,expectedVersion,expectedArchiveSha256,expectedCliSha256]=process.argv;
  const result=await verifyReleaseTree({
    archivePath:archivePath!,checksumPath:checksumPath!,extractedRoot:extractedRoot!,
    expectedVersion:expectedVersion!,expectedArchiveSha256:expectedArchiveSha256!,
    ...(expectedCliSha256?{expectedCliSha256}:{})
  });
  process.stdout.write(JSON.stringify(result)+'\n');
}
if(process.argv[1]&&path.resolve(process.argv[1])===path.resolve(fileURLToPath(import.meta.url)))await main();
