import test from 'node:test';
import {readFileSync} from 'node:fs';
import {executeCapability} from '../src/agent/executors.js';
import {PathPolicy} from '../src/agent/path-policy.js';
import assert from 'node:assert/strict';
import {
  assertPhysicalConsoleGrant,
  executeWindowsConsoleControlCapability,
  needsPhysicalConsoleApproval,
  physicalConsoleGrantStatus,
  requestPhysicalConsoleGrant,
  requiresPhysicalConsoleGrant,
  revokePhysicalConsoleGrant,
} from '../src/agent/windows-console-grant.js';
import {
  capabilitiesForPlatform,
  isReadOnlyCapability,
} from '../src/protocol/capabilities.js';

test('physical console mutations are default-denied while private input stays isolated', () => {
  revokePhysicalConsoleGrant();

  for (const capability of [
    'windows.window.focus',
    'windows.clipboard.write',
    'windows.clipboard.clear',
    'windows.keyboard.type',
    'windows.keyboard.hotkey',
    'windows.pointer.move',
    'windows.pointer.click',
    'windows.pointer.scroll',
    'windows.accessibility.invoke',
    'windows.accessibility.set_value',
    'windows.private_desktop.show',
    'windows.private_viewer.start',
  ]) {
    assert.equal(
      requiresPhysicalConsoleGrant(capability),
      true,
      capability,
    );
    assert.throws(
      () => assertPhysicalConsoleGrant(capability),
      (error: unknown) =>
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'PHYSICAL_CONSOLE_GRANT_REQUIRED',
      capability,
    );
  }

  for (const capability of [
    'windows.screenshot',
    'windows.clipboard.read',
    'windows.window.list',
    'windows.private_pointer.move',
    'windows.private_pointer.click',
    'windows.private_keyboard.type',
    'windows.private_keyboard.hotkey',
    'windows.private_viewer.status',
    'windows.private_viewer.stop',
    'windows.console_control.status',
    'windows.console_control.request',
    'windows.console_control.revoke',
  ]) {
    assert.equal(
      requiresPhysicalConsoleGrant(capability),
      false,
      capability,
    );
  }

  assert.deepEqual(
    physicalConsoleGrantStatus(),
    {
      active: false,
      grantId: null,
      grantedAt: null,
      expiresAt: null,
      remainingMs: 0,
      durationMinutes: null,
    },
  );
});

test('physical input and foreground actions require LOCAL grant in SAFE and Full Access', () => {
  const physical = [
    'windows.pointer.click',
    'windows.keyboard.type',
    'windows.window.focus',
  ];
  for (const capability of physical) {
    assert.equal(
      needsPhysicalConsoleApproval(capability, 'safe'),
      true,
      capability + ':safe',
    );
    assert.equal(
      needsPhysicalConsoleApproval(capability, 'full'),
      true,
      capability + ':full',
    );
  }

  assert.equal(
    needsPhysicalConsoleApproval('windows.screenshot', 'safe'),
    false,
  );
  assert.equal(
    needsPhysicalConsoleApproval('windows.screenshot', 'full'),
    false,
  );
});

test('Full Access cannot switch visible desktop, focus windows or move physical mouse without local consent',async()=>{
  revokePhysicalConsoleGrant();
  const policy=new PathPolicy(['*']);
  for(const capability of [
    'windows.private_desktop.show','windows.window.focus',
    'windows.pointer.move','windows.pointer.click','windows.keyboard.type',
    'windows.private_viewer.start',
  ] as const){
    await assert.rejects(
      executeCapability(capability,{},policy,{accessMode:'full'}),
      (error:unknown)=>typeof error==='object'&&error!==null&&
        'code' in error&&error.code==='PHYSICAL_CONSOLE_GRANT_REQUIRED',
      capability,
    );
  }
  assert.equal(physicalConsoleGrantStatus().active,false);
});

test('Full console-control request must use local prompt rather than synthetic auto-approval',()=>{
  const source=readFileSync(
    new URL('../src/agent/windows-console-grant.ts',import.meta.url),'utf8',
  );
  const dispatcher=source.slice(source.indexOf('export async function executeWindowsConsoleControlCapability('));
  // Connection lifetime is now passed to cancel pending local approval.
  assert.match(dispatcher,/requestPhysicalConsoleGrant\(input, \{signal\}\)/);
  assert.doesNotMatch(dispatcher,/authorization: 'owner-full-access'|approvalRequired: false/);
});

