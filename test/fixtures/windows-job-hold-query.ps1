param([Parameter(Mandatory=$true)][string]$JobName)
$ErrorActionPreference='Stop'
# Synthetic test-only read handle. No mutation or real-system PID targets.
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class NXReadJob {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern IntPtr OpenJobObject(uint access, bool inherit, string name);
  [DllImport("kernel32.dll", SetLastError=true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  public static extern bool CloseHandle(IntPtr handle);
}
'@
$job=[NXReadJob]::OpenJobObject(0x0004,$false,$JobName)
if($job -eq [IntPtr]::Zero){throw 'TEST_JOB_OPEN_FAILED'}
try {
  [Console]::Out.WriteLine('NW_HOLDER_READY')
  [Console]::Out.Flush()
  [void][Console]::In.ReadLine()
} finally {
  [void][NXReadJob]::CloseHandle($job)
}
