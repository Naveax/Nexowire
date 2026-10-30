import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp, mkdir, readFile, writeFile, rm, copyFile} from 'node:fs/promises';
import {createHash, randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {pathToFileURL} from 'node:url';
import os from 'node:os';
import path from 'node:path';

const payloadRoot = process.env.NEXOWIRE_JOURNAL_TEST_APP_ROOT;
const {renderWindowsCutoverScript, writeWindowsCutoverScript, readLiveUpdateState, isolatedLiveUpdateEnvironment} = await import(
  payloadRoot ? pathToFileURL(path.join(payloadRoot, 'dist/src/update/live-update.js')).href
    : new URL('../src/update/live-update.js', import.meta.url).href);
const {AgentOperationJournal} = await import(payloadRoot
  ? pathToFileURL(path.join(payloadRoot, 'dist/src/agent/operation-journal.js')).href
  : new URL('../src/agent/operation-journal.js', import.meta.url).href);
const win = process.platform === 'win32';
const ps = (text: string) => "'" + text.replaceAll("'", "''") + "'";
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

test('user updater keeps profile references while dropping executable, module, Node and credential hooks', () => {
  const env = isolatedLiveUpdateEnvironment({USERPROFILE: 'C:\\Users\\fixture',
    LOCALAPPDATA: 'C:\\Users\\fixture\\AppData\\Local', PATH: 'C:\\malicious',
    PSModulePath: 'C:\\malicious', NODE_OPTIONS: '--require malicious',
    NODE_PATH: 'C:\\malicious', NEXOWIRE_AGENT_TOKEN: 'secret-canary'});
  assert.equal(env.USERPROFILE, 'C:\\Users\\fixture');
  assert.equal(env.LOCALAPPDATA, 'C:\\Users\\fixture\\AppData\\Local');
  assert.equal(env.PATH, 'C:\\Windows\\System32;C:\\Windows');
  assert.equal(env.PSModulePath, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules');
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.NODE_PATH, undefined);
  assert.equal(env.NEXOWIRE_AGENT_TOKEN, undefined);
});

test('user updater bounds the readiness wait instead of accepting an unbounded timeout', () => {
  for (const agentStartupTimeoutSeconds of [0, -1, 1.5, 301, Infinity]) {
    assert.throws(() => renderWindowsCutoverScript({targetVersion: '1.0.8',
      buildId: '1.0.8-bbbbbbbbbbbb', targetRoot: 'C:\\fixture',
      localAppData: 'C:\\fixture', agentStartupTimeoutSeconds}), /Invalid Agent startup timeout/);
  }
});

test('persisted cutover helper is Unicode-readable by Windows PowerShell 5.1', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nw-update-encoding-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const homeDir = path.join(root, "Çığ Ölçek O'Brien");
  const localAppData = path.join(homeDir, 'AppData', 'Local');
  const input = {targetVersion: '1.0.8', currentVersion: '1.0.7',
    buildId: '1.0.8-bbbbbbbbbbbb', localAppData, homeDir,
    targetRoot: path.join(localAppData, 'Nexowire', 'versions', '1.0.8-bbbbbbbbbbbb')};
  const file = path.join(root, 'apply.ps1');
  await writeWindowsCutoverScript(file, input);
  const bytes = await readFile(file);
  // Without this signature, the pinned 5.1 interpreter decodes non-ASCII
  // script literals using the machine's ANSI code page, not UTF-8.
  assert.equal(bytes.subarray(0, 3).toString('hex'), 'efbbbf');
  assert.equal(bytes.subarray(3).toString('utf8'), renderWindowsCutoverScript(input));
  assert.ok(bytes.toString('utf8').includes("Çığ Ölçek O''Brien"));
});