test('console-control status is read-only and Windows advertises grant capabilities', () => {
  assert.equal(
    isReadOnlyCapability(
      'windows.private_viewer.status',
    ),
    true,
  );
  assert.equal(
    isReadOnlyCapability(
      'windows.private_viewer.start',
    ),
    false,
  );
  assert.equal(
    isReadOnlyCapability(
      'windows.private_viewer.stop',
    ),
    false,
  );
  assert.equal(
    isReadOnlyCapability(
      'windows.console_control.status',
    ),
    true,
  );
  assert.equal(
    isReadOnlyCapability(
      'windows.console_control.request',
    ),
    false,
  );
  assert.equal(
    isReadOnlyCapability(
      'windows.console_control.revoke',
    ),
    false,
  );

  const capabilities = new Set(
    capabilitiesForPlatform('win32'),
  );
  for (const capability of [
    'windows.private_desktop.show',
    'windows.private_viewer.status',
    'windows.private_viewer.start',
    'windows.private_viewer.stop',
    'windows.console_control.status',
    'windows.console_control.request',
    'windows.console_control.revoke',
  ]) {
    assert.equal(
      capabilities.has(capability),
      true,
      capability,
    );
  }
});

test(
  'local approval creates a bounded grant that expires and can be denied',
  { skip: process.platform !== 'win32' },
  async () => {
    revokePhysicalConsoleGrant();

    const base = new Date(
      '2030-01-01T00:00:00.000Z',
    );
    const approved =
      await requestPhysicalConsoleGrant(
        {
          duration_minutes: 1,
          reason: 'test approval',
        },
        {
          now: () => base,
          decisionProvider: async (input) => {
            assert.equal(
              input.durationMinutes,
              1,
            );
            assert.equal(
              input.reason,
              'test approval',
            );
            return true;
          },
          timeoutMs: 1_000,
        },
      );

    assert.equal(approved.approved, true);
    assert.equal(approved.status.active, true);
    assert.equal(
      approved.status.durationMinutes,
      1,
    );
    assert.ok(approved.status.remainingMs > 59_000 &&
      approved.status.remainingMs <= 60_000);
    assert.doesNotThrow(() =>
      assertPhysicalConsoleGrant(
        'windows.pointer.click',
        new Date(
          base.getTime() + 30_000,
        ),
      ),
    );

    assert.throws(
      () =>
        assertPhysicalConsoleGrant(
          'windows.pointer.click',
          new Date(
            base.getTime() + 60_001,
          ),
        ),
      (error: unknown) =>
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code ===
          'PHYSICAL_CONSOLE_GRANT_REQUIRED',
    );

    const deniedAt = new Date(
      base.getTime() + 120_000,
    );
    const denied =
      await requestPhysicalConsoleGrant(
        {
          duration_minutes: 5,
          reason: 'test denial',
        },
        {
          now: () => deniedAt,
          decisionProvider: async () => false,
          timeoutMs: 1_000,
        },
      );
    assert.equal(denied.approved, false);
    assert.equal(denied.status.active, false);

    const revoked =
      revokePhysicalConsoleGrant();
    assert.equal(revoked.status.active, false);
  },
);

test('STOP, disconnect and timeout cannot be undone by a delayed local approval',
  {skip:process.platform!=='win32'},async()=>{
    let tick=Date.parse('2031-01-01T00:00:00Z');
    const now=()=>new Date(tick);
    for(const reason of ['stop','disconnect','timeout'] as const){
      revokePhysicalConsoleGrant(); tick+=120_000;
      let approve!:(value:boolean)=>void;
      const decision=new Promise<boolean>(resolve=>{approve=resolve;});
      const connection=new AbortController();
      const pending=requestPhysicalConsoleGrant({duration_minutes:5},{now,
        timeoutMs:reason==='timeout'?10:1000,signal:connection.signal,
        decisionProvider:async()=>decision});
      if(reason==='stop')revokePhysicalConsoleGrant();
      if(reason==='disconnect')connection.abort();
      if(reason!=='timeout')approve(true);
      const result=await pending;
      approve(true);
      assert.equal(result.approved,false,reason);
      assert.equal(result.status.active,false,reason);
      await new Promise<void>(resolve=>setImmediate(resolve));
      assert.equal(physicalConsoleGrantStatus(now()).active,false,reason);
    }
  });

test('timed approval rejects remote approval flags, CORE fallback and clock rollback',
  {skip:process.platform!=='win32'},async()=>{
    revokePhysicalConsoleGrant();
    const base=Date.parse('2032-01-01T00:00:00Z');
    let tick=base;
    let prompts=0;
    const options={now:()=>new Date(tick),decisionProvider:async()=>{++prompts;return true;}};
    await assert.rejects(requestPhysicalConsoleGrant({mode:'core'},options),
      (error:unknown)=>typeof error==='object'&&error!==null&&'code' in error&&
        error.code==='CORE_CONSOLE_ENROLLMENT_UNAVAILABLE');
    await assert.rejects(requestPhysicalConsoleGrant({approved:true},options));
    assert.equal(prompts,0);
    const granted=await requestPhysicalConsoleGrant({duration_minutes:1},options);
    assert.equal(granted.status.active,true);
    tick=base-1;
    assert.equal(physicalConsoleGrantStatus(new Date(tick)).active,false);
    tick=base+120_000;
    await assert.rejects(requestPhysicalConsoleGrant({duration_minutes:1},{...options,
      decisionProvider:async()=>{tick-=1;return true;}}));
    assert.equal(physicalConsoleGrantStatus(new Date(tick)).active,false);
  });
