import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const runFile = promisify(execFile);

/**
 * Ask Windows kernel independently whether a STILL-SUSPENDED root is
 * a member of the unique named Job, bound to its actual creation FILETIME.
 * A helper-authored marker is never sufficient evidence.
 */
export async function verifyWindowsKernelJob(
  pid: number,
  creationFiletime: string,
  jobName: string,
): Promise<void> {
  if (process.platform !== 'win32') throw new Error('WINDOWS_JOB_WINDOWS_ONLY');
  if (!Number.isSafeInteger(pid) || pid < 1 || pid > 0xffffffff ||
      !/^[0-9]{12,20}$/.test(creationFiletime) ||
      !/^Local\\Nexowire-[0-9a-f-]{36}$/.test(jobName)) {
    throw new Error('WINDOWS_JOB_KERNEL_INVALID_PROOF_INPUT');
  }
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot || !path.win32.isAbsolute(systemRoot) ||
      !/^[a-zA-Z]:\\Windows$/i.test(systemRoot.replace(/[\\/]+$/, ''))) {
    throw new Error('WINDOWS_JOB_SYSTEM_ROOT_UNTRUSTED');
  }
  const powershell = path.win32.join(
    systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe',
  );
  const script = "$ErrorActionPreference = 'Stop'\nAdd-Type -TypeDefinition @'\nusing System;\nusing System.Runtime.InteropServices;\npublic static class NXJobProbe {\n  [DllImport(\"kernel32.dll\", CharSet=CharSet.Unicode, SetLastError=true)]\n  public static extern IntPtr OpenJobObject(uint access, bool inherit, string name);\n  [DllImport(\"kernel32.dll\", SetLastError=true)]\n  public static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);\n  [DllImport(\"kernel32.dll\", SetLastError=true)]\n  [return:MarshalAs(UnmanagedType.Bool)]\n  public static extern bool IsProcessInJob(IntPtr process, IntPtr job, [MarshalAs(UnmanagedType.Bool)] out bool inside);\n  [DllImport(\"kernel32.dll\", SetLastError=true)]\n  [return:MarshalAs(UnmanagedType.Bool)]\n  public static extern bool GetProcessTimes(IntPtr process, out long creation, out long exit, out long kernel, out long user);\n  [DllImport(\"kernel32.dll\", SetLastError=true)]\n  [return:MarshalAs(UnmanagedType.Bool)]\n  public static extern bool QueryInformationJobObject(IntPtr job, int info, IntPtr buf, uint length, IntPtr returned);\n  [DllImport(\"kernel32.dll\", SetLastError=true)]\n  [return:MarshalAs(UnmanagedType.Bool)]\n  public static extern bool CloseHandle(IntPtr handle);\n}\n'@\n$job = [NXJobProbe]::OpenJobObject(0x0004, $false, '__JOB__')\nif ($job -eq [IntPtr]::Zero) { throw 'WINDOWS_JOB_KERNEL_NO_NAMED_JOB' }\ntry {\n  $proc = [NXJobProbe]::OpenProcess(0x1000, $false, [uint32]__PID__)\n  if ($proc -eq [IntPtr]::Zero) { throw 'WINDOWS_JOB_KERNEL_NO_PROCESS' }\n  try {\n    [bool]$inside = $false\n    if (-not [NXJobProbe]::IsProcessInJob($proc, $job, [ref]$inside) -or -not $inside) {\n      throw 'WINDOWS_JOB_KERNEL_NOT_MEMBER'\n    }\n    [long]$created = 0; [long]$exited = 0; [long]$kernel = 0; [long]$user = 0\n    if (-not [NXJobProbe]::GetProcessTimes($proc, [ref]$created, [ref]$exited, [ref]$kernel, [ref]$user) -or $created -ne [long]__TICKS__) {\n      throw 'WINDOWS_JOB_KERNEL_PID_CREATION_MISMATCH'\n    }\n    $buffer = [Runtime.InteropServices.Marshal]::AllocHGlobal(144)\n    try {\n      if (-not [NXJobProbe]::QueryInformationJobObject($job, 9, $buffer, 144, [IntPtr]::Zero)) {\n        throw ('WINDOWS_JOB_KERNEL_LIMIT_QUERY_FAILED win32=' + [Runtime.InteropServices.Marshal]::GetLastWin32Error())\n      }\n      $flags = [Runtime.InteropServices.Marshal]::ReadInt32($buffer, 16)\n      if (($flags -band 0x2000) -eq 0 -or ($flags -band 0x1800) -ne 0) {\n        throw 'WINDOWS_JOB_KERNEL_UNSAFE_BREAKAWAY_OR_LIFETIME'\n      }\n    } finally { [Runtime.InteropServices.Marshal]::FreeHGlobal($buffer) }\n    [Console]::Out.WriteLine('NW_KERNEL_JOB_VERIFIED')\n  } finally { [void][NXJobProbe]::CloseHandle($proc) }\n} finally { [void][NXJobProbe]::CloseHandle($job) }\n"
    .replace('__JOB__', jobName)
    .replace('__PID__', String(pid))
    .replace('__TICKS__', creationFiletime);
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  try {
    const { stdout } = await runFile(
      powershell,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      { windowsHide: true, timeout: 9_000, maxBuffer: 16_384 },
    );
    if (stdout.trim() !== 'NW_KERNEL_JOB_VERIFIED') {
      throw new Error('WINDOWS_JOB_KERNEL_UNEXPECTED_PROOF');
    }
  } catch (error) {
    const diagnostic = error && typeof error === 'object' && 'stderr' in error
      ? String(error.stderr).slice(0, 900)
      : error instanceof Error ? error.message.slice(0, 300) : 'unknown';
    throw new Error('WINDOWS_JOB_KERNEL_ATTESTATION_FAILED: ' + diagnostic);
  }
}
