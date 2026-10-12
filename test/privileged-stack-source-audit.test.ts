import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,mkdirSync,writeFileSync,appendFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {
  privilegedStackSourceChain,
  auditPrivilegedStackSource,
  inspectPrivilegedStackSourceChainReadOnly,
} from '../src/security/privileged-stack-source-audit.js';

const expected='C:\\ProgramData\\NexowireStack\\nexowire\\node_modules\\nexowire\\dist\\src\\cli.js';

test('Stack entrypoint audit enumerates every protected source directory and final file',{
  skip:process.platform!=='win32',
},()=>{
  const chain=privilegedStackSourceChain(expected);
  assert.deepEqual(chain,[
    'C:\\ProgramData\\NexowireStack',
    'C:\\ProgramData\\NexowireStack\\nexowire',
    'C:\\ProgramData\\NexowireStack\\nexowire\\node_modules',
    'C:\\ProgramData\\NexowireStack\\nexowire\\node_modules\\nexowire',
    'C:\\ProgramData\\NexowireStack\\nexowire\\node_modules\\nexowire\\dist',
    'C:\\ProgramData\\NexowireStack\\nexowire\\node_modules\\nexowire\\dist\\src',
    expected,
  ]);
  assert.equal(chain.length,7);
});

test('Stack source rejects traversal, UNC paths, sibling-prefix confusion and alternate streams',{
  skip:process.platform!=='win32',
},()=>{
  const candidates=[
    'C:\\Users\\Public\\cli.js',
    'C:\\ProgramData\\NexowireStack-other\\nexowire\\node_modules\\nexowire\\dist\\src\\cli.js',
    'C:\\ProgramData\\NexowireStack\\..\\NexowireStack\\nexowire\\node_modules\\nexowire\\dist\\src\\cli.js',
    'C:\\ProgramData\\NexowireStack\\nexowire\\.\\node_modules\\nexowire\\dist\\src\\cli.js',
    expected+':payload',
    expected+' ',
    '\\\\evil\\share\\cli.js',
    'C:/ProgramData/NexowireStack/nexowire/node_modules/nexowire/dist/src/cli.js',
  ];
  for(const candidate of candidates){
    assert.throws(()=>privilegedStackSourceChain(candidate),/PRIVILEGED_STACK_SOURCE_NONCANONICAL_PATH/);
    assert.throws(()=>auditPrivilegedStackSource(candidate),/PRIVILEGED_STACK_SOURCE_NONCANONICAL_PATH/);
  }
});

test('fixed legacy Stack code chain probes shared outer ancestors around source ACL scan',()=>{
  const source=readFileSync(new URL('../src/security/privileged-stack-source-audit.ts',import.meta.url),'utf8');
  const wrapper=source.slice(source.indexOf('export function auditPrivilegedStackSource('));
  const firstRoot=wrapper.indexOf("verifyWindowsStackOuterAncestorAcl('C:\\\\')");
  const firstData=wrapper.indexOf("verifyWindowsStackOuterAncestorAcl('C:\\\\ProgramData')");
  const scan=wrapper.indexOf('inspectPrivilegedStackSourceChainReadOnly(');
  const lastRoot=wrapper.indexOf("verifyWindowsStackOuterAncestorAcl('C:\\\\')",firstRoot+1);
  const lastData=wrapper.indexOf("verifyWindowsStackOuterAncestorAcl('C:\\\\ProgramData')",firstData+1);
  assert.ok(firstRoot>=0 && firstRoot<firstData && firstData<scan);
  assert.ok(scan<lastRoot && lastRoot<lastData);
});

test('read-only Stack source chain rejects entry mutation during ACL inspection',()=>{
  const root=mkdtempSync(join(tmpdir(),'nwx-stack-chain-'));
  const nested=join(root,'dep');
  mkdirSync(nested);
  const entry=join(nested,'cli.js');
  writeFileSync(entry,'original');
  try {
    const chain=[root,nested,entry];
    const visited:string[]=[];
    assert.equal(inspectPrivilegedStackSourceChainReadOnly(chain,p=>{
      visited.push(p);
    }),3);
    assert.deepEqual(visited,chain);
    assert.throws(()=>inspectPrivilegedStackSourceChainReadOnly(chain,p=>{
      if(p===entry)appendFileSync(entry,'changed');
    }),/PRIVILEGED_STACK_SOURCE_CHANGED_DURING_AUDIT/);
  } finally {rmSync(root,{force:true,recursive:true})}
});

test('read-only Stack source chain revalidates ancestor directory entries',()=>{
  const root=mkdtempSync(join(tmpdir(),'nwx-stack-ancestor-'));
  const nested=join(root,'dep');
  mkdirSync(nested);
  const entry=join(nested,'cli.js');
  writeFileSync(entry,'original');
  try {
    const chain=[root,nested,entry];
    assert.throws(()=>inspectPrivilegedStackSourceChainReadOnly(chain,p=>{
      if(p===entry)writeFileSync(join(nested,'unexpected.js'),'x');
    }),/PRIVILEGED_STACK_SOURCE_CHANGED_DURING_AUDIT/);
  } finally {rmSync(root,{force:true,recursive:true})}
});

test('source chain rejects untrusted ACL and invalid inspection lengths',()=>{
  const root=mkdtempSync(join(tmpdir(),'nwx-stack-acl-'));
  const entry=join(root,'cli.js');
  writeFileSync(entry,'x');
  try{
    assert.throws(()=>inspectPrivilegedStackSourceChainReadOnly([root,entry],()=>{
      throw new Error('UNTRUSTED_WRITE');
    }),/PRIVILEGED_STACK_SOURCE_UNTRUSTED_ACL/);
    assert.throws(()=>inspectPrivilegedStackSourceChainReadOnly([root],()=>{}),
      /PRIVILEGED_STACK_SOURCE_CHAIN_INVALID/);
  }finally{rmSync(root,{force:true,recursive:true})}
});

test('read-only source auditor does not mutate ACLs or invoke task start and stop',()=>{
  const source=readFileSync(new URL('../src/security/privileged-stack-source-audit.ts',import.meta.url),'utf8');
  assert.match(source,/lstatSync/);
  assert.match(source,/verifyWindowsPrivateAcl/);
  assert.match(source,/stat\.nlink!==1/);
  assert.doesNotMatch(source,/hardenWindowsProgramDataAcl|icacls\.exe|Register-ScheduledTask|Unregister-ScheduledTask|Start-ScheduledTask|Stop-ScheduledTask|chmodSync|chownSync/);
});

test('Stack source audit rejects unsupported platforms before any filesystem access',{
  skip:process.platform==='win32',
},()=>{
  assert.throws(()=>privilegedStackSourceChain(),/PRIVILEGED_STACK_SOURCE_AUDIT_WINDOWS_ONLY/);
  assert.throws(()=>auditPrivilegedStackSource(),/PRIVILEGED_STACK_SOURCE_AUDIT_WINDOWS_ONLY/);
});
