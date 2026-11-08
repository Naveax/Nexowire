import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import {
  checkLiveUpdate,
  compareReleaseVersions,
  machineComponentsPendingBeforeCutover,
  parseWindowsChecksumFile,
  parseWindowsSetupMetadata,
  readLiveUpdateState,
  renderWindowsCutoverScript,
  windowsUpdateStagingParent,
} from '../src/update/live-update.js';

test('machine update remains pending until actual elevated Broker version readback', () => {
  const targetVersion='1.0.8';
  assert.equal(machineComponentsPendingBeforeCutover(targetVersion,null),true,
    'manual user cutover without a Broker must not claim machine version current');
  assert.equal(machineComponentsPendingBeforeCutover(targetVersion,
    {reachable:false,elevated:false,version:null}),true);
  assert.equal(machineComponentsPendingBeforeCutover(targetVersion,
    {reachable:true,elevated:false,version:targetVersion}),true);
  assert.equal(machineComponentsPendingBeforeCutover(targetVersion,
    {reachable:true,elevated:true,version:null}),true);
  assert.equal(machineComponentsPendingBeforeCutover(targetVersion,
    {reachable:true,elevated:true,version:'1.0.7'}),true);
  assert.equal(machineComponentsPendingBeforeCutover(targetVersion,
    {reachable:true,elevated:true,version:targetVersion}),false);
  // The generated Windows helper still makes the terminal decision from
  // actual installed machine tasks; a missing Broker cannot mark a staged
  // cutover complete before that independent readback.
  const script=renderWindowsCutoverScript({
    targetVersion,buildId:'1.0.8-012345abcdef',
    targetRoot:'C:\\Nexowire\\versions\\1.0.8-012345abcdef',
    localAppData:'C:\\Users\\test\\AppData\\Local',
  });
  assert.match(script,/\$machinePending=\(Task-Exists/);
  assert.match(script,/Write-State 'succeeded' \$null \$machinePending/);
});

test('status does not erase machine pending for unfinished or failed cutovers', async () => {
  const {executeLiveUpdateCapability} = await import('../src/update/live-update.js');
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'nexowire-status-pending-'));
  const file=path.join(temp,'Nexowire','update','status.json');
  let probes=0;
  const options={
    localAppData:temp,
    privilegedBroker:{probe:async()=>{
      probes++;
      return {reachable:true,elevated:true,version:'1.0.8'};
    }} as never,
  };
  try {
    await fs.mkdir(path.dirname(file),{recursive:true});
    const baseline={
      schemaVersion:1 as const,currentVersion:'1.0.7',
      targetVersion:'1.0.8',buildId:'1.0.8-012345abcdef',
      targetRoot:path.join(temp,'Nexowire','versions','1.0.8-012345abcdef'),
      machineComponentsPending:true,
      agentStartupVerified:false,activeConnectionVerified:false,
      updatedAt:'2026-11-07T00:00:00.000Z',error:null,
    };
    for(const state of ['cutover_scheduled','failed','rolled_back','rollback_failed'] as const){
      const pending={...baseline,state};
      const original=JSON.stringify(pending);
      await fs.writeFile(file,original);
      const result=await executeLiveUpdateCapability('nexowire.update.status',{},options) as
        {data:{state:string;machineComponentsPending:boolean}};
      assert.equal(result.data.state,state);
      assert.equal(result.data.machineComponentsPending,true,
        state+' must not claim machine update completed');
      assert.equal(await fs.readFile(file,'utf8'),original,
        state+' status inspection must not rewrite an incomplete or failed cutover');
    }
    const succeeded={...baseline,state:'succeeded' as const,currentVersion:'1.0.8'};
    const succeededBytes=JSON.stringify(succeeded);
    await fs.writeFile(file,succeededBytes);
    const accepted=await executeLiveUpdateCapability('nexowire.update.status',{},options) as
      {data:{state:string;machineComponentsPending:boolean}};
    assert.equal(accepted.data.state,'succeeded');
    assert.equal(accepted.data.machineComponentsPending,false);
    assert.equal((await readLiveUpdateState({localAppData:temp})).machineComponentsPending,false);
    assert.equal(await fs.readFile(file,'utf8'),succeededBytes,
      'status reconciliation must not rewrite successful cutover evidence');
    assert.equal(probes,1,'unfinished or failed status must not probe or rewrite');
  }finally{
    await fs.rm(temp,{recursive:true,force:true});
  }
});

