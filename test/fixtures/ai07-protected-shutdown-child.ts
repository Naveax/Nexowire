import {readFile} from 'node:fs/promises';
import {runNativeAgent} from '../../src/agent/native-agent.js';
import {createTransferRuntimeLeaseAuthority,withVerifiedTransferHelper} from '../../src/agent/protected-transfer-startup.js';
import {ProtectedHelperSelectionClient,type HelperSelectionTlsConfig} from '../../src/security/protected-helper-selection-transport.js';
import type {HelperPin,TransferHelperArtifactStore} from '../../src/installer/protected-transfer-helper-lifecycle.js';
import assert from 'node:assert/strict';

// Isolated test-only harness. No protected Publisher, physical native effect
// provider, installed runtime or production credential is supplied.
const lease=new AbortController(),stop=new AbortController();
process.stdin.once('data',chunk=>{
  process.stdin.pause();
  if(String(chunk).trim()==='revoke')lease.abort();else stop.abort();
});
async function run(signal:AbortSignal){
  await runNativeAgent(process.env,undefined,undefined,undefined,undefined,signal,undefined,stop.signal);
  process.stdout.write('AI07_LOCAL_SHUTDOWN_RETURNED\n');
}
try{
  const configFile=process.env.NEXOWIRE_AI07_SHUTDOWN_LEASE_FIXTURE;
  if(configFile){
    assert.equal(process.platform,'linux');
    assert.equal(process.env.GITHUB_ACTIONS,'true');
    assert.equal(process.env.RUNNER_ENVIRONMENT,'github-hosted');
    const fixture=JSON.parse(await readFile(configFile,'utf8')) as {
      tls:Omit<HelperSelectionTlsConfig,'credential'>;credential:string;pin:HelperPin;
    };
    const provider=createTransferRuntimeLeaseAuthority(new ProtectedHelperSelectionClient({...fixture.tls,credential:async()=>fixture.credential}),30000);
    const store:TransferHelperArtifactStore={async verifyInstalled(pin){assert.deepEqual(pin,fixture.pin);},async stage(){throw Error('unexpected stage');}};
    await withVerifiedTransferHelper(provider,store,async(_binding,scope)=>{
      await run(scope.signal);
      await scope.assertActive();
    });
    process.stdout.write('AI07_SIGNED_RELEASE_CONFIRMED\n');
  }else await run(lease.signal);
}catch(error){
  process.stderr.write(String(error)+'\n');
  process.exitCode=1;
}finally{process.stdin.destroy();}
