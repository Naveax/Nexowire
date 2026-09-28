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
    default:
      throw new Error(`Unsupported Windows capability: ${capability}`);
  }
}