test('Broker probe racing a new cutover cannot replace the new status file',async()=>{
  const {executeLiveUpdateCapability}=await import('../src/update/live-update.js');
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'nexowire-reconcile-race-'));
  const file=path.join(temp,'Nexowire','update','status.json');
  try {
    await fs.mkdir(path.dirname(file),{recursive:true});
    const completed={
      schemaVersion:1,state:'succeeded',currentVersion:'1.0.8',
      targetVersion:'1.0.8',buildId:'1.0.8-aaaaaaaaaaaa',
      targetRoot:path.join(temp,'versions','1.0.8-aaaaaaaaaaaa'),
      machineComponentsPending:true,agentStartupVerified:true,
      activeConnectionVerified:false,updatedAt:'2026-11-07T00:00:00.000Z',error:null,
    };
    const started={
      ...completed,state:'cutover_scheduled',targetVersion:'1.0.9',
      buildId:'1.0.9-bbbbbbbbbbbb',
      targetRoot:path.join(temp,'versions','1.0.9-bbbbbbbbbbbb'),
      updatedAt:'2026-11-07T00:00:01.000Z',
    };
    const startedBytes=JSON.stringify(started);
    await fs.writeFile(file,JSON.stringify(completed));
    const result=await executeLiveUpdateCapability('nexowire.update.status',{},{
      localAppData:temp,
      privilegedBroker:{probe:async()=>{
        // Another process commits its next durable operation during the await.
        await fs.writeFile(file,startedBytes);
        return {reachable:true,elevated:true,version:'1.0.8'};
      }} as never,
    }) as {data:{state:string;machineComponentsPending:boolean}};
    assert.equal(result.data.state,'cutover_scheduled');
    assert.equal(result.data.machineComponentsPending,true);
    assert.equal(await fs.readFile(file,'utf8'),startedBytes);
    // A marker for the prior completed build must never green a newer build.
    await fs.writeFile(file,JSON.stringify({
      ...completed,state:'succeeded',targetVersion:'1.0.9',
      buildId:'1.0.9-bbbbbbbbbbbb',
      targetRoot:started.targetRoot,updatedAt:'2026-11-07T00:00:02.000Z',
    }));
    assert.equal((await readLiveUpdateState({localAppData:temp})).machineComponentsPending,true);
    // The old completed snapshot is eligible for its *own* cached readback.
    await fs.writeFile(file,JSON.stringify(completed));
    assert.equal((await readLiveUpdateState({localAppData:temp})).machineComponentsPending,false);
  }finally{
    await fs.rm(temp,{recursive:true,force:true});
  }
});

test('concurrent Windows update apply attempts reserve a single process owner',async()=>{
  const {applyLatestLiveUpdate}=await import('../src/update/live-update.js');
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'nexowire-apply-race-'));
  let firstEntered!:()=>void;
  const entered=new Promise<void>(resolve=>{firstEntered=resolve;});
  let rejectFirst!: (error:Error)=>void;
  let concurrentFetches=0;
  try{
    const first=applyLatestLiveUpdate({localAppData:temp,
      fetchImpl:async()=>{
        firstEntered();
        return await new Promise<Response>((_resolve,reject)=>{
          rejectFirst=reject;
        });
      },
    }).then(()=>null,(error:unknown)=>error);
    await entered;
    const active=path.join(temp,'Nexowire','update','status.json');
    await assert.rejects(fs.stat(active),{code:'ENOENT'});
    try{
      await assert.rejects(applyLatestLiveUpdate({localAppData:temp,
        fetchImpl:async()=>{
          concurrentFetches++;
          throw new Error('CONCURRENT_FETCH_STARTED');
        },
      }),/already in progress/i);
      assert.equal(concurrentFetches,0,
        'a second process must not issue a request while the first owns the lock');
    }finally{
      rejectFirst(new Error('FIRST_FETCH_ABORT'));
    }
    assert.match(String(await first),/FIRST_FETCH_ABORT/);
    const recovered=await applyLatestLiveUpdate({localAppData:temp,
      fetchImpl:async()=>Response.json({
        tag_name:'v1.0.8',
        html_url:'https://github.com/Naveax/Nexowire/releases/tag/v1.0.8',
      }),
    });
    assert.equal(recovered.scheduled,false,
      'the lock must be released after a failed first request');
    await assert.rejects(
      fs.stat(path.join(temp,'Nexowire','update','.lifecycle.lock')),
      {code:'ENOENT'});
  }finally{
    await fs.rm(temp,{recursive:true,force:true});
  }
});

