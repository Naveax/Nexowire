import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateCandidateProtectedSourceAcls,
  type CapturedProtectedSourceAcl,type ProtectedSourceRole,
} from '../src/security/access-acl-candidate-gate.js';

const roles:ProtectedSourceRole[]=[
  'private-parent','updater-parent','updater','broker-launcher',
  'broker-binary','job-helper','job-helper-manifest',
];
function fixture():CapturedProtectedSourceAcl[] {
  return roles.map((role,i)=>({
    role,canonicalPath:'C:\\VMFixture\\protected\\node-'+i,
    ownerSid:'S-1-5-32-544',identityVerified:true,
    aclReadSucceeded:true,reparsePoint:false,
    accessRules:[
      {sid:'S-1-5-18',type:'Allow' as const,rights:0x1f01ff,inherited:false},
      {sid:'S-1-5-32-544',type:'Allow' as const,rights:0x1f01ff,inherited:true},
      {sid:'S-1-5-11',type:'Allow' as const,rights:0x1200a9,inherited:true},
    ],
  }));
}
const gate=(xs:CapturedProtectedSourceAcl[])=>evaluateCandidateProtectedSourceAcls(xs);

test('candidate read-only ACL audit never reports physical effective access or production approval',()=>{
  const safe=gate(fixture());
  assert.equal(safe.status,'CANDIDATE_SAFE_ONLY');
  assert.equal(safe.productionApproved,false);
  assert.equal(safe.independentEffectiveAccessVerified,false);
  assert.equal(safe.checkedRoles,7);
  assert.equal(Object.isFrozen(safe),true);
});

test('inherited Authenticated Users Modify on any parent/updater/helper/source node blocks',()=>{
  for(let i=0;i<roles.length;i++){
    const nodes=fixture();
    nodes[i]={...nodes[i]!,accessRules:[...nodes[i]!.accessRules,{
      sid:'S-1-5-11',type:'Allow',rights:0x1301bf,inherited:true,
    }]};
    const r=gate(nodes);
    assert.equal(r.status,'BLOCKED',roles[i]);
    assert.ok(r.errors.includes('UNTRUSTED_WRITE_OR_REPLACEMENT_ACE:'+roles[i]));
    assert.equal(r.productionApproved,false);
  }
});

test('generic write, DeleteChild, WriteDac, generic all and foreign updater owner reject',()=>{
  for(const bits of [0x40000000,0x10000000,0x40000,0x40,0x80000,0x10000]){
    const sample=fixture();
    sample[1]={...sample[1]!,accessRules:[...sample[1]!.accessRules,{
      sid:'S-1-5-32-545',type:'Allow',rights:bits,inherited:true,
    }]};
    assert.equal(gate(sample).status,'BLOCKED','rights '+bits);
  }
  const sample=fixture();
  sample[2]={...sample[2]!,ownerSid:'S-1-5-21-123-456-789-1001'};
  assert.equal(gate(sample).status,'BLOCKED');
});

test('DENY ACE does not cancel untrusted Allow in an unverifiable token/DACL order',()=>{
  const sample=fixture();
  sample[0]={...sample[0]!,accessRules:[
    {sid:'S-1-5-11',type:'Deny',rights:0x1301bf,inherited:false},
    {sid:'S-1-5-11',type:'Allow',rights:0x1301bf,inherited:true},
  ]};
  assert.equal(gate(sample).status,'BLOCKED');
});

test('missing updater, manifest or parent evidence, unreadable ACL and reparse all block',()=>{
  for(const i of [0,1,2,3,4,5,6]){
    assert.equal(gate(fixture().filter((_,index)=>index!==i)).status,'BLOCKED',roles[i]);
  }
  for(const patch of [
    {aclReadSucceeded:false},{identityVerified:false},{reparsePoint:true},
    {canonicalPath:'C:\\VMFixture\\..\\fake'},
    {canonicalPath:'\\\\server\\share'},
  ]){
    const sample=fixture();
    sample[4]={...sample[4]!,...patch};
    assert.equal(gate(sample).status,'BLOCKED');
  }
});

test('duplicate path, spoofed owner, malformed rights and inherited IO future ACE block',()=>{
  for(const variant of [
    {canonicalPath:'C:\\VMFixture\\protected\\node-0'},
    {ownerSid:'S-1-5-11'},
    {accessRules:[{sid:'S-1-5-11',type:'Allow',rights:0x100000000,inherited:true}]},
    {accessRules:[{sid:'S-1-5-11',type:'Allow',rights:0x40000,inherited:true}]},
  ]){
    const sample=fixture();
    sample[5]={...sample[5]!,...variant} as CapturedProtectedSourceAcl;
    assert.equal(gate(sample).status,'BLOCKED');
  }
});
