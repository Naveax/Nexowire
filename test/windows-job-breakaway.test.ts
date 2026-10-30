import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {ProcessManager} from '../src/agent/process-manager.js';
import {PathPolicy} from '../src/agent/path-policy.js';

test('Job cannot CREATE_BREAKAWAY_FROM_JOB a synthetic suspended child', {
  skip:process.platform!=='win32',timeout:30000,
},async()=>{
  const fixture=path.resolve('test/fixtures/windows-job-breakaway-attempt.exe');
  await fs.access(fixture);
  const manager=new ProcessManager();
  const session=await manager.start({shell:'powershell',command:"& '"+fixture.replaceAll("'","''")+"'"},
    new PathPolicy(['*']));
  let cursor=0,stdout='',stderr='',last='running';
  try {
    assert.equal(session.treeOwnership,'windows_job');
    for(let i=0;i<45;i++){
      const response=await manager.read({session_id:session.sessionId,
        after_seq:cursor,wait_ms:300});
      cursor=response.nextSeq;
      for(const event of response.events){
        if(event.stream==='stdout')stdout+=event.text;
        if(event.stream==='stderr')stderr+=event.text;
      }
      last=response.session.status;
      if(last==='exited')break;
    }
    assert.equal(last,'exited','test-created process must finish');
    assert.match(stdout,/NW_BREAKAWAY_DENIED (?:5|87)/,
      'the child must not escape a no-breakaway Job: '+stderr.slice(0,500));
  }finally{
    if(last==='running') await manager.stop({session_id:session.sessionId}).catch(()=>undefined);
  }
});
