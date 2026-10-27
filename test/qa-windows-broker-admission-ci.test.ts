/** #11 CI QA: fixture results do not establish physical CORE readiness. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {assessBrokerFixtureTap}
  from '../scripts/qa-windows-broker-admission.js';

const first='Windows privileged broker refuses bearer-only elevated callbacks';
const second='Broker HTTP route gates native, injected, installer, updater and no-provider';
const tap=(a:string,b:string)=>'TAP version 13\n'+a+'\n'+b+'\n';
const ok=(index:number,name:string)=>`ok ${index} - ${name}`;

test('Windows Broker CI fixture accepts both actual unskipped passing cases',()=>{
  const result=assessBrokerFixtureTap(tap(ok(4,first),ok(13,second)),0);
  assert.equal(result.ok,true);
  assert.equal(result.physicalAcceptance,'NOT_PROVEN');
  const windowsLines=tap(ok(4,first),ok(13,second)).replaceAll('\n','\r\n');
  assert.equal(assessBrokerFixtureTap(windowsLines,0).ok,true);
});

test('Windows Broker CI fixture rejects a skipped, failed or absent case',()=>{
  for(const result of [
    assessBrokerFixtureTap(tap(ok(4,first)+' # SKIP',ok(13,second)),0),
    assessBrokerFixtureTap(tap(ok(4,first),'not '+ok(13,second)),0),
    assessBrokerFixtureTap(tap(ok(4,first),'# omitted'),0),
    assessBrokerFixtureTap(tap(ok(4,first),ok(13,second)),1),
    assessBrokerFixtureTap(tap(ok(4,first),ok(13,second)),null),
  ]){
    assert.equal(result.ok,false);
    assert.equal(result.physicalAcceptance,'NOT_PROVEN');
  }
});

test('Windows Broker CI fixture rejects duplicated or TODO case output',()=>{
  assert.equal(assessBrokerFixtureTap(
    tap(ok(4,first),ok(13,second)+' # TODO future'),0).ok,false);
  assert.equal(assessBrokerFixtureTap(
    tap(ok(4,first)+'\n'+ok(5,first),ok(13,second)),0).ok,false);
});

test('CI keeps Node check phases in package order and schedules Windows Broker QA',()=>{
  const workflow=readFileSync(new URL('../.github/workflows/ci.yml',import.meta.url),'utf8');
  const pkg=JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8')) as {
    scripts:Record<string,string>;
  };
  assert.equal(pkg.scripts.precheck,undefined);
  assert.equal(pkg.scripts.postcheck,undefined);
  const job=(name:string):string=>{
    const start=workflow.indexOf(`\n  ${name}:\n`);
    assert.notEqual(start,-1,`missing job ${name}`);
    const tail=workflow.slice(start+1);
    const next=/\n  [a-zA-Z0-9_-]+:\s*\n/.exec(tail.slice(1));
    return next?tail.slice(0,next.index+1):tail;
  };
  const nodeRuns=[...job('test').matchAll(/^\s+(?:-\s*)?run:\s*(.*?)\s*$/gm)].map(m=>m[1]);
  const check=pkg.scripts.check;
  assert.ok(check);
  const expected=check.split(/\s*&&\s*/);
  const begin=nodeRuns.indexOf('npm ci');
  assert.notEqual(begin,-1);
  assert.deepEqual(nodeRuns.slice(begin+1,begin+1+expected.length),expected);
  assert.equal(nodeRuns[begin+1+expected.length],'npm run build');
  assert.match(job('browser-live'),
    /^\s+run:\s*node --import tsx scripts\/qa-windows-broker-admission\.ts\s*$/m);
});
