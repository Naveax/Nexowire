import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const runFile = promisify(execFile);

/**
 * Independent Win32 kernel attestation for an UNNAMED Job.
 * Duplicates exactly the guardian's handle with read-only Job access.
 * Root remains CREATE_SUSPENDED until this probe succeeds.
 * No plaintext marker can substitute for this OS membership query.
 */
export async function verifyWindowsKernelJob(
  pid: number,
  creationFiletime: string,
  guardianPid: number,
  guardianJobHandle: string,
): Promise<void> {
  if (process.platform !== 'win32') throw new Error('WINDOWS_JOB_WINDOWS_ONLY');
  if (!Number.isSafeInteger(pid) || pid < 1 || pid > 0xffffffff ||
      !Number.isSafeInteger(guardianPid) || guardianPid < 1 || guardianPid > 0xffffffff ||
      !/^[0-9]{12,20}$/.test(creationFiletime) ||
      !/^[1-9][0-9]{0,17}$/.test(guardianJobHandle)) {
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
  const script = "$ErrorActionPreference='Stop'\nAdd-Type -TypeDefinition @'\nusing System;\nusing System.Runtime.InteropServices;\npublic static class NXJobProbeV5 {\n  [DllImport(\"kernel32.dll\", SetLastError=true)]\n  public static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);\n  [DllImport(\"kernel32.dll\", SetLastError=true)]\n  public static extern IntPtr GetCurrentProcess();\n  [DllImport(\"kernel32.dll\", SetLastError=true)]\n  [return:MarshalAs(UnmanagedType.Bool)]\n  public static extern bool DuplicateHandle(IntPtr source, IntPtr handle, IntPtr target, out IntPtr duplicate, uint access, bool inherit, uint options);\n  [DllImport(\"kernel32.dll\", SetLastError=true)]\n  [return:MarshalAs(UnmanagedType.Bool)]\n  public static extern bool IsProcessInJob(IntPtr process, IntPtr job, [MarshalAs(UnmanagedType.Bool)] out bool inside);\n  [DllImport(\"kernel32.dll\", SetLastError=true)]\n  [return:MarshalAs(UnmanagedType.Bool)]\n  public static extern bool GetProcessTimes(IntPtr process, out long creation, out long exit, out long kernel, out long user);\n  [DllImport(\"kernel32.dll\", SetLastError=true)]\n  [return:MarshalAs(UnmanagedType.Bool)]\n  public static extern bool QueryInformationJobObject(IntPtr job, int info, IntPtr buf, uint length, IntPtr returned);\n  [DllImport(\"kernel32.dll\", SetLastError=true)]\n  [return:MarshalAs(UnmanagedType.Bool)]\n  public static extern bool CloseHandle(IntPtr handle);\n}\n'@\n# Open a real kernel process object for the exact Node-spawned guardian PID.\n# Duplicating its specific Job handle does not rely on any public Job name.\n$guardian=[NXJobProbeV5]::OpenProcess(0x0040, $false, [uint32]__GUARD_PID__)\nif ($guardian -eq [IntPtr]::Zero) { throw 'WINDOWS_JOB_KERNEL_GUARDIAN_UNAVAILABLE' }\ntry {\n  $job=[IntPtr]::Zero\n  $original=[IntPtr]::new([long]__HANDLE__)\n  if (-not [NXJobProbeV5]::DuplicateHandle($guardian,$original,[NXJobProbeV5]::GetCurrentProcess(),[ref]$job,0x0004,$false,0)) {\n    throw 'WINDOWS_JOB_KERNEL_HANDLE_DUP_FAILED'\n  }\n  try {\n    $proc=[NXJobProbeV5]::OpenProcess(0x1000,$false,[uint32]__PID__)\n    if ($proc -eq [IntPtr]::Zero) { throw 'WINDOWS_JOB_KERNEL_ROOT_UNAVAILABLE' }\n    try {\n      [bool]$inside=$false\n      if (-not [NXJobProbeV5]::IsProcessInJob($proc,$job,[ref]$inside) -or -not $inside) {\n        throw 'WINDOWS_JOB_KERNEL_NOT_MEMBER'\n      }\n      [long]$created=0;[long]$exited=0;[long]$kernel=0;[long]$user=0\n      if (-not [NXJobProbeV5]::GetProcessTimes($proc,[ref]$created,[ref]$exited,[ref]$kernel,[ref]$user) -or $created -ne [long]__TICKS__) {\n        throw 'WINDOWS_JOB_KERNEL_PID_CREATION_MISMATCH'\n      }\n      # JOBOBJECT_EXTENDED_LIMIT_INFORMATION has size 144 on x64.\n      $buffer=[Runtime.InteropServices.Marshal]::AllocHGlobal(144)\n      try {\n        if (-not [NXJobProbeV5]::QueryInformationJobObject($job,9,$buffer,144,[IntPtr]::Zero)) {\n          throw 'WINDOWS_JOB_KERNEL_LIMIT_QUERY_FAILED'\n        }\n        $flags=[Runtime.InteropServices.Marshal]::ReadInt32($buffer,16)\n        if (($flags -band 0x2000) -eq 0 -or ($flags -band 0x1800) -ne 0) {\n          throw 'WINDOWS_JOB_KERNEL_UNSAFE_BREAKAWAY_OR_LIFETIME'\n        }\n      } finally { [Runtime.InteropServices.Marshal]::FreeHGlobal($buffer) }\n      [Console]::Out.WriteLine('NW_KERNEL_JOB_VERIFIED_V5')\n    } finally { [void][NXJobProbeV5]::CloseHandle($proc) }\n  } finally { [void][NXJobProbeV5]::CloseHandle($job) }\n} finally { [void][NXJobProbeV5]::CloseHandle($guardian) }\n"
    .replace('__GUARD_PID__', String(guardianPid))
    .replace('__HANDLE__', guardianJobHandle)
    .replace('__PID__', String(pid))
    .replace('__TICKS__', creationFiletime);
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  try {
    const { stdout } = await runFile(powershell,
      ['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',encoded],
      { windowsHide:true, timeout:9000, maxBuffer:16384 });
    if (stdout.trim() !== 'NW_KERNEL_JOB_VERIFIED_V5') {
      throw new Error('WINDOWS_JOB_KERNEL_UNEXPECTED_PROOF');
    }
  } catch(error) {
    const diagnostic = error && typeof error === 'object' && 'stderr' in error
      ? String(error.stderr).slice(0,900)
      : error instanceof Error ? error.message.slice(0,300) : 'unknown';
    throw new Error('WINDOWS_JOB_KERNEL_ATTESTATION_FAILED: '+diagnostic);
  }
}
