import test from 'node:test';
import assert from 'node:assert/strict';
import {dpapiChildStage} from '../../src/security/windows-dpapi.js';
const stages=['script-start','assembly-loaded','stdin-read','input-decoded','crypto-start','crypto-complete','output-complete'];
const marker=(s:string)=>'NWX_DPAPI_STAGE:'+s;
test('DPAPI diagnostic reports only ordered, fixed stage markers',()=>{
  assert.equal(dpapiChildStage(''), 'before-script');
  for(let i=0;i<stages.length;i++){
    const output=stages.slice(0,i+1).map(marker).join('\r\n');
    assert.equal(dpapiChildStage(output),stages[i]);
  }
  assert.equal(dpapiChildStage([...stages.slice(0,5),'crypto-rejected'].map(marker).join('\n')),'crypto-rejected');
  assert.equal(dpapiChildStage(marker('crypto-rejected')),'before-script');
  assert.equal(dpapiChildStage([marker('script-start'),marker('crypto-start')].join('\n')),'before-script');
  assert.equal(dpapiChildStage(stages.map(marker).join('\n')+'\n'+marker('unexpected-secret')),'before-script');
  assert.equal(dpapiChildStage(marker('script-start')+'\nraw stderr must never become a stage'),'script-start');
});