test('pending Windows cutover cannot be scheduled twice or lose its status', async () => {
  const {applyLatestLiveUpdate}=await import('../src/update/live-update.js');
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'nexowire-apply-duplicate-'));
  const statusFile=path.join(temp,'Nexowire','update','status.json');
  try {
    await fs.mkdir(path.dirname(statusFile),{recursive:true});
    for(const state of ['staging','cutover_scheduled'] as const){
      const durable=JSON.stringify({
        schemaVersion:1,state,currentVersion:'1.0.8',
        targetVersion:'1.0.9',buildId:'1.0.9-012345abcdef',
        targetRoot:path.join(temp,'versions','1.0.9-012345abcdef'),
        machineComponentsPending:true,agentStartupVerified:false,
        activeConnectionVerified:false,
        updatedAt:'2026-11-07T00:00:00.000Z',error:null,
      });
      await fs.writeFile(statusFile,durable);
      let requests=0;
      await assert.rejects(
        applyLatestLiveUpdate({localAppData:temp,
          fetchImpl:async()=>{
            requests++;
            return Response.json({tag_name:'v1.0.9'});
          }}),
        /already in progress/i, state+' must not start a second update',
      );
      assert.equal(requests,0,state+' must reject before release/staging requests');
      assert.equal(await fs.readFile(statusFile,'utf8'),durable,
        state+' must not rewrite an existing cutover operation');
    }
  }finally{
    await fs.rm(temp,{recursive:true,force:true});
  }
});

test('live updater compares stable release versions numerically', () => {
  assert.equal(compareReleaseVersions('1.0.3', '1.0.3'), 0);
  assert.equal(compareReleaseVersions('1.0.3', '1.0.4'), -1);
  assert.equal(compareReleaseVersions('1.10.0', '1.9.9'), 1);
  assert.throws(
    () => compareReleaseVersions('1.0.3-beta', '1.0.4'),
    /Unsupported Nexowire release version/,
  );
});

test('live updater requires exact Windows checksum records', () => {
  const a = 'a'.repeat(64);
  const b = 'b'.repeat(64);
  const parsed = parseWindowsChecksumFile(
    a + '  Nexowire-Windows-x64.zip\n' +
    b + '  Nexowire-Setup.cmd\n',
  );
  assert.equal(parsed.get('Nexowire-Windows-x64.zip'), a);
  assert.equal(parsed.get('Nexowire-Setup.cmd'), b);
  assert.throws(
    () => parseWindowsChecksumFile('not-a-checksum'),
    /Invalid Windows checksum line/,
  );
});

test('live updater accepts only version-bound Windows setup metadata', () => {
  assert.deepEqual(
    parseWindowsSetupMetadata(
      '@echo off\r\n' +
      'set "NX_VERSION=1.2.3"\r\n' +
      'set "NX_BUILD_ID=1.2.3-012345abcdef"\r\n',
    ),
    {
      version: '1.2.3',
      buildId: '1.2.3-012345abcdef',
    },
  );
  assert.throws(
    () => parseWindowsSetupMetadata(
      'set "NX_VERSION=1.2.3"\n' +
      'set "NX_BUILD_ID=other-build"\n',
    ),
    /build ID is invalid/,
  );
});

