import { spawn, spawnSync } from 'node:child_process';
import * as z from 'zod';
import type { Capability } from '../protocol/capabilities.js';

const ProcessListInputSchema = z.object({
  name: z.string().min(1).max(260).optional(),
  pid: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(2000).default(250),
  include_command_line: z.boolean().default(false),
});

const ServiceListInputSchema = z.object({
  name: z.string().min(1).max(260).optional(),
  state: z.enum(['running', 'stopped', 'paused', 'all']).default('all'),
  limit: z.number().int().min(1).max(5000).default(1000),
});

const NetworkSnapshotInputSchema = z.object({
  include_connections: z.boolean().default(false),
  connection_limit: z.number().int().min(1).max(5000).default(250),
});

const ServiceControlInputSchema = z.object({
  name: z.string().min(1).max(260),
  action: z.enum(['start', 'stop', 'restart', 'set_startup']),
  startup_type: z.enum(['automatic', 'manual', 'disabled']).optional(),
});

const RegistryReadInputSchema = z.object({
  hive: z.enum(['HKCU', 'HKLM', 'HKCR', 'HKU', 'HKCC']),
  path: z.string().max(4096).default(''),
  name: z.string().max(1024).optional(),
  include_subkeys: z.boolean().default(true),
  limit: z.number().int().min(1).max(5000).default(500),
});

const ScheduledTaskListInputSchema = z.object({
  name: z.string().min(1).max(512).optional(),
  path: z.string().min(1).max(2048).optional(),
  state: z.enum(['all', 'ready', 'running', 'disabled', 'queued', 'unknown']).default('all'),
  limit: z.number().int().min(1).max(5000).default(500),
});

const EventLogQueryInputSchema = z.object({
  log_name: z.string().min(1).max(512).default('System'),
  provider: z.string().min(1).max(512).optional(),
  level: z.enum(['all', 'critical', 'error', 'warning', 'information', 'verbose']).default('all'),
  since_minutes: z.number().int().min(1).max(43_200).default(60),
  max_events: z.number().int().min(1).max(2000).default(100),
});

const FirewallRulesInputSchema = z.object({
  name: z.string().min(1).max(512).optional(),
  direction: z.enum(['all', 'inbound', 'outbound']).default('all'),
  action: z.enum(['all', 'allow', 'block']).default('all'),
  enabled: z.boolean().optional(),
  limit: z.number().int().min(1).max(5000).default(500),
});

const RegistrySetInputSchema = z.object({
  hive: z.enum(['HKCU', 'HKLM', 'HKCR', 'HKU', 'HKCC']),
  path: z.string().min(1).max(4096),
  name: z.string().max(1024),
  type: z.enum([
    'string',
    'expand_string',
    'dword',
    'qword',
    'multi_string',
    'binary',
  ]),
  value: z.union([
    z.string().max(4_194_304),
    z.number(),
    z.array(z.string().max(65_536)).max(4096),
  ]),
  create_key: z.boolean().default(false),
});

const RegistryDeleteInputSchema = z.object({
  hive: z.enum(['HKCU', 'HKLM', 'HKCR', 'HKU', 'HKCC']),
  path: z
    .string()
    .min(1)
    .max(4096)
    .refine((value) => value.replace(/[\\/]/g, '').trim().length > 0, {
      message: 'Deleting a registry hive root is not allowed.',
    }),
  name: z.string().max(1024).optional(),
  recursive: z.boolean().default(false),
});

const ScheduledTaskControlInputSchema = z.object({
  name: z.string().min(1).max(512).refine((value) => !/[\*?\[\]]/.test(value), {
    message: 'Task control requires an exact task name without wildcard characters.',
  }),
  path: z.string().min(1).max(2048).default('\\').refine((value) => !/[\*?\[\]]/.test(value), {
    message: 'Task control requires an exact task path without wildcard characters.',
  }),
  action: z.enum(['start', 'stop', 'enable', 'disable']),
});

const FirewallControlInputSchema = z.object({
  name: z.string().min(1).max(512).refine((value) => !/[\*?\[\]]/.test(value), {
    message: 'Firewall control requires an exact rule name without wildcard characters.',
  }),
  action: z.enum(['enable', 'disable', 'set_action']),
  rule_action: z.enum(['allow', 'block']).optional(),
});

interface PowerShellResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

