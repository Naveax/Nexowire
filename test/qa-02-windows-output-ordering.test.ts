import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { ProcessManager } from '../src/agent/process-manager.js';
import { PathPolicy } from '../src/agent/path-policy.js';

interface ObservedEvent {
  seq: number;
  stream: 'stdout' | 'stderr';
  text: string;
}
interface Snapshot {
  status: string;
  events: ObservedEvent[];
  nextSeq: number;
}

/**
 * QA-only, fail-closed output ordering oracle. A terminal process-status
 * observation is not evidence that a stdout/stderr marker was delivered.
 * Reject missing output at the instant 'exited' becomes observable: reading
 * a later batch and retroactively declaring the earlier status correct would
 * hide the intermittent Windows Job race.
 */
function attestExitAfterOutput(snapshots: Snapshot[], stdoutMarker: string, stderrMarker: string) {
  let cursor = 0;
  let stdout = '';
  let stderr = '';
  let exited = false;
  for (const snapshot of snapshots) {
    for (const event of snapshot.events) {
      assert.ok(Number.isSafeInteger(event.seq) && event.seq > cursor,
        'stream sequence must be strictly increasing and non-duplicated');
      cursor = event.seq;
      if (event.stream === 'stdout') stdout += event.text;
      else stderr += event.text;
    }
    assert.equal(snapshot.nextSeq,cursor,'response cursor must equal consumed sequence');
    if (snapshot.status === 'exited') {
      assert.ok(stdout.includes(stdoutMarker),
        'exited observed before stdout proof reached reader');
      assert.ok(stderr.includes(stderrMarker),
        'exited observed before stderr proof reached reader');
      exited = true;
      break;
    }
    assert.equal(snapshot.status,'running','orphaned/lost are not successful exit');
  }
  assert.ok(exited,'bounded process never reported a proved exited state');
  return {stdout,stderr,cursor};
}

const stdoutMarker = 'QA02_SYNTHETIC_OUT';
const stderrMarker = 'QA02_SYNTHETIC_ERR';
const result = (status:string,events:ObservedEvent[],nextSeq:number):Snapshot =>
  ({status,events,nextSeq});

test('QA02 output ordering negative: terminal status before stdout is rejected', () => {
  assert.throws(() => attestExitAfterOutput([
    result('running',[{seq:1,stream:'stderr',text:stderrMarker}],1),
    result('exited',[],1),
  ],stdoutMarker,stderrMarker), /exited observed before stdout proof/);
});

test('QA02 output ordering negative: terminal status before stderr is rejected', () => {
  assert.throws(() => attestExitAfterOutput([
    result('running',[{seq:1,stream:'stdout',text:stdoutMarker}],1),
    result('exited',[],1),
  ],stdoutMarker,stderrMarker), /exited observed before stderr proof/);
});

test('QA02 output ordering negative: lost or orphaned is never rewritten as success', () => {
  for (const status of ['lost','orphaned','unknown']) {
    assert.throws(() => attestExitAfterOutput([
      result(status,[
        {seq:1,stream:'stdout',text:stdoutMarker},
        {seq:2,stream:'stderr',text:stderrMarker},
      ],2),
    ],stdoutMarker,stderrMarker), /not successful exit/);
  }
});

test('QA02 output ordering negative: duplicated/out-of-order sequence cannot claim completion', () => {
  assert.throws(() => attestExitAfterOutput([
    result('exited',[
      {seq:2,stream:'stdout',text:stdoutMarker},
      {seq:1,stream:'stderr',text:stderrMarker},
    ],2),
  ],stdoutMarker,stderrMarker), /strictly increasing/);
});

test('QA02 output ordering control: split valid stream events precede exited', () => {
  const proof = attestExitAfterOutput([
    result('running',[{seq:1,stream:'stderr',text:stderrMarker}],1),
    result('running',[{seq:2,stream:'stdout',text:stdoutMarker}],2),
    result('exited',[],2),
  ],stdoutMarker,stderrMarker);
  assert.equal(proof.cursor,2);
});

test('QA02 Windows physical Job fast-exit read cannot outrun both pipes', {
  skip: process.platform !== 'win32',timeout:45_000,
},async () => {
  const manager = new ProcessManager();
  const policy = new PathPolicy(['*']);
  // Independent lightweight QA of the already-existing 12-iteration owner
  // regression. Starts only freshly created synthetic cmd processes.
  for (let iteration=0;iteration<8;iteration++) {
    const marker='QA02_JOB_'+randomBytes(8).toString('hex');
    const stdout=marker+'_OUT',stderr=marker+'_ERR';
    const session=await manager.start({
      shell:'cmd', command:'echo '+stdout+' & echo '+stderr+' 1>&2',
    },policy);
    assert.equal(session.treeOwnership,'windows_job');
    const snapshots:Snapshot[]=[];
    let cursor=0;
    try {
      for(let poll=0;poll<35;poll++) {
        const read=await manager.read({
          session_id:session.sessionId,after_seq:cursor,max_events:100,wait_ms:250,
        });
        snapshots.push({
          status:read.session.status,
          nextSeq:read.nextSeq,
          events:read.events.map(evt=>({
            seq:evt.seq,stream:evt.stream,text:evt.text,
          })),
        });
        cursor=read.nextSeq;
        if(read.session.status!=='running')break;
      }
      try {
        attestExitAfterOutput(snapshots,stdout,stderr);
      } catch(error) {
        assert.fail('physical Job iteration '+iteration+', session '+session.sessionId+
          ', statuses='+snapshots.map(s=>s.status+':'+s.nextSeq).join(',')+
          '; '+(error instanceof Error?error.message:String(error)));
      }
    } finally {
      const latest=snapshots.at(-1);
      if(latest?.status==='running') {
        await manager.stop({session_id:session.sessionId});
      }
    }
  }
});