test('release checks preserve live update and rollback evidence, including in-flight cutover', async () => {
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'nexowire-check-no-clobber-'));
  const file=path.join(temp,'Nexowire','update','status.json');
  const latest={
    tag_name:'v9.9.9',
    html_url:'https://github.com/Naveax/Nexowire/releases/tag/v9.9.9',
    published_at:'2026-11-07T00:00:00Z',
  };
  const snapshot=(state:string)=>({
    schemaVersion:1,state,currentVersion:'1.0.7',targetVersion:'1.0.8',
    buildId:'1.0.8-012345abcdef',
    targetRoot:path.join(temp,'Nexowire','versions','1.0.8-012345abcdef'),
    machineComponentsPending:true,agentStartupVerified:true,
    activeConnectionVerified:false,updatedAt:'2026-11-07T00:00:00.000Z',
    error:state==='failed'?'ROLLBACK_TEST_FAILURE':null,
  });
  try {
    await fs.mkdir(path.dirname(file),{recursive:true});
    for(const state of ['checking','staging','cutover_scheduled','succeeded',
      'failed','rolled_back','rollback_failed']){
      const original=JSON.stringify(snapshot(state));
      await fs.writeFile(file,original);
      let fetched=0;
      const result=await checkLiveUpdate({localAppData:temp,
        fetchImpl:async()=>{fetched++;return Response.json(latest);}});
      assert.equal(fetched,1,'check still fetches release metadata for '+state);
      assert.equal(result.latestVersion,'9.9.9');
      assert.equal(result.updateAvailable,true);
      assert.equal(await fs.readFile(file,'utf8'),original,
        'read-only check must not erase '+state+' evidence');
    }
    // Simulate a cutover starting while GitHub is responding to a check.
    await fs.writeFile(file,JSON.stringify({...snapshot('idle'),
      targetVersion:null,buildId:null,targetRoot:null,
      machineComponentsPending:false,agentStartupVerified:false}));
    const during=JSON.stringify(snapshot('cutover_scheduled'));
    const inFlight=await checkLiveUpdate({localAppData:temp,
      fetchImpl:async()=>{
        await fs.writeFile(file,during);
        return Response.json(latest);
      }});
    assert.equal(inFlight.latestVersion,'9.9.9');
    assert.equal(await fs.readFile(file,'utf8'),during,
      'late fetch response must not replace active cutover');
    await fs.writeFile(file,JSON.stringify(snapshot('failed')));
    const failedEvidence=await fs.readFile(file,'utf8');
    await assert.rejects(checkLiveUpdate({localAppData:temp,
      fetchImpl:async()=>{throw new Error('OFFLINE_FIXTURE');}}),/OFFLINE_FIXTURE/);
    assert.equal(await fs.readFile(file,'utf8'),failedEvidence,
      'failed metadata fetch must preserve earlier failure evidence');
  }finally{
    await fs.rm(temp,{recursive:true,force:true});
  }
});

test('idle release check never writes the cutover status file',async()=>{
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'nexowire-idle-check-isolated-'));
  const status=path.join(temp,'Nexowire','update','status.json');
  try {
    await fs.mkdir(path.dirname(status),{recursive:true});
    const original=JSON.stringify({
      schemaVersion:1,state:'idle',currentVersion:'1.0.8',
      targetVersion:null,buildId:null,targetRoot:null,
      machineComponentsPending:false,agentStartupVerified:false,
      activeConnectionVerified:false,updatedAt:'2026-11-07T00:00:00.000Z',
      error:null,
    });
    await fs.writeFile(status,original);
    const result=await checkLiveUpdate({localAppData:temp,
      fetchImpl:async()=>Response.json({
        tag_name:'v9.9.9',
        html_url:'https://github.com/Naveax/Nexowire/releases/tag/v9.9.9',
        published_at:'2026-11-07T00:00:00Z',
      }),
    });
    assert.equal(result.latestVersion,'9.9.9');
    assert.equal(await fs.readFile(status,'utf8'),original,
      'release metadata check must never replace update status, even when idle');
    const displayed=await readLiveUpdateState({localAppData:temp});
    assert.equal(displayed.state,'idle');
    assert.equal(displayed.targetVersion,'9.9.9',
      'idle status continues to expose cached release metadata');
    const cache=path.join(temp,'Nexowire','update','latest-release.json');
    assert.equal(JSON.parse(await fs.readFile(cache,'utf8')).latestVersion,'9.9.9');
    await fs.writeFile(cache,'{broken-cache');
    const recovered=await readLiveUpdateState({localAppData:temp});
    assert.equal(recovered.targetVersion,null,
      'corrupt optional discovery cache must not invalidate durable idle status');
    assert.equal(await fs.readFile(status,'utf8'),original);
  }finally{
    await fs.rm(temp,{recursive:true,force:true});
  }
});

