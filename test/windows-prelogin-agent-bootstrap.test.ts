import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {
  getWindowsPreloginAgentMode,
  filterWindowsPreloginCapabilities,
  preloginBootstrapAllowsCapability,
  assertWindowsPreloginStartupConfiguration,
  WINDOWS_PRELOGIN_AGENT_PATHS,
} from '../src/agent/windows-prelogin-bootstrap.js';

test('normal interactive Agent mode is unchanged by default',()=>{
  assert.equal(getWindowsPreloginAgentMode({},'win32'),false);
  assert.equal(getWindowsPreloginAgentMode({},'linux'),false);
  assert.equal(filterWindowsPreloginCapabilities(['shell.exec','machine.health'],false).length,2);
});
test('bootstrap is Windows-only and requires an exact opt-in value',()=>{
  assert.equal(getWindowsPreloginAgentMode({NEXOWIRE_WINDOWS_PRELOGIN_AGENT:'1'},'win32'),true);
  for(const value of ['true','0','yes',' 1 ']){
    assert.throws(()=>getWindowsPreloginAgentMode({NEXOWIRE_WINDOWS_PRELOGIN_AGENT:value},'win32'),/PRELOGIN/);
  }
  assert.throws(()=>getWindowsPreloginAgentMode({NEXOWIRE_WINDOWS_PRELOGIN_AGENT:'1'},'linux'),/PRELOGIN/);
});
test('SYSTEM bootstrap requires a complete canonical machine-only state profile',()=>{
  const env={...WINDOWS_PRELOGIN_AGENT_PATHS,
    NEXOWIRE_WINDOWS_PRELOGIN_AGENT:'1',
    NEXOWIRE_HUB_WS_URL:'ws://127.0.0.1:43110/agent'};
  assert.equal(assertWindowsPreloginStartupConfiguration(env,'win32').root,
    'C:\\ProgramData\\Nexowire\\system-agent');
  for(const key of Object.keys(WINDOWS_PRELOGIN_AGENT_PATHS)){
    const changed={...env,[key]:undefined};
    assert.throws(()=>assertWindowsPreloginStartupConfiguration(changed,'win32'),/PRELOGIN/);
  }
});

test('SYSTEM bootstrap rejects owner secrets, external Hub and CORE/Broker profiles',()=>{
  const env={...WINDOWS_PRELOGIN_AGENT_PATHS,
    NEXOWIRE_WINDOWS_PRELOGIN_AGENT:'1',
    NEXOWIRE_HUB_WS_URL:'ws://127.0.0.1:43110/agent'};
  for(const [key,value] of Object.entries({
    NEXOWIRE_HUB_WS_URL:'wss://example.com/agent',
    NEXOWIRE_HUB_WS_URLS:'ws://127.0.0.1:43110/agent',
    NEXOWIRE_AGENT_TOKEN:'secret',
    NEXOWIRE_AGENT_TOKEN_FILE:'C:\\Users\\test\\secret',
    NEXOWIRE_AGENT_TOKEN_PLATFORM_NAME:'my-user-keychain',
    NEXOWIRE_CORE_AUTHORITY_URL:'https://example.com/core',
    NEXOWIRE_CORE_APPROVAL_MODE:'local-owner',
    NEXOWIRE_PRIVILEGE_MODE:'direct',
    NEXOWIRE_ALLOWED_ROOTS:'C:\\Users',
    NEXOWIRE_PRIVILEGED_BROKER_SECRET_FILE:'C:\\Users\\test\\broker-token',
  })){
    assert.throws(()=>assertWindowsPreloginStartupConfiguration({...env,[key]:value},'win32'),
      /PRELOGIN/,key);
  }
  assert.throws(()=>assertWindowsPreloginStartupConfiguration({
    ...env,
    NEXOWIRE_AGENT_IDENTITY_FILE:'C:\\ProgramData\\Nexowire\\system-agent\\..\\untrusted.json',
  },'win32'),/PRELOGIN/);
});

test('SYSTEM bootstrap trust preflight happens before identity file access',()=>{
  const source=readFileSync(new URL('../src/agent/native-agent.ts',import.meta.url),'utf8');
  const runner=source.slice(source.indexOf('export async function runNativeAgent('));
  const config=runner.indexOf('assertWindowsPreloginStartupConfiguration(');
  const trust=runner.indexOf('assertWindowsPrivilegedRuntimeTrusted(');
  const identity=runner.indexOf('loadOrCreateAgentIdentity(');
  assert.ok(config>=0&&trust>config&&identity>trust,
    'the privileged runtime must validate isolated token, paths and code before reading/writing identity');
});

test('prelogin bootstrap advertises only bounded machine status capabilities',()=>{
  const list=filterWindowsPreloginCapabilities([
    'shell.exec','files.read','machine.health','windows.tasks','machine.health',
    'windows.registry.read','windows.console_control.status','process.start'
  ],true);
  assert.deepEqual(list,['machine.health','windows.tasks']);
});
test('all mutations and sensitive reads are denied, even if Hub sends them',()=>{
  for(const cap of [
    'shell.exec','process.start','files.read','files.write',
    'windows.environment.set','windows.registry.read',
    'windows.console_control.status','windows.screenshot',
    'browser.session.start','task.graph.run','nexowire.update.apply'
  ]) assert.equal(preloginBootstrapAllowsCapability(cap),false,cap);
  assert.equal(preloginBootstrapAllowsCapability('machine.health'),true);
  assert.equal(preloginBootstrapAllowsCapability('windows.tasks'),true);
});
test('native dispatcher enforces prelogin policy before CAS/journal or executeCapability',()=>{
  const source=readFileSync(new URL('../src/agent/native-agent.ts',import.meta.url),'utf8');
  const start=source.indexOf("socket.on('message', async (raw) => {");
  const end=source.indexOf("socket.once('close',",start);
  assert.ok(start>=0&&end>start);
  const handler=source.slice(start,end);
  const guard=handler.indexOf('preloginBootstrapAllowsCapability(');
  const cache=handler.indexOf('requestCache.run(');
  const execute=handler.indexOf('executeCapability(');
  assert.ok(guard>=0&&guard<cache&&cache<execute,'prelogin policy must reject before any side effects');
  assert.match(handler,/AGENT_PRELOGIN_CAPABILITY_UNAVAILABLE/);
});
test('CI executes this mode on actual hosted Windows Node 22 and 24',()=>{
  const yaml=readFileSync(new URL('../.github/workflows/ci.yml',import.meta.url),'utf8');
  const win=yaml.slice(yaml.indexOf('  connection-v2-negative-windows:'),yaml.indexOf('  connection-v2-native-git-dag:'));
  assert.match(win,/node-version: \[22, 24\]/);
  assert.match(win,/test\/windows-prelogin-agent-bootstrap\.test\.ts/);
  assert.match(win,/WINDOWS_PRELOGIN_BOOTSTRAP_CAPABILITY_RED/);
});

test('Agent Hello capability set is filtered before advertising to Hub',()=>{
  const source=readFileSync(new URL('../src/agent/native-agent.ts',import.meta.url),'utf8');
  assert.match(source,/filterWindowsPreloginCapabilities\(/);
  const start=source.indexOf('const advertisedCapabilities');
  const hello=source.indexOf('capabilities: advertisedCapabilities');
  assert.ok(start>=0&&hello>start);
});