function findPowerShell(): string {
  const candidates =
    process.platform === 'win32'
      ? ['pwsh.exe', 'powershell.exe']
      : ['pwsh'];
  for (const candidate of candidates) {
    const probe = spawnSync(
      process.platform === 'win32' ? 'where.exe' : 'which',
      [candidate],
      { windowsHide: true, stdio: 'ignore' },
    );
    if (probe.status === 0) return candidate;
  }
  throw new Error('PowerShell is not available.');
}

async function runPowerShell(
  script: string,
  input: unknown,
  timeoutMs = 30_000,
): Promise<PowerShellResult> {
  const executable = findPowerShell();
  return await new Promise<PowerShellResult>((resolve, reject) => {
    const child = spawn(
      executable,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
      {
        windowsHide: true,
        env: {
          ...process.env,
          NEXOWIRE_INPUT: JSON.stringify(input),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timedOut = false;

    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.once('close', (exitCode) => {
      clearTimeout(timer);
      const result = {
        stdout: Buffer.concat(stdout).toString('utf8').trim(),
        stderr: Buffer.concat(stderr).toString('utf8').trim(),
        exitCode,
      };
      if (timedOut) {
        reject(new Error(`PowerShell operation timed out after ${timeoutMs}ms.`));
        return;
      }
      if (exitCode !== 0) {
        reject(
          new Error(
            result.stderr ||
              result.stdout ||
              `PowerShell exited with code ${exitCode ?? 'unknown'}.`,
          ),
        );
        return;
      }
      resolve(result);
    });
  });
}

async function runPowerShellJson<T>(
  script: string,
  input: unknown,
  timeoutMs = 30_000,
): Promise<T> {
  const result = await runPowerShell(script, input, timeoutMs);
  if (!result.stdout) return undefined as T;
  return JSON.parse(result.stdout) as T;
}

function asArray<T>(value: T | T[] | null | undefined): T[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function validateRegistrySetInput(
  input: z.infer<typeof RegistrySetInputSchema>,
): void {
  switch (input.type) {
    case 'string':
    case 'expand_string':
    case 'binary':
      if (typeof input.value !== 'string') {
        throw new Error(`Registry type ${input.type} requires a string value.`);
      }
      if (input.type === 'binary' && !/^[A-Za-z0-9+/]*={0,2}$/.test(input.value)) {
        throw new Error('Binary registry values must be base64 encoded.');
      }
      return;
    case 'multi_string':
      if (!Array.isArray(input.value)) {
        throw new Error('Registry type multi_string requires an array of strings.');
      }
      return;
    case 'dword':
      if (
        typeof input.value !== 'number' ||
        !Number.isInteger(input.value) ||
        input.value < 0 ||
        input.value > 0xffff_ffff
      ) {
        throw new Error('Registry type dword requires an integer from 0 to 4294967295.');
      }
      return;
    case 'qword': {
      if (typeof input.value === 'number') {
        if (!Number.isSafeInteger(input.value) || input.value < 0) {
          throw new Error('Numeric qword values must be non-negative safe integers; use a decimal string for larger values.');
        }
        return;
      }
      if (typeof input.value !== 'string' || !/^\d+$/.test(input.value)) {
        throw new Error('Registry type qword requires a non-negative integer or decimal string.');
      }
      if (BigInt(input.value) > 9_223_372_036_854_775_807n) {
        throw new Error('Registry qword values above signed 64-bit range are not supported.');
      }
      return;
    }
  }
}

function assertWindows(): void {
  if (process.platform !== 'win32') {
    throw new Error('This capability is only available from a Windows native agent.');
  }
}

const processListScript = String.raw`
$ErrorActionPreference = 'Stop'
$inputData = $env:NEXOWIRE_INPUT | ConvertFrom-Json
$items = @(Get-CimInstance Win32_Process)
if ($null -ne $inputData.pid) {
  $items = @($items | Where-Object { $_.ProcessId -eq [int]$inputData.pid })
}
if ($inputData.name) {
  $needle = [string]$inputData.name
  $items = @($items | Where-Object { $_.Name -like $needle -or $_.Name -like "*$needle*" })
}
$result = @($items | Select-Object -First ([int]$inputData.limit) | ForEach-Object {
  [pscustomobject]@{
    pid = [int]$_.ProcessId
    parentPid = [int]$_.ParentProcessId
    name = [string]$_.Name
    executablePath = if ($_.ExecutablePath) { [string]$_.ExecutablePath } else { $null }
    commandLine = if ($inputData.include_command_line -and $_.CommandLine) { [string]$_.CommandLine } else { $null }
    workingSetBytes = if ($null -ne $_.WorkingSetSize) { [double]$_.WorkingSetSize } else { $null }
    createdAt = if ($_.CreationDate) { ([datetime]$_.CreationDate).ToUniversalTime().ToString('o') } else { $null }
  }
})
@($result) | ConvertTo-Json -Depth 5 -Compress
`;

const serviceListScript = String.raw`
$ErrorActionPreference = 'Stop'
$inputData = $env:NEXOWIRE_INPUT | ConvertFrom-Json
$items = @(Get-CimInstance Win32_Service)
if ($inputData.name) {
  $needle = [string]$inputData.name
  $items = @($items | Where-Object { $_.Name -like $needle -or $_.DisplayName -like "*$needle*" })
}
if ($inputData.state -ne 'all') {
  $wanted = if ($inputData.state -eq 'running') { 'Running' } elseif ($inputData.state -eq 'paused') { 'Paused' } else { 'Stopped' }
  $items = @($items | Where-Object { $_.State -eq $wanted })
}
$result = @($items | Sort-Object Name | Select-Object -First ([int]$inputData.limit) | ForEach-Object {
  [pscustomobject]@{
    name = [string]$_.Name
    displayName = [string]$_.DisplayName
    state = [string]$_.State
    status = [string]$_.Status
    startMode = [string]$_.StartMode
    pid = [int]$_.ProcessId
    account = [string]$_.StartName
    path = [string]$_.PathName
  }
})
@($result) | ConvertTo-Json -Depth 5 -Compress
`;

const networkSnapshotScript = String.raw`
$ErrorActionPreference = 'Stop'
$inputData = $env:NEXOWIRE_INPUT | ConvertFrom-Json
$adapters = @(Get-NetAdapter -ErrorAction Stop | Sort-Object ifIndex | ForEach-Object {
  [pscustomobject]@{
    index = [int]$_.ifIndex
    name = [string]$_.Name
    description = [string]$_.InterfaceDescription
    status = [string]$_.Status
    linkSpeed = [string]$_.LinkSpeed
    macAddress = [string]$_.MacAddress
  }
})
$addresses = @(Get-NetIPAddress -ErrorAction SilentlyContinue | Where-Object {
  $_.AddressState -eq 'Preferred'
} | ForEach-Object {
  [pscustomobject]@{
    interfaceIndex = [int]$_.InterfaceIndex
    family = [string]$_.AddressFamily
    address = [string]$_.IPAddress
    prefixLength = [int]$_.PrefixLength
    type = [string]$_.Type
  }
})
$dns = @(Get-DnsClientServerAddress -ErrorAction SilentlyContinue | Where-Object {
  $_.ServerAddresses.Count -gt 0
} | ForEach-Object {
  [pscustomobject]@{
    interfaceIndex = [int]$_.InterfaceIndex
    interfaceAlias = [string]$_.InterfaceAlias
    family = [string]$_.AddressFamily
    servers = @($_.ServerAddresses)
  }
})
$routes = @(Get-NetRoute -ErrorAction SilentlyContinue | Where-Object {
  $_.DestinationPrefix -eq '0.0.0.0/0' -or $_.DestinationPrefix -eq '::/0'
} | Sort-Object RouteMetric | ForEach-Object {
  [pscustomobject]@{
    interfaceIndex = [int]$_.InterfaceIndex
    destination = [string]$_.DestinationPrefix
    nextHop = [string]$_.NextHop
    metric = [int]$_.RouteMetric
    state = [string]$_.State
  }
})
$connections = @()
if ($inputData.include_connections) {
  $connections = @(Get-NetTCPConnection -ErrorAction SilentlyContinue |
    Sort-Object State, LocalPort |
    Select-Object -First ([int]$inputData.connection_limit) |
    ForEach-Object {
      [pscustomobject]@{
        localAddress = [string]$_.LocalAddress
        localPort = [int]$_.LocalPort
        remoteAddress = [string]$_.RemoteAddress
        remotePort = [int]$_.RemotePort
        state = [string]$_.State
        owningPid = [int]$_.OwningProcess
      }
    })
}
[pscustomobject]@{
  adapters = @($adapters)
  addresses = @($addresses)
  dns = @($dns)
  defaultRoutes = @($routes)
  tcpConnections = @($connections)
} | ConvertTo-Json -Depth 8 -Compress
`;

const serviceControlScript = String.raw`
$ErrorActionPreference = 'Stop'
$inputData = $env:NEXOWIRE_INPUT | ConvertFrom-Json
$name = [string]$inputData.name
$service = Get-Service -Name $name -ErrorAction Stop
switch ([string]$inputData.action) {
  'start' {
    if ($service.Status -ne 'Running') {
      Start-Service -Name $name -ErrorAction Stop
    }
  }
  'stop' {
    if ($service.Status -ne 'Stopped') {
      Stop-Service -Name $name -ErrorAction Stop
    }
  }
  'restart' {
    if ($service.Status -eq 'Running') {
      Restart-Service -Name $name -ErrorAction Stop
    } else {
      Start-Service -Name $name -ErrorAction Stop
    }
  }
  'set_startup' {
    if (-not $inputData.startup_type) {
      throw 'startup_type is required for set_startup.'
    }
  }
}
if ($inputData.startup_type) {
  $startup = switch ([string]$inputData.startup_type) {
    'automatic' { 'Automatic' }
    'manual' { 'Manual' }
    'disabled' { 'Disabled' }
  }
  Set-Service -Name $name -StartupType $startup -ErrorAction Stop
}
$final = Get-CimInstance Win32_Service -Filter ("Name='" + $name.Replace("'", "''") + "'") -ErrorAction Stop
[pscustomobject]@{
  name = [string]$final.Name
  displayName = [string]$final.DisplayName
  state = [string]$final.State
  startMode = [string]$final.StartMode
  pid = [int]$final.ProcessId
} | ConvertTo-Json -Depth 4 -Compress
`;

const registryReadScript = String.raw`
$ErrorActionPreference = 'Stop'
$inputData = $env:NEXOWIRE_INPUT | ConvertFrom-Json
$base = switch ([string]$inputData.hive) {
  'HKCU' { 'Registry::HKEY_CURRENT_USER' }
  'HKLM' { 'Registry::HKEY_LOCAL_MACHINE' }
  'HKCR' { 'Registry::HKEY_CLASSES_ROOT' }
  'HKU'  { 'Registry::HKEY_USERS' }
  'HKCC' { 'Registry::HKEY_CURRENT_CONFIG' }
}
$target = if ($inputData.path) { Join-Path $base ([string]$inputData.path) } else { $base }
$item = Get-Item -LiteralPath $target -ErrorAction Stop
$names = @($item.GetValueNames())
if ($null -ne $inputData.name) {
  $names = @($names | Where-Object { $_ -eq [string]$inputData.name })
}
$values = @($names | Select-Object -First ([int]$inputData.limit) | ForEach-Object {
  $valueName = [string]$_
  $kind = [string]$item.GetValueKind($valueName)
  $value = $item.GetValue($valueName, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
  if ($value -is [byte[]]) { $value = [Convert]::ToBase64String($value) }
  [pscustomobject]@{
    name = $valueName
    kind = $kind
    value = $value
  }
})
$subkeys = @()
if ($inputData.include_subkeys) {
  $subkeys = @($item.GetSubKeyNames() | Sort-Object | Select-Object -First ([int]$inputData.limit))
}
[pscustomobject]@{
  hive = [string]$inputData.hive
  path = [string]$inputData.path
  values = @($values)
  subkeys = @($subkeys)
} | ConvertTo-Json -Depth 8 -Compress
`;

const scheduledTasksScript = String.raw`
$ErrorActionPreference = 'Stop'
$inputData = $env:NEXOWIRE_INPUT | ConvertFrom-Json
$items = @(Get-ScheduledTask -ErrorAction Stop)
if ($inputData.name) {
  $needle = [string]$inputData.name
  $items = @($items | Where-Object { $_.TaskName -like $needle -or $_.TaskName -like "*$needle*" })
}
if ($inputData.path) {
  $taskPath = [string]$inputData.path
  $items = @($items | Where-Object { $_.TaskPath -like $taskPath -or $_.TaskPath -like "*$taskPath*" })
}
if ($inputData.state -ne 'all') {
  $wanted = switch ([string]$inputData.state) {
    'ready' { 'Ready' }
    'running' { 'Running' }
    'disabled' { 'Disabled' }
    'queued' { 'Queued' }
    default { 'Unknown' }
  }
  $items = @($items | Where-Object { [string]$_.State -eq $wanted })
}
$result = @($items | Sort-Object TaskPath, TaskName | Select-Object -First ([int]$inputData.limit) | ForEach-Object {
  [pscustomobject]@{
    name = [string]$_.TaskName
    path = [string]$_.TaskPath
    state = [string]$_.State
    author = [string]$_.Author
    description = [string]$_.Description
    uri = [string]$_.URI
  }
})
@($result) | ConvertTo-Json -Depth 6 -Compress
`;

const eventLogQueryScript = String.raw`
$ErrorActionPreference = 'Stop'
$inputData = $env:NEXOWIRE_INPUT | ConvertFrom-Json
$filter = @{
  LogName = [string]$inputData.log_name
  StartTime = (Get-Date).AddMinutes(-[int]$inputData.since_minutes)
}
if ($inputData.provider) { $filter.ProviderName = [string]$inputData.provider }
if ($inputData.level -ne 'all') {
  $filter.Level = switch ([string]$inputData.level) {
    'critical' { 1 }
    'error' { 2 }
    'warning' { 3 }
    'information' { 4 }
    'verbose' { 5 }
  }
}
$events = @(Get-WinEvent -FilterHashtable $filter -MaxEvents ([int]$inputData.max_events) -ErrorAction SilentlyContinue | ForEach-Object {
  [pscustomobject]@{
    id = [int]$_.Id
    recordId = if ($null -ne $_.RecordId) { [long]$_.RecordId } else { $null }
    timeCreated = if ($_.TimeCreated) { ([datetime]$_.TimeCreated).ToUniversalTime().ToString('o') } else { $null }
    level = [string]$_.LevelDisplayName
    provider = [string]$_.ProviderName
    logName = [string]$_.LogName
    machineName = [string]$_.MachineName
    message = if ($_.Message) { [string]$_.Message } else { $null }
  }
})
@($events) | ConvertTo-Json -Depth 6 -Compress
`;

const firewallRulesScript = String.raw`
$ErrorActionPreference = 'Stop'
$inputData = $env:NEXOWIRE_INPUT | ConvertFrom-Json
$items = @(Get-NetFirewallRule -ErrorAction Stop)
if ($inputData.name) {
  $needle = [string]$inputData.name
  $items = @($items | Where-Object { $_.Name -like $needle -or $_.DisplayName -like "*$needle*" })
}
if ($inputData.direction -ne 'all') {
  $wantedDirection = if ($inputData.direction -eq 'inbound') { 'Inbound' } else { 'Outbound' }
  $items = @($items | Where-Object { [string]$_.Direction -eq $wantedDirection })
}
if ($inputData.action -ne 'all') {
  $wantedAction = if ($inputData.action -eq 'allow') { 'Allow' } else { 'Block' }
  $items = @($items | Where-Object { [string]$_.Action -eq $wantedAction })
}
if ($null -ne $inputData.enabled) {
  $wantedEnabled = if ([bool]$inputData.enabled) { 'True' } else { 'False' }
  $items = @($items | Where-Object { [string]$_.Enabled -eq $wantedEnabled })
}
$result = @($items | Sort-Object DisplayName | Select-Object -First ([int]$inputData.limit) | ForEach-Object {
  [pscustomobject]@{
    name = [string]$_.Name
    displayName = [string]$_.DisplayName
    description = [string]$_.Description
    enabled = [string]$_.Enabled
    direction = [string]$_.Direction
    action = [string]$_.Action
    profile = [string]$_.Profile
    status = [string]$_.Status
    policyStoreSourceType = [string]$_.PolicyStoreSourceType
  }
})
@($result) | ConvertTo-Json -Depth 6 -Compress
`;

const registrySetScript = String.raw`
$ErrorActionPreference = 'Stop'
$inputData = $env:NEXOWIRE_INPUT | ConvertFrom-Json
$base = switch ([string]$inputData.hive) {
  'HKCU' { 'Registry::HKEY_CURRENT_USER' }
  'HKLM' { 'Registry::HKEY_LOCAL_MACHINE' }
  'HKCR' { 'Registry::HKEY_CLASSES_ROOT' }
  'HKU'  { 'Registry::HKEY_USERS' }
  'HKCC' { 'Registry::HKEY_CURRENT_CONFIG' }
}
$target = Join-Path $base ([string]$inputData.path)
if ($inputData.create_key) {
  New-Item -Path $target -Force -ErrorAction Stop | Out-Null
} else {
  Get-Item -LiteralPath $target -ErrorAction Stop | Out-Null
}
$kind = switch ([string]$inputData.type) {
  'string' { [Microsoft.Win32.RegistryValueKind]::String }
  'expand_string' { [Microsoft.Win32.RegistryValueKind]::ExpandString }
  'dword' { [Microsoft.Win32.RegistryValueKind]::DWord }
  'qword' { [Microsoft.Win32.RegistryValueKind]::QWord }
  'multi_string' { [Microsoft.Win32.RegistryValueKind]::MultiString }
  'binary' { [Microsoft.Win32.RegistryValueKind]::Binary }
}
$value = switch ([string]$inputData.type) {
  'string' { [string]$inputData.value }
  'expand_string' { [string]$inputData.value }
  'dword' { [uint32]$inputData.value }
  'qword' { [int64]::Parse([string]$inputData.value, [Globalization.CultureInfo]::InvariantCulture) }
  'multi_string' { [string[]]@($inputData.value) }
  'binary' { [Convert]::FromBase64String([string]$inputData.value) }
}
if ([string]$inputData.name -eq '') {
  $rootKey = switch ([string]$inputData.hive) {
    'HKCU' { [Microsoft.Win32.Registry]::CurrentUser }
    'HKLM' { [Microsoft.Win32.Registry]::LocalMachine }
    'HKCR' { [Microsoft.Win32.Registry]::ClassesRoot }
    'HKU'  { [Microsoft.Win32.Registry]::Users }
    'HKCC' { [Microsoft.Win32.Registry]::CurrentConfig }
  }
  $subPath = ([string]$inputData.path).Replace('/', '\\')
  $writableKey = $rootKey.OpenSubKey($subPath, $true)
  if ($null -eq $writableKey) { throw 'Registry key could not be opened for writing.' }
  try {
    $writableKey.SetValue('', $value, $kind)
  } finally {
    $writableKey.Dispose()
  }
} else {
  $propertyType = switch ([string]$inputData.type) {
    'string' { 'String' }
    'expand_string' { 'ExpandString' }
    'dword' { 'DWord' }
    'qword' { 'QWord' }
    'multi_string' { 'MultiString' }
    'binary' { 'Binary' }
  }
  New-ItemProperty -LiteralPath $target -Name ([string]$inputData.name) -Value $value -PropertyType $propertyType -Force -ErrorAction Stop | Out-Null
}
$verifyItem = Get-Item -LiteralPath $target -ErrorAction Stop
$storedKind = [string]$verifyItem.GetValueKind([string]$inputData.name)
$storedValue = $verifyItem.GetValue([string]$inputData.name, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
if ($storedValue -is [byte[]]) { $storedValue = [Convert]::ToBase64String($storedValue) }
[pscustomobject]@{
  hive = [string]$inputData.hive
  path = [string]$inputData.path
  name = [string]$inputData.name
  kind = $storedKind
  value = $storedValue
  verified = $true
} | ConvertTo-Json -Depth 8 -Compress
`;

const registryDeleteScript = String.raw`
$ErrorActionPreference = 'Stop'
$inputData = $env:NEXOWIRE_INPUT | ConvertFrom-Json
$base = switch ([string]$inputData.hive) {
  'HKCU' { 'Registry::HKEY_CURRENT_USER' }
  'HKLM' { 'Registry::HKEY_LOCAL_MACHINE' }
  'HKCR' { 'Registry::HKEY_CLASSES_ROOT' }
  'HKU'  { 'Registry::HKEY_USERS' }
  'HKCC' { 'Registry::HKEY_CURRENT_CONFIG' }
}
$target = Join-Path $base ([string]$inputData.path)
if ($null -ne $inputData.name) {
  $item = Get-Item -LiteralPath $target -ErrorAction Stop
  $existing = @($item.GetValueNames() | Where-Object { $_ -eq [string]$inputData.name })
  if ($existing.Count -ne 1) { throw 'Registry value was not found.' }
  if ([string]$inputData.name -eq '') {
    $rootKey = switch ([string]$inputData.hive) {
      'HKCU' { [Microsoft.Win32.Registry]::CurrentUser }
      'HKLM' { [Microsoft.Win32.Registry]::LocalMachine }
      'HKCR' { [Microsoft.Win32.Registry]::ClassesRoot }
      'HKU'  { [Microsoft.Win32.Registry]::Users }
      'HKCC' { [Microsoft.Win32.Registry]::CurrentConfig }
    }
    $subPath = ([string]$inputData.path).Replace('/', '\\')
    $writableKey = $rootKey.OpenSubKey($subPath, $true)
    if ($null -eq $writableKey) { throw 'Registry key could not be opened for writing.' }
    try {
      $writableKey.DeleteValue('', $true)
    } finally {
      $writableKey.Dispose()
    }
  } else {
    Remove-ItemProperty -LiteralPath $target -Name ([string]$inputData.name) -ErrorAction Stop
  }
  $verify = Get-Item -LiteralPath $target -ErrorAction Stop
  $stillExists = @($verify.GetValueNames() | Where-Object { $_ -eq [string]$inputData.name }).Count -gt 0
  if ($stillExists) { throw 'Registry value deletion verification failed.' }
  [pscustomobject]@{ hive = [string]$inputData.hive; path = [string]$inputData.path; name = [string]$inputData.name; deleted = $true; verified = $true } | ConvertTo-Json -Compress
} else {
  Get-Item -LiteralPath $target -ErrorAction Stop | Out-Null
  Remove-Item -LiteralPath $target -Recurse:([bool]$inputData.recursive) -Force -ErrorAction Stop
  if (Test-Path -LiteralPath $target) { throw 'Registry key deletion verification failed.' }
  [pscustomobject]@{ hive = [string]$inputData.hive; path = [string]$inputData.path; deleted = $true; verified = $true } | ConvertTo-Json -Compress
}
`;

const scheduledTaskControlScript = String.raw`
$ErrorActionPreference = 'Stop'
$inputData = $env:NEXOWIRE_INPUT | ConvertFrom-Json
$name = [string]$inputData.name
$taskPath = [string]$inputData.path
$matches = @(Get-ScheduledTask -ErrorAction Stop | Where-Object { $_.TaskName -eq $name -and $_.TaskPath -eq $taskPath })
if ($matches.Count -ne 1) { throw ('Expected exactly one scheduled task, found ' + $matches.Count + '.') }
$task = $matches[0]
switch ([string]$inputData.action) {
  'start' { Start-ScheduledTask -TaskName $name -TaskPath $taskPath -ErrorAction Stop }
  'stop' { Stop-ScheduledTask -TaskName $name -TaskPath $taskPath -ErrorAction Stop }
  'enable' { Enable-ScheduledTask -TaskName $name -TaskPath $taskPath -ErrorAction Stop | Out-Null }
  'disable' { Disable-ScheduledTask -TaskName $name -TaskPath $taskPath -ErrorAction Stop | Out-Null }
}
$finalMatches = @(Get-ScheduledTask -ErrorAction Stop | Where-Object { $_.TaskName -eq $name -and $_.TaskPath -eq $taskPath })
if ($finalMatches.Count -ne 1) { throw 'Scheduled-task verification failed.' }
$final = $finalMatches[0]
if ($inputData.action -eq 'enable' -and [string]$final.State -eq 'Disabled') { throw 'Scheduled-task enable verification failed.' }
if ($inputData.action -eq 'disable' -and [string]$final.State -ne 'Disabled') { throw 'Scheduled-task disable verification failed.' }
[pscustomobject]@{
  name = [string]$final.TaskName
  path = [string]$final.TaskPath
  state = [string]$final.State
  action = [string]$inputData.action
  verified = $true
} | ConvertTo-Json -Depth 4 -Compress
`;

const firewallControlScript = String.raw`
$ErrorActionPreference = 'Stop'
$inputData = $env:NEXOWIRE_INPUT | ConvertFrom-Json
$name = [string]$inputData.name
$matches = @(Get-NetFirewallRule -ErrorAction Stop | Where-Object { $_.Name -eq $name })
if ($matches.Count -ne 1) { throw ('Expected exactly one firewall rule, found ' + $matches.Count + '.') }
$rule = $matches[0]
switch ([string]$inputData.action) {
  'enable' { Enable-NetFirewallRule -Name $name -ErrorAction Stop | Out-Null }
  'disable' { Disable-NetFirewallRule -Name $name -ErrorAction Stop | Out-Null }
  'set_action' {
    if (-not $inputData.rule_action) { throw 'rule_action is required for set_action.' }
    $action = if ([string]$inputData.rule_action -eq 'allow') { 'Allow' } else { 'Block' }
    Set-NetFirewallRule -Name $name -Action $action -ErrorAction Stop | Out-Null
  }
}
$finalMatches = @(Get-NetFirewallRule -ErrorAction Stop | Where-Object { $_.Name -eq $name })
if ($finalMatches.Count -ne 1) { throw 'Firewall-rule verification failed.' }
$final = $finalMatches[0]
if ($inputData.action -eq 'enable' -and [string]$final.Enabled -ne 'True') { throw 'Firewall enable verification failed.' }
if ($inputData.action -eq 'disable' -and [string]$final.Enabled -ne 'False') { throw 'Firewall disable verification failed.' }
if ($inputData.action -eq 'set_action') {
  $wanted = if ([string]$inputData.rule_action -eq 'allow') { 'Allow' } else { 'Block' }
  if ([string]$final.Action -ne $wanted) { throw 'Firewall action verification failed.' }
}
[pscustomobject]@{
  name = [string]$final.Name
  displayName = [string]$final.DisplayName
  enabled = [string]$final.Enabled
  direction = [string]$final.Direction
  action = [string]$final.Action
  verified = $true
} | ConvertTo-Json -Depth 4 -Compress
`;

export async function executeWindowsCapability(
  capability: Capability,
  input: unknown,
): Promise<unknown> {
  assertWindows();

  switch (capability) {
    case 'windows.processes': {
      const parsed = ProcessListInputSchema.parse(input);
      return {
        data: {
          processes: asArray(await runPowerShellJson<unknown | unknown[]>(processListScript, parsed)),
        },
      };
    }
    case 'windows.services': {
      const parsed = ServiceListInputSchema.parse(input);
      return {
        data: {
          services: asArray(await runPowerShellJson<unknown | unknown[]>(serviceListScript, parsed)),
        },
      };
    }
    case 'windows.network.snapshot': {
      const parsed = NetworkSnapshotInputSchema.parse(input);
      return {
        data: await runPowerShellJson<Record<string, unknown>>(
          networkSnapshotScript,
          parsed,
          45_000,
        ),
      };
    }
    case 'windows.service.control': {
      const parsed = ServiceControlInputSchema.parse(input);
      if (parsed.action === 'set_startup' && !parsed.startup_type) {
        throw new Error('startup_type is required when action is set_startup.');
      }
      return {
        data: await runPowerShellJson<Record<string, unknown>>(
          serviceControlScript,
          parsed,
          60_000,
        ),
      };
    }
    case 'windows.registry.read': {
      const parsed = RegistryReadInputSchema.parse(input);
      return {
        data: await runPowerShellJson<Record<string, unknown>>(
          registryReadScript,
          parsed,
        ),
      };
    }
    case 'windows.tasks': {
      const parsed = ScheduledTaskListInputSchema.parse(input);
      return {
        data: {
          tasks: asArray(
            await runPowerShellJson<unknown | unknown[]>(scheduledTasksScript, parsed),
          ),
        },
      };
    }
    case 'windows.eventlog.query': {
      const parsed = EventLogQueryInputSchema.parse(input);
      return {
        data: {
          events: asArray(
            await runPowerShellJson<unknown | unknown[]>(eventLogQueryScript, parsed, 45_000),
          ),
        },
      };
    }
    case 'windows.firewall.rules': {
      const parsed = FirewallRulesInputSchema.parse(input);
      return {
        data: {
          rules: asArray(
            await runPowerShellJson<unknown | unknown[]>(firewallRulesScript, parsed, 45_000),
          ),
        },
      };
    }
    case 'windows.registry.set': {
      const parsed = RegistrySetInputSchema.parse(input);
      validateRegistrySetInput(parsed);
      return {
        data: await runPowerShellJson<Record<string, unknown>>(
          registrySetScript,
          parsed,
          45_000,
        ),
      };
    }
    case 'windows.registry.delete': {
      const parsed = RegistryDeleteInputSchema.parse(input);
      return {
        data: await runPowerShellJson<Record<string, unknown>>(
          registryDeleteScript,
          parsed,
          45_000,
        ),
      };
    }
    case 'windows.task.control': {
      const parsed = ScheduledTaskControlInputSchema.parse(input);
      return {
        data: await runPowerShellJson<Record<string, unknown>>(
          scheduledTaskControlScript,
          parsed,
          60_000,
        ),
      };
    }
    case 'windows.firewall.control': {
      const parsed = FirewallControlInputSchema.parse(input);
      if (parsed.action === 'set_action' && !parsed.rule_action) {
        throw new Error('rule_action is required when action is set_action.');
      }
      return {
        data: await runPowerShellJson<Record<string, unknown>>(
          firewallControlScript,
          parsed,
          60_000,
        ),
      };
    }
    default:
      throw new Error(`Unsupported Windows capability: ${capability}`);
  }
}