test('live update check persists official release state without applying it', async () => {
  const temp = await fs.mkdtemp(
    path.join(os.tmpdir(), 'nexowire-live-update-test-'),
  );
  try {
    const result = await checkLiveUpdate({
      localAppData: temp,
      fetchImpl: async (input) => {
        assert.equal(
          String(input),
          'https://api.github.com/repos/Naveax/Nexowire/releases/latest',
        );
        return Response.json({
          tag_name: 'v9.9.9',
          html_url:
            'https://github.com/Naveax/Nexowire/releases/tag/v9.9.9',
          published_at: '2026-10-07T00:00:00Z',
        });
      },
    });
    assert.equal(result.latestVersion, '9.9.9');
    assert.equal(result.updateAvailable, true);

    const state = await readLiveUpdateState({
      localAppData: temp,
    });
    assert.equal(state.state, 'idle');
    assert.equal(state.targetVersion, '9.9.9');
    assert.equal(state.error, null);
    await assert.rejects(
      fs.stat(path.join(temp, 'Nexowire', 'update', 'status.json')),
      { code: 'ENOENT' },
      'a metadata-only release check must not create durable cutover status',
    );
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test('live update status accepts UTF-8 BOM from Windows PowerShell without masking invalid JSON', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'nexowire-status-bom-'));
  const file = path.join(temp, 'Nexowire', 'update', 'status.json');
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const state = {
      schemaVersion: 1,
      state: 'succeeded',
      currentVersion: '1.0.6',
      targetVersion: '1.0.6',
      buildId: '1.0.6-7b27b5acdcfa',
      targetRoot: 'C:\\Users\\test\\AppData\\Local\\Nexowire\\versions\\1.0.6-7b27b5acdcfa',
      machineComponentsPending: true,
      updatedAt: '2026-10-25T15:00:00.000Z',
      error: null,
    };
    await fs.writeFile(file, '\uFEFF' + JSON.stringify(state), 'utf8');
    assert.deepEqual(await readLiveUpdateState({ localAppData: temp }),
      {...state, agentStartupVerified: false, activeConnectionVerified: false});
    await fs.writeFile(file, JSON.stringify({...state, activeConnectionVerified: true}));
    await assert.rejects(readLiveUpdateState({localAppData: temp}));
    await fs.writeFile(file, '\uFEFF' + '{not-json', 'utf8');
    await assert.rejects(() => readLiveUpdateState({ localAppData: temp }), SyntaxError);
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test('Windows live cutover is side-by-side, health checked and rollback capable', () => {
  const script = renderWindowsCutoverScript({
    targetVersion: '1.0.4',
    buildId: '1.0.4-012345abcdef',
    targetRoot:
      'C:\\Users\\test\\AppData\\Local\\Nexowire\\versions\\1.0.4-012345abcdef',
    localAppData: 'C:\\Users\\test\\AppData\\Local',
  });

  assert.match(script, /Nexowire Native Agent/);
  assert.match(script, /Nexowire Hub/);
  assert.match(script, /Updated Hub did not become healthy/);
  assert.match(script, /Updated Agent did not start from the new runtime/);
  assert.match(script, /Restore-Launchers/);
  assert.match(script, /rolled_back/);
  assert.match(script, /Nexowire Hub Boot/);
  assert.match(script, /Nexowire Privileged Broker/);
  assert.match(script, /machineComponentsPending/);
  assert.doesNotMatch(script, /Remove-Item.+versions.+Recurse/i);
});


test('Windows cutover does not restart a deliberately disabled per-user Hub task', () => {
  const script=renderWindowsCutoverScript({
    targetVersion:'1.0.7',
    buildId:'1.0.7-012345abcdef',
    targetRoot:'C:\\Users\\test\\AppData\\Local\\Nexowire\\versions\\1.0.7-012345abcdef',
    localAppData:'C:\\Users\\test\\AppData\\Local',
  });
  assert.match(script,/function Task-Enabled/);
  assert.match(script,/State -ne "Disabled"/);
  assert.match(script,/\$hadHub=\(Task-Enabled \$HubTask\) -and -not \$hubBootInstalled/);
  assert.doesNotMatch(script,/\$hadHub=\(Task-Exists \$HubTask\)/);
  assert.match(script,/if\(\$hadHub\)\{Start-ScheduledTask -TaskName \$HubTask/);
});

test('automatic update requires elevated Broker and skips absent/unreachable authority', async () => {
  const { executeAutomaticUpdate } = await import('../src/update/auto-update.js');
  const release = {
    currentVersion: '1.0.5',
    latestVersion: '1.0.6',
    updateAvailable: true,
    release: {
      version: '1.0.6',
      tag: 'v1.0.6',
      htmlUrl: 'https://github.com/Naveax/Nexowire/releases/tag/v1.0.6',
      publishedAt: '2026-10-08T00:00:00Z',
    },
  };
  let calls = 0;
  const absent = await executeAutomaticUpdate({
    check: async () => release,
    broker: async () => null,
    apply: async () => { calls++; return { scheduled: true }; },
  });
  assert.equal(absent.action, 'broker_unavailable');
  assert.equal(calls, 0);

  const offline = await executeAutomaticUpdate({
    check: async () => release,
    broker: async () => ({
      probe: async () => ({ reachable: false, elevated: false, version: '1.0.5' }),
    }) as never,
    apply: async () => { calls++; return { scheduled: true }; },
  });
  assert.equal(offline.action, 'broker_unavailable');
  assert.equal(calls, 0);

  const healthy = await executeAutomaticUpdate({
    check: async () => release,
    broker: async () => ({
      probe: async () => ({ reachable: true, elevated: true, version: '1.0.5' }),
    }) as never,
    apply: async () => { calls++; return { scheduled: true }; },
  });
  assert.equal(healthy.action, 'update_scheduled');
  assert.equal(calls, 1);
});

test('automatic update verifies elevated Broker even when Agent is current; no update writes', async () => {
  const { executeAutomaticUpdate } = await import('../src/update/auto-update.js');
  let probes=0;
  const result = await executeAutomaticUpdate({
    check: async () => ({
      currentVersion: '1.0.6',
      latestVersion: '1.0.6',
      updateAvailable: false,
      release: { version: '1.0.6', tag: 'v1.0.6', htmlUrl: '', publishedAt: null },
    }),
    broker: async () => ({
      probe: async () => { probes++; return {reachable:true,elevated:true,version:'1.0.6'}; },
    }) as never,
    apply: async () => { throw new Error('should not apply'); },
  });
  assert.equal(result.action, 'up_to_date');
  assert.equal(probes,1);
});

test('hourly updater reports obsolete and missing Broker versions without invoking privileged cutover', async () => {
  const { executeAutomaticUpdate } = await import('../src/update/auto-update.js');
  for (const version of ['1.0.4','1.0.5',null]) {
    for (const updateAvailable of [false,true]) {
      let calls=0;
      const result = await executeAutomaticUpdate({
        check: async () => ({
          currentVersion:'1.0.6',
          latestVersion:updateAvailable?'1.0.7':'1.0.6',
          updateAvailable,
          release:{version:updateAvailable?'1.0.7':'1.0.6',
            tag:updateAvailable?'v1.0.7':'v1.0.6',htmlUrl:'',publishedAt:null},
        }),
        broker: async () => ({probe:async () => ({reachable:true,elevated:true,version})}) as never,
        apply:async () => {calls++;return {scheduled:true};},
      });
      assert.equal(result.action,'broker_version_mismatch');
      assert.match(result.detail ?? '', /trusted Broker repair required/);
      assert.equal(calls,0);
    }
  }
});

test('hourly updater must not claim whole-device ready when Broker is unavailable', async () => {
  const { executeAutomaticUpdate } = await import('../src/update/auto-update.js');
  const result=await executeAutomaticUpdate({
    check:async () => ({currentVersion:'1.0.6',latestVersion:'1.0.6',updateAvailable:false,
      release:{version:'1.0.6',tag:'v1.0.6',htmlUrl:'',publishedAt:null}}),
    broker:async()=>null,
    apply:async()=>{throw new Error('no updates');},
  });
  assert.equal(result.action,'broker_unavailable');
});

test('hourly updater reclaims a dead-owner lock and still excludes live owners',async()=>{
  const {withAutomaticUpdateRunLock}=await import('../src/update/auto-update.js');
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nexowire-auto-update-lock-'));
  const lockDir=path.join(root,'.lifecycle.lock');
  try{
    await fs.mkdir(lockDir);
    await fs.writeFile(path.join(lockDir,'owner.json'),JSON.stringify({
      version:1,pid:2147483647,
      nonce:'00000000-0000-4000-8000-000000000001',startedAt:0,
    }));
    const old=new Date(Date.now()-60_000);
    await fs.utimes(lockDir,old,old);
    let calls=0;
    const recovered=await withAutomaticUpdateRunLock(root,async()=>++calls);
    assert.equal(recovered,1);
    assert.equal(calls,1);
    await assert.rejects(fs.stat(lockDir),{code:'ENOENT'});
    let entered!:()=>void;
    const active=new Promise<void>(resolve=>{entered=resolve});
    let exit!:()=>void;
    const hold=new Promise<void>(resolve=>{exit=resolve});
    const first=withAutomaticUpdateRunLock(root,async()=>{
      entered();
      await hold;
      return 'first';
    });
    await active;
    try{
      await assert.rejects(
        withAutomaticUpdateRunLock(root,async()=>{calls++;return 'second'}),
        /already running/i,
      );
      assert.equal(calls,1);
    }finally{
      exit();
    }
    assert.equal(await first,'first');
    assert.equal(await withAutomaticUpdateRunLock(root,async()=>++calls),2);
    await assert.rejects(fs.stat(lockDir),{code:'ENOENT'});
  }finally{
    await fs.rm(root,{recursive:true,force:true});
  }
});

test('hourly updater does not keep permanent wx tombstones after a crash',async()=>{
  const source=await fs.readFile(new URL('../src/update/auto-update.ts',import.meta.url),'utf8');
  const start=source.indexOf('async function runAutoUpdateOnce():');
  const end=source.indexOf('async function installAutoUpdateTask()',start);
  assert.ok(start>=0&&end>start);
  const run=source.slice(start,end);
  assert.doesNotMatch(run,/fs\.open\(lockFile,\s*'wx'/,
    'run.lock cannot permanently prevent hourly checks after crash');
  assert.match(run,/withAutomaticUpdateRunLock\(/);
});

test('hourly update never creates a replacement DPAPI Broker identity when missing', async () => {
  const {readFileSync} = await import('node:fs');
  const source=readFileSync(new URL('../src/update/auto-update.ts',import.meta.url),'utf8');
  const start=source.indexOf('async function runAutoUpdateOnce():');
  const end=source.indexOf('async function installAutoUpdateTask()',start);
  assert.ok(start>=0 && end>start);
  const hourly=source.slice(start,end);
  assert.match(hourly,/readExistingPrivilegedBrokerToken\(\)/);
  assert.doesNotMatch(hourly,/loadOrCreatePrivilegedBrokerToken\(/);
  assert.match(hourly,/code === 'ENOENT'\) return null/);
});

test('automatic Windows task is hourly, indefinite, user-limited and singleton', async () => {
  const {
    AUTO_UPDATE_INTERVAL_MINUTES,
    renderAutoUpdateTaskInstallScript,
    renderAutoUpdateLauncher,
  } = await import('../src/update/auto-update.js');
  assert.equal(AUTO_UPDATE_INTERVAL_MINUTES, 60);
  const script = renderAutoUpdateTaskInstallScript('C:\\Users\\test\\.nexowire\\auto-update\\launch.ps1');
  assert.match(script, /New-ScheduledTaskTrigger -AtLogOn/);
  assert.match(script, /New-ScheduledTaskTrigger -Once/);
  assert.match(script, /-RepetitionInterval \(New-TimeSpan -Minutes 60\)/);
  assert.match(script, /\$hour\.Repetition\.Duration=\$null/);
  assert.match(script, /-MultipleInstances IgnoreNew/);
  assert.match(script, /-RunLevel Limited/);
  assert.match(script, /\$expectedSid=\[Security\.Principal\.WindowsIdentity\]::GetCurrent\(\)\.User\.Value/);
  assert.match(script, /\$actualSid=/);
  assert.doesNotMatch(script, /\$task\.Principal\.UserId -ne \$user/);
  assert.match(script, /Start-ScheduledTask/);
  assert.doesNotMatch(script, /ServiceAccount|RunLevel Highest|RunLevel SYSTEM/i);
  const launcher = renderAutoUpdateLauncher('C:\\Runtime\\node.exe', 'C:\\Runtime\\cli.js');
  assert.match(launcher, /'update' 'auto' 'run'/);
  assert.doesNotMatch(launcher, /password|authorization|Bearer/i);
});

test('automatic strict Broker requirement is opt-in and preserves old manual behavior', async () => {
  const { executeAutomaticUpdate } = await import('../src/update/auto-update.js');
  // A rejected official machine update must propagate rather than marking a
  // partially-installed runtime as a successful automatic rollout.
  await assert.rejects(
    () => executeAutomaticUpdate({
      check: async () => ({
        currentVersion: '1.0.5', latestVersion: '1.0.6', updateAvailable: true,
        release: { version: '1.0.6', tag: 'v1.0.6', htmlUrl: '', publishedAt: null },
      }),
      broker: async () => ({
        probe: async () => ({ reachable: true, elevated: true, version: '1.0.5' }),
      }) as never,
      apply: async () => { throw new Error('MACHINE_UPDATE_FAILED'); },
    }),
    /MACHINE_UPDATE_FAILED/,
  );
});


test('Windows update patches only the versioned runtime root and also updates the hourly launcher', () => {
  const script = renderWindowsCutoverScript({
    targetVersion: '1.0.6',
    buildId: '1.0.6-012345abcdef',
    targetRoot:
      'C:\\Users\\test\\AppData\\Local\\Nexowire\\versions\\1.0.6-012345abcdef',
    localAppData: 'C:\\Users\\test\\AppData\\Local',
  });
  assert.match(script, /AutoLauncher/);
  assert.match(script, /Patch-Launcher \$AutoLauncher/);
  assert.match(script, /\[0-9\]\+\\\.\[0-9\]\+\\\.\[0-9\]\+-\[a-f0-9\]\{12\}/);
  assert.doesNotMatch(script, /versions\\\[\^''/);
});


test('reinstall cannot override the owners explicit disabled updater state', async () => {
  const { renderAutoUpdateTaskInstallScript } = await import('../src/update/auto-update.js');
  const script = renderAutoUpdateTaskInstallScript('C:\\Users\\test\\.nexowire\\auto-update\\launch.ps1');
  const disableCheck = script.indexOf("State -eq \"Disabled\"");
  const registration = script.indexOf('Register-ScheduledTask');
  assert.ok(disableCheck >= 0 && registration > disableCheck);
  assert.match(script, /ownerDisabled=\$true/);
  assert.match(script, /\$existing\.Settings\.Enabled -eq \$false/);
  assert.match(script, /exit 0/);
});


test('Windows updater stages on target volume when TEMP uses another drive', () => {
  const versions='C:\\Users\\navea\\AppData\\Local\\Nexowire\\versions';
  assert.equal(windowsUpdateStagingParent(versions),versions);
  assert.equal(windowsUpdateStagingParent(versions,'D:\\Temp'),versions);
  assert.equal(windowsUpdateStagingParent(versions,'C:\\Temp'),'C:\\Temp');
  assert.equal(windowsUpdateStagingParent(versions,'d:\\Temp'),versions);
});
