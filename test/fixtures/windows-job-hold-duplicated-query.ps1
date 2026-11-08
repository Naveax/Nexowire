param(
  [Parameter(Mandatory=$true)][ValidateRange(1,4294967295)][long]$GuardianPid,
  [Parameter(Mandatory=$true)][ValidateRange(1,9223372036854775807)][long]$JobHandle
)
$ErrorActionPreference='Stop'
# ONLY a synthetic guardian PID created by the caller's test fixture.
# This script opens a query-only duplicate and never terminates any process.
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class NXJobDuplicateFixture {
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll", SetLastError=true)]
  [return:MarshalAs(UnmanagedType.Bool)]
  public static extern bool DuplicateHandle(IntPtr source, IntPtr sourceHandle, IntPtr target, out IntPtr targetHandle, uint access, bool inherit, uint options);
  [DllImport("kernel32.dll", SetLastError=true)]
  [return:MarshalAs(UnmanagedType.Bool)]
  public static extern bool CloseHandle(IntPtr handle);
}
'@
$source=[NXJobDuplicateFixture]::OpenProcess(0x0040,$false,[uint32]$GuardianPid)
if ($source -eq [IntPtr]::Zero) { throw 'NX_TEST_PROCESS_DUP_HANDLE_DENIED' }
try {
  $copy=[IntPtr]::Zero
  if (-not [NXJobDuplicateFixture]::DuplicateHandle(
    $source,[IntPtr]::new($JobHandle),[NXJobDuplicateFixture]::GetCurrentProcess(),
    [ref]$copy,0x0004,$false,0)) {
    throw 'NX_TEST_JOB_HANDLE_DUPLICATE_DENIED'
  }
  try {
    [Console]::WriteLine('NX_DUPLICATED_JOB_QUERY_READY')
    [Console]::Out.Flush()
    [void][Console]::ReadLine()
  } finally {
    [void][NXJobDuplicateFixture]::CloseHandle($copy)
  }
} finally {
  [void][NXJobDuplicateFixture]::CloseHandle($source)
}
