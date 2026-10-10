import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {
  privilegedStackSourceChain,
  auditPrivilegedStackSource,
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

test('read-only source auditor does not mutate ACLs or invoke task start and stop',()=>{
  const source=readFileSync(new URL('../src/security/privileged-stack-source-audit.ts',import.meta.url),'utf8');
  assert.match(source,/lstatSync/);
  assert.match(source,/verifyWindowsPrivateAcl/);
  assert.doesNotMatch(source,/hardenWindowsProgramDataAcl|icacls\.exe|Register-ScheduledTask|Unregister-ScheduledTask|Start-ScheduledTask|Stop-ScheduledTask|chmodSync|chownSync/);
});

test('Stack source audit rejects unsupported platforms before any filesystem access',{
  skip:process.platform==='win32',
},()=>{
  assert.throws(()=>privilegedStackSourceChain(),/PRIVILEGED_STACK_SOURCE_AUDIT_WINDOWS_ONLY/);
  assert.throws(()=>auditPrivilegedStackSource(),/PRIVILEGED_STACK_SOURCE_AUDIT_WINDOWS_ONLY/);
});
