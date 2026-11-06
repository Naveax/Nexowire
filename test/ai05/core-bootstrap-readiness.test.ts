import test from 'node:test';
import assert from 'node:assert/strict';
import {CoreConsoleAdmission} from '../../src/agent/core-console-admission.js';
import {createWindowsCoreConsoleAdmission} from '../../src/agent/windows-core-console-provider.js';

test('CORE missing-provider state remains distinct from a verified indefinite grant',async()=>{
  for (const reason of [
    'CORE_CONSOLE_PROVIDER_UNAVAILABLE',
    'CORE_BROKER_MODE_REQUIRED',
    'CORE_DEVICE_CREDENTIAL_REQUIRED',
    'CORE_AUTHORITY_UNCONFIGURED',
  ] as const) {
    const admission=new CoreConsoleAdmission(undefined,undefined,Date.now,reason);
    const status=await admission.status('full');
    assert.equal(status.state,reason);
    assert.equal(status.active,false);
    assert.equal(status.localEnrolled,false);
    assert.equal(status.duration,'indefinite-revocable');
    assert.equal(status.expiresAt,null);
  }
});

test('Windows CORE bootstrap reports missing authority, credential and Broker independently',{
  skip:process.platform!=='win32',
},async()=>{
  const common={deviceId:'nwx-device-availability-fixture',env:{} as NodeJS.ProcessEnv};
  const noAuthority=await createWindowsCoreConsoleAdmission({
    ...common,credential:'nwx_dev_disposable-fixture-only',
  });
  assert.equal((await noAuthority.status('full')).state,'CORE_AUTHORITY_UNCONFIGURED');

  const noCredential=await createWindowsCoreConsoleAdmission({
    ...common,env:{NEXOWIRE_CORE_AUTHORITY_URL:'https://core.example.test'},
  });
  assert.equal((await noCredential.status('full')).state,'CORE_DEVICE_CREDENTIAL_REQUIRED');

  const directMode=await createWindowsCoreConsoleAdmission({
    ...common,credential:'nwx_dev_disposable-fixture-only',
    env:{NEXOWIRE_CORE_AUTHORITY_URL:'https://core.example.test'},
  });
  assert.equal((await directMode.status('full')).state,'CORE_BROKER_MODE_REQUIRED');
});
