/**
 * Worker30 NEXT: isolated reference-model acceptance for tenant memory leases.
 * The #598 parser has no authenticated tenant memory lease or durable cancel
 * completion witness. This file is a deterministic *design contract*, not
 * proof that deployed HTTP already enforces these rules.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const CHUNK=65_536;
const PER_TENANT_MAX=CHUNK*2;
const BASE_SHA='cf58e6882e44968698f3f548b353287ba1698747';
const SEED=0x30ca5e21;
type Tenant='tenant30-owner-a'|'tenant30-owner-b';
type RecordState='ACTIVE'|'CANCEL_REQUESTED'|'MUTATION_UNKNOWN'|'RELEASED';
type RecordItem={owner:Tenant;id:string;epoch:number;bytes:number;state:RecordState};
type VerifierFields={
  owner:Tenant;id:string;epoch:number;
  writerStopped:boolean;durablePostconditionVerified:boolean;
};
class TestOnlyIndependentWitness{
  private readonly issued=new WeakMap<object,VerifierFields>();
  // These booleans simulate independent source observations ONLY. Real
  // verification is BLOCKED without production external writer fence.
  issue(fields:VerifierFields):object{
    const token=Object.freeze({});
    this.issued.set(token,{...fields});
    return token;
  }
  match(token:object,owner:Tenant,id:string,epoch:number):boolean{
    const proof=this.issued.get(token);
    return !!proof&&proof.owner===owner&&proof.id===id&&proof.epoch===epoch&&
      proof.writerStopped===true&&proof.durablePostconditionVerified===true;
  }
}
class TestOnlyMemoryAdmission {
  private readonly items=new Map<string,RecordItem>();
  constructor(private readonly witness:TestOnlyIndependentWitness){}
  used(owner:Tenant):number{
    return [...this.items.values()].filter(x=>x.owner===owner&&x.state!=='RELEASED')
      .reduce((sum,x)=>sum+x.bytes,0);
  }
  reserve(owner:Tenant,id:string,epoch:number,bytes:number):
      'RESERVED'|'DUPLICATE'|'CONFLICT'|'THROTTLED'{
    if(!Number.isSafeInteger(epoch)||epoch<1||!Number.isSafeInteger(bytes)||
      bytes<1||bytes>CHUNK)throw Error('INVALID_ADMISSION');
    const prev=this.items.get(id);
    if(prev)return prev.owner===owner&&prev.epoch===epoch&&prev.bytes===bytes
      ?'DUPLICATE':'CONFLICT';
    if(this.used(owner)+bytes>PER_TENANT_MAX)return 'THROTTLED';
    this.items.set(id,{owner,id,epoch,bytes,state:'ACTIVE'});
    return 'RESERVED';
  }
  cancel(owner:Tenant,id:string,epoch:number):
      'CANCEL_REQUESTED'|'CONFLICT'|'ALREADY_RELEASED'{
    const r=this.items.get(id);
    if(!r||r.owner!==owner||r.epoch!==epoch)return 'CONFLICT';
    if(r.state==='RELEASED')return 'ALREADY_RELEASED';
    if(r.state==='ACTIVE')r.state='CANCEL_REQUESTED';
    return 'CANCEL_REQUESTED';
  }
  acknowledgeUnknown(owner:Tenant,id:string,epoch:number):
      'MUTATION_UNKNOWN'|'CONFLICT'{
    const r=this.items.get(id);
    if(!r||r.owner!==owner||r.epoch!==epoch||r.state==='RELEASED')
      return 'CONFLICT';
    r.state='MUTATION_UNKNOWN';
    return 'MUTATION_UNKNOWN';
  }
  release(owner:Tenant,id:string,epoch:number,receipt:object):
      'RELEASED'|'ALREADY_RELEASED'|'PROOF_REQUIRED'|'CONFLICT'{
    const r=this.items.get(id);
    if(!r||r.owner!==owner||r.epoch!==epoch)return 'CONFLICT';
    if(r.state==='RELEASED')return 'ALREADY_RELEASED';
    if(!this.witness.match(receipt,owner,id,epoch))return 'PROOF_REQUIRED';
    r.state='RELEASED';
    return 'RELEASED';
  }
  snapshot(owner:Tenant){
    return [...this.items.values()].filter(x=>x.owner===owner)
      .map(({id,epoch,bytes,state})=>({id,epoch,bytes,state}));
  }
}
const A:'tenant30-owner-a'='tenant30-owner-a';
const B:'tenant30-owner-b'='tenant30-owner-b';

test('worker30-next cancellation and UNKNOWN never free owner memory before independently witnessed completion',()=>{
  const verifier=new TestOnlyIndependentWitness();
  const ledger=new TestOnlyMemoryAdmission(verifier);
  assert.equal(ledger.reserve(A,'a-active-1',4,CHUNK),'RESERVED');
  assert.equal(ledger.reserve(A,'a-active-2',4,CHUNK),'RESERVED');
  assert.equal(ledger.reserve(A,'a-active-3',4,CHUNK),'THROTTLED');
  assert.equal(ledger.reserve(B,'b-active-1',9,CHUNK),'RESERVED');
  assert.equal(ledger.reserve(B,'b-active-2',9,CHUNK),'RESERVED');
  assert.equal(ledger.reserve(B,'b-active-3',9,CHUNK),'THROTTLED');

  assert.equal(ledger.cancel(A,'a-active-1',4),'CANCEL_REQUESTED');
  assert.equal(ledger.cancel(A,'a-active-1',4),'CANCEL_REQUESTED');
  assert.equal(ledger.acknowledgeUnknown(A,'a-active-1',4),'MUTATION_UNKNOWN');
  assert.equal(ledger.used(A),PER_TENANT_MAX,
    'loss of ACK is NOT a positive release or safe automatic replay');
  assert.equal(ledger.reserve(A,'a-active-3',4,CHUNK),'THROTTLED');
  assert.equal(ledger.reserve(B,'b-active-3',9,CHUNK),'THROTTLED');

  const forged=Object.freeze({writerStopped:true,durablePostconditionVerified:true});
  assert.equal(ledger.release(A,'a-active-1',4,forged),'PROOF_REQUIRED');
  assert.equal(ledger.release(B,'a-active-1',4,forged),'CONFLICT');
  assert.equal(ledger.release(A,'a-active-1',3,forged),'CONFLICT');

  const unverified=verifier.issue({owner:A,id:'a-active-1',epoch:4,
    writerStopped:false,durablePostconditionVerified:true});
  assert.equal(ledger.release(A,'a-active-1',4,unverified),'PROOF_REQUIRED');
  const stale=verifier.issue({owner:A,id:'a-active-1',epoch:3,
    writerStopped:true,durablePostconditionVerified:true});
  assert.equal(ledger.release(A,'a-active-1',4,stale),'PROOF_REQUIRED');
  assert.equal(ledger.used(A),PER_TENANT_MAX);

  const verified=verifier.issue({owner:A,id:'a-active-1',epoch:4,
    writerStopped:true,durablePostconditionVerified:true});
  assert.equal(ledger.release(A,'a-active-1',4,verified),'RELEASED');
  assert.equal(ledger.release(A,'a-active-1',4,verified),'ALREADY_RELEASED');
  assert.equal(ledger.used(A),CHUNK);
  assert.equal(ledger.used(B),PER_TENANT_MAX,'quiet owner accounting is isolated');
  assert.equal(ledger.reserve(A,'a-active-3',4,CHUNK),'RESERVED');
  assert.equal(ledger.reserve(A,'a-active-3',4,CHUNK),'DUPLICATE');
  assert.equal(ledger.reserve(B,'a-active-3',4,CHUNK),'CONFLICT');
  assert.equal(ledger.used(A),PER_TENANT_MAX);
  assert.equal(ledger.snapshot(A).filter(x=>x.state==='RELEASED').length,1);
  process.stdout.write('QA30_NEXT_MEMORY '+JSON.stringify({
    sourceBaseSha:BASE_SHA,workflowSha:process.env.GITHUB_SHA??null,
    seed:SEED,classification:'TEST_ONLY_WITNESS_MODEL_NOT_PRODUCTION_ATTESTATION',
    chunkBytes:CHUNK,tenantMemoryCapBytes:PER_TENANT_MAX,
    reservationReleasedOnlyAfterVerifiedWriterStopAndPostcondition:true,
    physicalBytesTransferred:0,realAgentOperations:0,providerMeter:null,
  })+'\n');
});
test('worker30-next forged or mismatched completion cannot refund reserved memory',()=>{
  const verifier=new TestOnlyIndependentWitness();
  const ledger=new TestOnlyMemoryAdmission(verifier);
  assert.equal(ledger.reserve(B,'b-unknown-1',11,CHUNK),'RESERVED');
  assert.equal(ledger.cancel(B,'b-unknown-1',11),'CANCEL_REQUESTED');
  assert.equal(ledger.acknowledgeUnknown(B,'b-unknown-1',11),'MUTATION_UNKNOWN');
  const otherOwner=verifier.issue({owner:A,id:'b-unknown-1',epoch:11,
    writerStopped:true,durablePostconditionVerified:true});
  assert.equal(ledger.release(B,'b-unknown-1',11,otherOwner),'PROOF_REQUIRED');
  const missingPostcondition=verifier.issue({owner:B,id:'b-unknown-1',epoch:11,
    writerStopped:true,durablePostconditionVerified:false});
  assert.equal(ledger.release(B,'b-unknown-1',11,missingPostcondition),
    'PROOF_REQUIRED');
  assert.equal(ledger.used(B),CHUNK);
  assert.equal(ledger.reserve(B,'b-other-1',11,CHUNK),'RESERVED');
  assert.equal(ledger.reserve(B,'b-extra-1',11,CHUNK),'THROTTLED');
  assert.equal(ledger.acknowledgeUnknown(B,'b-unknown-1',10),'CONFLICT');
  assert.equal(ledger.used(B),PER_TENANT_MAX);
});
