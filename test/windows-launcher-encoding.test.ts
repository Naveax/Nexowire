import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp, mkdir, readFile, writeFile, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const payloadRoot = process.env.NEXOWIRE_JOURNAL_TEST_APP_ROOT;
const moduleUrl = (file: string) => payloadRoot
  ? pathToFileURL(path.join(payloadRoot, 'dist/src', file)).href
  : new URL('../src/' + file, import.meta.url).href;
const {buildNativeAgentLauncher} = await import(moduleUrl('agent/native-agent-lifecycle.js'));
const {buildHubLauncher} = await import(moduleUrl('hub/hub-lifecycle.js'));
const {renderAutoUpdateLauncher} = await import(moduleUrl('update/auto-update.js'));
const {isolatedLiveUpdateEnvironment} = await import(moduleUrl('update/live-update.js'));
const run = promisify(execFile);

function launchers(cliEntrypoint: string, stateDir: string) {
  const options = {execPath: process.execPath, execArgv: [], cliEntrypoint};
  return [
    {name: 'agent', args: ['agent', 'run'], key: 'NEXOWIRE_DEVICE_NAME', value: "Çığ Ölçek O'Brien",
      script: buildNativeAgentLauncher({...options, platform: 'win32',
        env: {NEXOWIRE_DEVICE_NAME: "Çığ Ölçek O'Brien"}})},
    {name: 'hub', args: ['http'], key: 'NEXOWIRE_STATE_DIR', value: stateDir,
      script: buildHubLauncher({...options, env: {NEXOWIRE_STATE_DIR: stateDir}})},
    {name: 'auto-update', args: ['update', 'auto', 'run'],
      script: renderAutoUpdateLauncher(process.execPath, cliEntrypoint)},
  ];
}

test('persisted Windows Agent, Hub and hourly updater scripts identify UTF-8 to PowerShell 5.1', () => {
  for (const item of launchers("C:\\Users\\Çığ O'Brien\\cli.js", 'C:\\Durum\\Çığ')) {
    assert.equal(Buffer.from(item.script).subarray(0, 3).toString('hex'), 'efbbbf', item.name);
  }
  // A BOM would break Unix's shebang. Only Windows scripts receive it.
  assert.ok(buildNativeAgentLauncher({platform: 'linux', env: {}, execArgv: [],
    execPath: '/usr/bin/node', cliEntrypoint: '/opt/cli.js'}).startsWith('#!/bin/sh\n'));
});

test('Windows PowerShell 5.1 runs generated launchers through Unicode and quoted paths',
  {skip: process.platform !== 'win32', timeout: 60_000}, async t => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'nw-launcher-unicode-'));
    t.after(() => rm(root, {recursive: true, force: true}));
    const home = path.join(root, "Çığ Ölçek O'Brien");
    await mkdir(home, {recursive: true});
    const cli = path.join(home, 'capture.mjs');
    const observed = path.join(home, 'observed.json');
    await writeFile(cli, "import {writeFileSync} from 'node:fs';\n" +
      "writeFileSync(new URL('./observed.json', import.meta.url), JSON.stringify({args:process.argv.slice(2)," +
      'NEXOWIRE_DEVICE_NAME:process.env.NEXOWIRE_DEVICE_NAME,NEXOWIRE_STATE_DIR:process.env.NEXOWIRE_STATE_DIR}));\n');
    for (const item of launchers(cli, path.join(home, 'durum'))) {
      await t.test(item.name, async () => {
        const file = path.join(home, item.name + '.ps1');
        await writeFile(file, item.script, 'utf8');
        await run('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
          ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file],
          {env: isolatedLiveUpdateEnvironment({USERPROFILE: home,
            LOCALAPPDATA: path.join(home, 'AppData', 'Local')}),
          cwd: 'C:\\Windows\\System32', timeout: 15_000, maxBuffer: 32_768, windowsHide: true});
        const result = JSON.parse(await readFile(observed, 'utf8'));
        assert.deepEqual(result.args, item.args);
        if (item.key) assert.equal(result[item.key], item.value);
        await rm(observed);
      });
    }
    t.diagnostic('Generated launchers execute a disposable capture program only; no live Agent, Hub, updater or task.');
  });
