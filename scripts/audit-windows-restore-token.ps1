#Requires -Version 5.1
<#
.SYNOPSIS
  Read-only effective Windows token privilege audit for P0 recovery planning.
.DESCRIPTION
  Never adjusts privileges, opens a production file, reads DPAPI/OAuth data,
  touches Scheduled Tasks or attempts ACL restore. A diagnostic only.
#>
[CmdletBinding()]
param()
$ErrorActionPreference='Stop'
if($args.Count -ne 0){throw 'P0_TOKEN_AUDIT_UNEXPECTED_ARGS'}
if($PSVersionTable.PSEdition -eq 'Core' -and -not $IsWindows){
 throw 'P0_TOKEN_AUDIT_WINDOWS_REQUIRED'
}
$principal=[Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if(!$principal.Identity){throw 'P0_TOKEN_IDENTITY_MISSING'}
# Only OS-provided advapi32/kernel32, never commands selected from PATH.
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class NexowireP0RecoveryToken {
  [StructLayout(LayoutKind.Sequential)]
  public struct LUID { public uint LowPart; public int HighPart; }
  [StructLayout(LayoutKind.Sequential)]
  public struct LUID_AND_ATTRIBUTES {
    public LUID Luid;
    public uint Attributes;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct TOKEN_PRIVILEGES_ONE {
    public uint PrivilegeCount;
    public LUID_AND_ATTRIBUTES Privileges;
  }
  [DllImport("kernel32.dll")]
  private static extern IntPtr GetCurrentProcess();
  [DllImport("advapi32.dll",SetLastError=true)]
  private static extern bool OpenProcessToken(IntPtr process,uint rights,out IntPtr token);
  [DllImport("advapi32.dll",SetLastError=true)]
  private static extern bool GetTokenInformation(IntPtr token,int infoClass,IntPtr buffer,int length,out int needed);
  [DllImport("advapi32.dll",EntryPoint="LookupPrivilegeValueW",CharSet=CharSet.Unicode,SetLastError=true)]
  private static extern bool LookupPrivilegeValue(string system,string name,out LUID luid);
  [DllImport("kernel32.dll",SetLastError=true)]
  private static extern bool CloseHandle(IntPtr handle);
  public static int[] ReadPrivileges(string[] names){
    IntPtr token=IntPtr.Zero;
    IntPtr buffer=IntPtr.Zero;
    try {
      if(!OpenProcessToken(GetCurrentProcess(),0x0008,out token)) {
        throw new InvalidOperationException("P0_TOKEN_OPEN_FAILED");
      }
      int needed;
      GetTokenInformation(token,3,IntPtr.Zero,0,out needed);
      if(needed<4 || needed>65536)throw new InvalidOperationException("P0_TOKEN_SIZE_INVALID");
      buffer=Marshal.AllocHGlobal(needed);
      int outputLength;
      if(!GetTokenInformation(token,3,buffer,needed,out outputLength) ||
          outputLength<4 || outputLength>needed){
        throw new InvalidOperationException("P0_TOKEN_QUERY_FAILED");
      }
      int count=Marshal.ReadInt32(buffer);
      int off=(int)Marshal.OffsetOf(typeof(TOKEN_PRIVILEGES_ONE),"Privileges");
      int stride=Marshal.SizeOf(typeof(LUID_AND_ATTRIBUTES));
      if(count<0 || count>2048 || off+(long)count*stride>outputLength){
        throw new InvalidOperationException("P0_TOKEN_LAYOUT_INVALID");
      }
      int[] result=new int[names.Length];
      for(int j=0;j<names.Length;j++){
        LUID target;
        if(!LookupPrivilegeValue(null,names[j],out target))
          throw new InvalidOperationException("P0_TOKEN_LOOKUP_FAILED");
        for(int i=0;i<count;i++){
          IntPtr ptr=IntPtr.Add(buffer,off+i*stride);
          LUID_AND_ATTRIBUTES p=(LUID_AND_ATTRIBUTES)Marshal.PtrToStructure(ptr,typeof(LUID_AND_ATTRIBUTES));
          if(p.Luid.LowPart==target.LowPart && p.Luid.HighPart==target.HighPart){
            result[j]=(p.Attributes&0x00000002)!=0?2:1;
            break;
          }
        }
      }
      return result;
    } finally {
      if(buffer!=IntPtr.Zero)Marshal.FreeHGlobal(buffer);
      if(token!=IntPtr.Zero)CloseHandle(token);
    }
  }
}
'@ -ErrorAction Stop

$names=@('SeBackupPrivilege','SeRestorePrivilege','SeSecurityPrivilege','SeTakeOwnershipPrivilege')
$state=[NexowireP0RecoveryToken]::ReadPrivileges($names)
if($state.Count -ne $names.Count){throw 'P0_TOKEN_INVALID_RESULT_COUNT'}
$privileges=[ordered]@{}
for($i=0;$i -lt $names.Count;$i++){
 $value=[int]$state[$i]
 if($value -lt 0 -or $value -gt 2){throw 'P0_TOKEN_INVALID_PRIVILEGE_STATE'}
 $privileges[$names[$i]]=[ordered]@{
   present=($value -gt 0)
   enabled=($value -eq 2)
 }
}
$admin=$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$system=($principal.Identity.User.Value -eq 'S-1-5-18')
$restorePresent=[bool]$privileges['SeRestorePrivilege'].present
$backupPresent=[bool]$privileges['SeBackupPrivilege'].present

[pscustomobject]@{
 schemaVersion=1
 mode='READ_ONLY_CURRENT_TOKEN_PRIVILEGES'
 isSystem=$system
 elevatedAdministratorMembership=$admin
 privilegeStates=$privileges
 # Presence does not imply enablement, nor access to protected files.
 backupAndRestorePrivilegesPresent=($backupPresent -and $restorePresent)
 restorePrivilegeEnabled=[bool]$privileges['SeRestorePrivilege'].enabled
 backupPrivilegeEnabled=[bool]$privileges['SeBackupPrivilege'].enabled
 enabledBackupRestorePrerequisites=(($admin -or $system) -and [bool]$privileges['SeRestorePrivilege'].enabled -and [bool]$privileges['SeBackupPrivilege'].enabled)
 # Even a privileged token is not evidence of a completed restore drill.
 canDemonstrateAdminRecoveryWithThisToken=$false
 # These outputs must never certify a production migration.
 privilegedRestoreAttempted=$false
 isolatedAclRestoreVerified=$false
 productionTaskRestoreVerified=$false
 protectedSecretsRestored=$false
 productionModified=$false
 authorizedToElevate=$false
 safeToRestoreProduction=$false
 safeToCutover=$false
}|ConvertTo-Json -Depth 5 -Compress
