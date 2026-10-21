import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateCapturedAclNodes, inspectWindowsProtectedExecutableTree,
  type CapturedAclNode,
} from '../scripts/s3-windows-acl-preflight.js';
import {
  auditOfflineReleaseBundles, type AclInspector,
} from '../scripts/s3-release-bundle-audit.js';

const protectedRoot:CapturedAclNode={
  path:'C:\\ProgramData\\ProtectedNexowireFixture\\agent.exe',
  ownerSid:'S-1-5-32-544',isReparsePoint:false,
  entries:[
    {principalSid:'S-1-5-18',kind:'Allow',fileSystemRights:0x1f01ff,inherited:false},
    {principalSid:'S-1-5-32-544',kind:'Allow',fileSystemRights:0x1f01ff,inherited:true},
    {principalSid:'S-1-5-32-545',kind:'Allow',fileSystemRights:0x1200a9,inherited:true},
  ],
};
const changed=(x:Partial<CapturedAclNode>)=>({...protectedRoot,...x});

test('P0 #271: read-only Authenticated Users MODIFY ACE blocks elevated code',()=>{
  const result=()=>evaluateCapturedAclNodes([
    changed({entries:[
      ...protectedRoot.entries,
      {principalSid:'S-1-5-11',kind:'Allow',fileSystemRights:0x1301bf,inherited:true},
    ]}),
  ]);
  assert.throws(result,/S3_ACL_UNTRUSTED_WRITER/);
});

test('P0 #271: protected file owner cannot override inherited Modify on parent',()=>{
  const writableParent=changed({
    path:'C:\\ProgramData\\ProtectedNexowireFixture',
    entries:[...protectedRoot.entries,{
      principalSid:'S-1-5-32-545',kind:'Allow',
      fileSystemRights:0x001f01ff,inherited:true,
    }],
  });
  assert.throws(()=>evaluateCapturedAclNodes([protectedRoot,writableParent]),
    /S3_ACL_UNTRUSTED_WRITER/);
});

test('explicit deny and Admin ownership are not sufficient to trust another unprivileged Allow',()=>{
  const aces=[
    {principalSid:'S-1-5-11',kind:'Deny',fileSystemRights:0x001f01ff,inherited:false} as const,
    {principalSid:'S-1-5-11',kind:'Allow',fileSystemRights:0x00040000,inherited:true} as const,
  ];
  assert.throws(()=>evaluateCapturedAclNodes([changed({
    entries:[...protectedRoot.entries,...aces],
  })]),/S3_ACL_UNTRUSTED_WRITER/);
});

test('deny reparse, untrusted owner, unknown group grants, duplicate nodes and partial inventories',()=>{
  for(const node of [
    changed({isReparsePoint:true}),
    changed({ownerSid:'S-1-5-21-1000-1001-1002-1003'}),
    changed({entries:[...protectedRoot.entries,{
      principalSid:'S-1-5-21-100-200-300-400',kind:'Allow' as const,
      fileSystemRights:0x00000002,inherited:false,
    }]}),
  ]){
    assert.throws(()=>evaluateCapturedAclNodes([node]),/S3_ACL_/);
  }
  assert.throws(()=>evaluateCapturedAclNodes([protectedRoot,protectedRoot]),
    /S3_ACL_DUPLICATE_NODE/);
  assert.throws(()=>evaluateCapturedAclNodes([]),/S3_ACL_NODE_COUNT/);
  assert.throws(()=>evaluateCapturedAclNodes(Array.from({length:4097},()=>protectedRoot)),
    /S3_ACL_NODE_COUNT/);
});

test('protected ACL fixture can only claim inspection, never safe execution/production approval',()=>{
  const evidence=evaluateCapturedAclNodes([protectedRoot]);
  assert.equal(evidence.status,'protected_tree_inspected');
  assert.equal(evidence.p0LegacyRuntimeExposed,false);
  assert.equal(evidence.inspectedNodes,1);
  assert.equal(evidence.executionSafe,false);
  assert.equal(evidence.productionApproved,false);
});

test('native ACL inspector rejects non-Windows environments and invalid paths without shell',()=>{
  assert.throws(
    ()=>inspectWindowsProtectedExecutableTree('C:\\safe\\agent.exe','linux'),
    /S3_ACL_WINDOWS_REQUIRED/);
  assert.throws(
    ()=>inspectWindowsProtectedExecutableTree('\\\\network\\share\\agent.exe','win32'),
    /S3_ACL_INVALID_PATH/);
  assert.throws(
    ()=>inspectWindowsProtectedExecutableTree('C:\\safe\\file.exe:ads','win32'),
    /S3_ACL_INVALID_PATH/);
});


test('native Windows read-only ACL scan refuses the current-user-writable temporary installer tree',async(t)=>{
  if(process.platform!=='win32'){t.skip('Windows ACL API only');return;}
  const {promises:fs}=await import('node:fs');
  const os=await import('node:os');
  const path=await import('node:path');
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'nexowire-s3-acl-negative-'));
  try{
    await fs.writeFile(path.join(dir,'signed-looking-installer.exe'),Buffer.from('NOT_SIGNED'));
    assert.throws(
      ()=>inspectWindowsProtectedExecutableTree(dir),
      /S3_ACL_UNTRUSTED_NODE|S3_ACL_UNTRUSTED_WRITER/,
    );
  }finally{await fs.rm(dir,{force:true,recursive:true});}
});