test('Windows cutover script rejects false readiness and preserves journal, identity and credential bytes',
  {skip: !win, timeout: 240_000}, async t => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'nw-update-startup-fixture-'));
    let running: Promise<void> | undefined;
    t.after(async () => {
      // Cancellation must terminate and reap the fixture process before deleting its files.
      await running?.catch(() => {});
      await rm(root, {recursive: true, force: true, maxRetries: 10, retryDelay: 100});
    });
    const seed = path.join(root, 'seed.sqlite');
    const schema = new AgentOperationJournal(seed);
    await schema.initialize();
    schema.close();
    const db = new DatabaseSync(seed);
    let journalBytes: Buffer[];
    const unknownId = randomUUID(), fingerprint = 'a'.repeat(64);
    try {
      db.exec('PRAGMA synchronous=FULL; PRAGMA wal_autocheckpoint=0; BEGIN');
      const insert = db.prepare('INSERT INTO agent_operation_journal ' +
        '(request_id,fingerprint,capability,status,created_at,updated_at,has_execution)' +
        ' VALUES(?,?,?,?,?,?,?)');
      for (let i = 0; i < 1306; i++) insert.run(randomUUID(), fingerprint,
        'shell.exec', 'succeeded', '2026-10-30T00:00:00.000Z', '2026-10-30T00:00:00.000Z', 0);
      db.exec('COMMIT');
      assert.equal(db.prepare('PRAGMA wal_checkpoint(RESTART)').get()!.busy, 0);
      insert.run(unknownId, fingerprint, 'shell.exec', 'unknown',
        '2026-10-30T00:00:00.000Z', '2026-10-30T00:00:00.000Z', 0);
      assert.equal(db.prepare('SELECT count(*) AS n FROM agent_operation_journal').get()!.n, 1307);
      journalBytes = await Promise.all(['', '-wal', '-shm'].map(suffix => readFile(seed + suffix)));
    } finally { db.close(); }

    const scenarios = [
      {name: 'fresh', result: 'succeeded', code: 0},
      {name: 'custom-journal', result: 'succeeded', code: 0},
      {name: 'unicode-profile', result: 'succeeded', code: 0},
      {name: 'unicode-custom-journal', result: 'succeeded', code: 0},
      {name: 'missing-marker', result: 'rolled_back', code: 1},
      {name: 'old-nonce', result: 'rolled_back', code: 1},
      {name: 'wrong-pid', result: 'rolled_back', code: 1},
      {name: 'wrong-version', result: 'rolled_back', code: 1},
      {name: 'wal-rejected', result: 'rolled_back', code: 1},
      {name: 'wrong-executable', result: 'rolled_back', code: 1},
      {name: 'duplicate-candidate', result: 'rolled_back', code: 1},
      {name: 'process-disappears', result: 'rolled_back', code: 1},
      {name: 'claimed-connected', result: 'rolled_back', code: 1},
      {name: 'claimed-core', result: 'rolled_back', code: 1},
      {name: 'oversized-marker', result: 'rolled_back', code: 1},
      {name: 'malformed-marker', result: 'rolled_back', code: 1},
      {name: 'restore-corrupted', result: 'rollback_failed', code: 2},
      {name: 'backup-changed', result: 'rollback_failed', code: 2},
      {name: 'stop-denied', result: 'rollback_failed', code: 2},
      {name: 'rollback-start-fails', result: 'rollback_failed', code: 2},
      {name: 'disabled-agent', result: 'failed', code: 1},
    ];
    const cases = [];
    for (const scenario of scenarios) {
      t.signal.throwIfAborted();
      const unicode = scenario.name.startsWith('unicode-');
      const customJournal = scenario.name.endsWith('custom-journal');
      const homeDir = path.join(root, scenario.name, ...(unicode ? ["Çığ Ölçek O'Brien"] : []));
      const appData = path.join(homeDir, 'AppData', 'Local');
      const profile = path.join(homeDir, '.nexowire');
      const native = path.join(profile, 'native-agent');
      const update = path.join(appData, 'Nexowire', 'update');
      await mkdir(native, {recursive: true});
      await mkdir(update, {recursive: true});
      const journal = customJournal
        ? path.join(homeDir, "O'Brien Çığ", 'operations.sqlite') : path.join(profile, 'agent-operations.sqlite');
      await mkdir(path.dirname(journal), {recursive: true});
      const protectedFiles = ['', '-wal', '-shm'].map(suffix => journal + suffix);
      for (let i = 0; i < 3; i++) await writeFile(protectedFiles[i]!, journalBytes[i]!);
      const identity = path.join(profile, 'agent.json');
      const credential = path.join(profile, 'agent-token.dpapi.json');
      await writeFile(identity, JSON.stringify({id: randomUUID()}));
      // A byte-preservation canary, never a valid DPAPI credential or provider.
      await writeFile(credential, 'DISPOSABLE_CIPHERTEXT_CANARY');
      protectedFiles.push(identity, credential);
      const before = await Promise.all(protectedFiles.map(async file => hash(await readFile(file))));
      const oldRoot = path.join(appData, 'Nexowire', 'versions', '1.0.7-aaaaaaaaaaaa');
      const newRoot = path.join(appData, 'Nexowire', 'versions', '1.0.8-bbbbbbbbbbbb');
      const launcher = path.join(native, 'launch.ps1');
      const original = ["$ErrorActionPreference='Stop'",
        ...(customJournal ? ["$env:NEXOWIRE_UPDATE_STARTUP_NONCE='11111111-1111-4111-8111-111111111111'"] : []),
        ...(customJournal ? ['$env:NEXOWIRE_AGENT_OPERATION_JOURNAL_FILE=' + ps(journal)] : []),
        '$env:NEXOWIRE_AGENT_TOKEN_DPAPI_FILE=' + ps(credential),
        '& ' + ps(path.join(oldRoot, 'runtime', 'node.exe')) + ' ' +
          ps(path.join(oldRoot, 'app', 'dist', 'src', 'cli.js')) + " 'agent' 'run'",
      ].join('\r\n') + '\r\n';
      await writeFile(launcher, original);
      const launcherBackup = path.join(homeDir, 'original-launcher.ps1');
      await copyFile(launcher, launcherBackup);
      const wrapper = path.join(homeDir, 'isolated-cutover.ps1');
      const helper = path.join(update, 'apply.ps1');
      // Exercise the production writer and a separate -File-equivalent script
      // invocation. Never hide a missing BOM by embedding the helper inline.
      await writeWindowsCutoverScript(helper, {targetVersion: '1.0.8', currentVersion: '1.0.7',
        buildId: '1.0.8-bbbbbbbbbbbb', targetRoot: newRoot, localAppData: appData,
        homeDir, agentStartupTimeoutSeconds: 1});
      const program = [
        "$ErrorActionPreference='Stop'",
        '$scenario=' + ps(scenario.name),
        '$fixtureActions=' + ps(path.join(homeDir, 'fixture-actions.txt')),
        '$script:cimReads=0',
        '[Console]::WriteLine("[fixture] script entered: "+$scenario)',
        // Every task/process command is shadowed. Never query or edit host tasks.
        'function Get-ScheduledTask {[CmdletBinding()]param([string]$TaskName)',
        "  if($TaskName -eq 'Nexowire Native Agent'){return [pscustomobject]@{State=$(if($scenario -eq 'disabled-agent'){'Disabled'}else{'Ready'})}}",
        "  if($TaskName -in @('Nexowire Hub','Nexowire Hub Boot','Nexowire Privileged Broker')){return $null}",
        "  throw 'HOST_TASK_LOOKUP_DENIED'",
        '}',
        'function Stop-ScheduledTask {[CmdletBinding()]param([string]$TaskName)',
        "  if($TaskName -ne 'Nexowire Native Agent'){throw 'HOST_TASK_STOP_DENIED'}",
        "  Add-Content -LiteralPath $fixtureActions -Value 'stop'",
        "  if($scenario -eq 'stop-denied'){throw 'SYNTHETIC_STOP_DENIED'}",
        '}',
        'function Start-ScheduledTask {[CmdletBinding()]param([string]$TaskName)',
        "  if($TaskName -ne 'Nexowire Native Agent'){throw 'HOST_TASK_START_DENIED'}",
        '  [Console]::WriteLine("[fixture] start stub: "+$scenario)',
        "  Add-Content -LiteralPath $fixtureActions -Value 'start'",
        '  $text=Get-Content -LiteralPath $AgentLauncher -Raw',
        '  $parseTokens=$null; $parseErrors=$null',
        '  [void][System.Management.Automation.Language.Parser]::ParseInput($text,[ref]$parseTokens,[ref]$parseErrors)',
        "  if($parseErrors.Count -ne 0){throw 'PATCHED_LAUNCHER_SYNTAX_INVALID'}",
        "  if(-not $text.Contains($NewRoot.Replace(\"'\",\"''\"))){if($scenario -eq 'rollback-start-fails'){throw 'SYNTHETIC_OLD_AGENT_START_FAILED'}; return}",
        "  if($scenario -eq 'backup-changed'){Get-ChildItem -LiteralPath (Split-Path -Parent $AgentLauncher) -Filter 'launch.ps1.update-rollback.*' | ForEach-Object {[IO.File]::WriteAllText($_.FullName,'SYNTHETIC_BACKUP_CORRUPTION')}; return}",
        "  if($scenario -in @('missing-marker','restore-corrupted','rollback-start-fails')){return}",
        '  $value=[ordered]@{schemaVersion=1;version=$TargetVersion;recordedAt=[DateTime]::UtcNow.ToString("o");processId=4242;startupNonce=$StartupNonce;phase="local-state-ready";failureCode=$null;consecutiveFailures=0;restartLoopDetected=$false;automaticJournalRepair=$false;activeConnectionVerified=$false;coreAuthorityVerified=$false}',
        "  if($scenario -eq 'old-nonce'){$value.startupNonce='11111111-1111-4111-8111-111111111111'}",
        "  if($scenario -eq 'wrong-pid'){$value.processId=4243}",
        "  if($scenario -eq 'wrong-version'){$value.version='1.0.7'}",
        "  if($scenario -eq 'wal-rejected'){$value.phase='initialization-failed';$value.failureCode='AGENT_JOURNAL_WAL_CORRUPT';$value.consecutiveFailures=1}",
        "  if($scenario -eq 'claimed-connected'){$value.activeConnectionVerified=$true}",
        "  if($scenario -eq 'claimed-core'){$value.coreAuthorityVerified=$true}",
        '  [void][IO.Directory]::CreateDirectory((Split-Path -Parent $AgentStartupDiagnostic))',
        '  [IO.File]::WriteAllText($AgentStartupDiagnostic,($value|ConvertTo-Json -Compress))',
        "  if($scenario -eq 'oversized-marker'){[IO.File]::AppendAllText($AgentStartupDiagnostic,('x'*4097))}",
        "  if($scenario -eq 'malformed-marker'){[IO.File]::WriteAllText($AgentStartupDiagnostic,'not-json')}",
        '}',
        'function Get-CimInstance {[CmdletBinding()]param([string]$ClassName,[string]$Filter,[uint32]$OperationTimeoutSec)',
        "  if($ClassName -ne 'Win32_Process'){throw 'HOST_CIM_DENIED'}",
        '  $script:cimReads++',
        "  if($scenario -eq 'process-disappears' -and $script:cimReads -gt 1){return $null}",
        "  $node=Join-Path $NewRoot 'runtime\\node.exe'",
        "  $cli=Join-Path $NewRoot 'app\\dist\\src\\cli.js'",
        "  if($scenario -eq 'wrong-executable'){$node=$node+'.spoofed'}",
        '  $candidate=[pscustomobject]@{ProcessId=4242;ExecutablePath=$node;CommandLine=(\'"\'+$node+\'" "\'+$cli+\'" agent run\')}',
        "  if($scenario -eq 'duplicate-candidate'){return @($candidate,$candidate)}",
        '  return $candidate',
        '}',
        'function Copy-Item {[CmdletBinding()]param([string]$LiteralPath,[string]$Destination,[switch]$Force)',
        '  Microsoft.PowerShell.Management\\Copy-Item @PSBoundParameters',
        "  if($scenario -eq 'restore-corrupted' -and $LiteralPath.Contains('.update-rollback.')){[IO.File]::WriteAllText($Destination,'SYNTHETIC_RESTORE_CORRUPTION')}",
        '}',
        'function Start-Sleep {[CmdletBinding()]param([int]$Seconds,[int]$Milliseconds)}',
        '& ' + ps(helper),
        'exit $LASTEXITCODE',
      ].join('\r\n');
      await writeFile(wrapper, '\uFEFF' + program);
      cases.push({scenario, homeDir, appData, journal, protectedFiles, before, newRoot,
        launcher, launcherBackup, credential, native, wrapper});
    }
    const batch = path.join(root, 'fixture-batch.ps1');
    const results = path.join(root, 'fixture-results.json');
    // A script's exit returns to its caller with LASTEXITCODE. Keep the actual cutover
    // script intact, including its exit 1/2 paths, without per-case cold shell starts.
    await writeFile(batch, '\uFEFF' + [
      "$ErrorActionPreference='Stop'",
      '$results=@()',
      ...cases.flatMap(({scenario, homeDir, appData, wrapper}) => [
        '$env:USERPROFILE=' + ps(homeDir), '$env:LOCALAPPDATA=' + ps(appData),
        '[Console]::WriteLine(' + ps('[fixture] begin: ' + scenario.name) + ')',
        '$global:LASTEXITCODE=0',
        '& ' + ps(wrapper),
        '$code=$LASTEXITCODE',
        '[Console]::WriteLine(' + ps('[fixture] end: ' + scenario.name + ' code=') + '+$code)',
        '$results+= [pscustomobject]@{name=' + ps(scenario.name) + ';code=$code}',
        '[IO.File]::WriteAllText(' + ps(results) + ',(ConvertTo-Json -InputObject @($results) -Compress))',
      ]),
      'exit 0',
    ].join('\r\n'));
    running = new Promise<void>((resolve, reject) => {
      const child = spawn('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', batch],
        {env: isolatedLiveUpdateEnvironment({USERPROFILE: root, LOCALAPPDATA: path.join(root, 'AppData', 'Local')}),
          cwd: 'C:\\Windows\\System32', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']});
      let output = '', failure: Error | undefined;
      const stop = (error: Error) => { failure ??= error; child.kill(); };
      const abort = () => stop(new Error('PowerShell fixture cancelled'));
      const timer = setTimeout(() => stop(new Error('PowerShell fixture exceeded 180 seconds')), 180_000);
      t.signal.addEventListener('abort', abort, {once: true});
      if (t.signal.aborted) abort();
      for (const stream of [child.stdout, child.stderr]) stream.on('data', (data: Buffer) => {
        output = (output + data.toString('utf8')).slice(-128 * 1024);
        process.stdout.write(data);
      });
      child.once('error', error => { failure ??= error; });
      child.once('close', code => {
        clearTimeout(timer);
        t.signal.removeEventListener('abort', abort);
        if (failure || code !== 0) reject(new Error((failure?.message ?? `PowerShell exit ${code}`) + '\n' + output));
        else resolve();
      });
    });
    await running;
    const outcomes: {name: string; code: number}[] = JSON.parse(await readFile(results, 'utf8'));
    assert.deepEqual(outcomes.map(value => value.name), scenarios.map(value => value.name));
    for (const fixture of cases) {
      t.signal.throwIfAborted();
      const {scenario, homeDir, appData, journal, protectedFiles, before, newRoot,
        launcher, launcherBackup, credential, native} = fixture;
      await t.test(scenario.name, async () => {
        assert.equal(outcomes.find(value => value.name === scenario.name)?.code, scenario.code);
        const state = await readLiveUpdateState({localAppData: appData});
        assert.equal(state.state, scenario.result, JSON.stringify(state));
        assert.equal(state.agentStartupVerified, scenario.result === 'succeeded');
        assert.equal(state.activeConnectionVerified, false);
        assert.equal(state.currentVersion, scenario.result === 'rollback_failed' ? 'unknown'
          : scenario.result === 'succeeded' ? '1.0.8' : '1.0.7');
        assert.deepEqual(await Promise.all(protectedFiles.map(async file => hash(await readFile(file)))), before);
        if (scenario.result === 'rolled_back' || scenario.result === 'failed') {
          assert.deepEqual(await readFile(launcher), await readFile(launcherBackup));
        }
        if (scenario.result === 'succeeded') {
          const text = await readFile(launcher, 'utf8');
          assert.match(text, /^\uFEFF?\$env:NEXOWIRE_UPDATE_STARTUP_NONCE='[a-f0-9-]{36}'\r?\n/);
          assert.ok(text.includes(newRoot.replaceAll("'", "''")));
          assert.ok(text.includes(ps(credential)));
          assert.equal(text.match(/\$env:NEXOWIRE_UPDATE_STARTUP_NONCE=/g)?.length, 1);
          const expectedDiagnostic = scenario.name.endsWith('custom-journal')
            ? path.join(path.dirname(journal), 'native-agent', 'startup-diagnostic.json')
            : path.join(native, 'startup-diagnostic.json');
          const startup = JSON.parse(await readFile(expectedDiagnostic, 'utf8'));
          assert.equal(startup.processId, 4242);
          assert.equal(startup.startupNonce, /NEXOWIRE_UPDATE_STARTUP_NONCE='([^']+)'/.exec(text)?.[1]);
        }
        if (scenario.name === 'disabled-agent') {
          await assert.rejects(readFile(path.join(homeDir, 'fixture-actions.txt')), {code: 'ENOENT'});
        }
        const journalReadback = new AgentOperationJournal(journal);
        try {
          assert.equal((await journalReadback.inspect(unknownId))?.status, 'unknown');
          assert.equal((await journalReadback.begin(unknownId, fingerprint, 'shell.exec')).created, false);
        } finally { journalReadback.close(); }
      });
    }
    t.diagnostic('Real SQLite files and PowerShell script, generated data and task/process stubs. ' +
      'No live task, Agent, Broker, account, enrollment or physical update acceptance.');
  });
