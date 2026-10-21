# Authorized, isolated Windows VM acceptance. Does not modify ProgramData.
# No VM flag -> refuses before creating files or running any ACL mutation.
[CmdletBinding()]
param([switch]$AuthorizedVmFixture)
$ErrorActionPreference='Stop'
if(-not $AuthorizedVmFixture){throw 'ACL_VM_EXPLICIT_AUTHORIZATION_REQUIRED'}
if($env:OS -ne 'Windows_NT'){throw 'ACL_VM_WINDOWS_ONLY'}
$machine=Get-CimInstance -ClassName Win32_ComputerSystem -ErrorAction Stop
if(-not $machine -or
  (($machine.Model+' '+$machine.Manufacturer) -notmatch
  '(?i)(Virtual Machine|VMware|VirtualBox|KVM|QEMU|Hyper-V|Parallels|Xen)')){
  throw 'ACL_VM_HYPERVISOR_NOT_ATTESTED'
}
# This is a model indication, not a trusted external hypervisor attestation.
# Mandatory manual operator authorization still required.
$script=Join-Path $PSScriptRoot 'test-isolated-broker-acl-rollback.ps1'
if(-not (Test-Path -LiteralPath $script -PathType Leaf)){
  throw 'ACL_VM_FIXTURE_SCRIPT_MISSING'
}
$powershell='C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'
$cases=@(@{name='normal';inject=$false},@{name='rollback-injected';inject=$true})
$results=@()
foreach($case in $cases){
  $arguments=@('-NoLogo','-NoProfile','-NonInteractive','-File',$script)
  if($case.inject){$arguments+= '-SimulateFailure'}
  $raw=@(& $powershell @arguments)
  if($LASTEXITCODE -ne 0 -or $raw.Count -ne 1){throw 'ACL_VM_FIXTURE_FAILED'}
  $r=ConvertFrom-Json -InputObject $raw[0] -ErrorAction Stop
  if(-not $r.reproducedBroadModify -or -not $r.originalAclRestored -or
    -not $r.fixtureRemoved -or $r.productionAclModified -or
    $r.productionAccepted -or $r.serviceOrTaskTouched){
    throw 'ACL_VM_FIXTURE_ROLLBACK_UNVERIFIED'
  }
  if($case.inject -and $r.status -cne 'simulated-failure'){
    throw 'ACL_VM_FAILURE_INJECTION_NOT_OBSERVED'
  }
  if(-not $case.inject -and
    ($r.status -cne 'isolated-hardened' -or $r.broadModifyAfterHardening)){
    throw 'ACL_VM_HARDENING_NOT_OBSERVED'
  }
  $results += [pscustomobject]@{
    scenario=$case.name
    fixtureRollbackVerified=$true
    fixtureCleaned=$true
    privilegedProductionChange=$false
  }
}
[pscustomobject]@{
  status='ISOLATED_VM_FIXTURE_ONLY'
  guestModelIndicatesVirtualization=$true
  cases=$results
  productionApproved=$false
  installedBrokerAclVerified=$false
  guardianAttested=$false
  uacBypassed=$false
} | ConvertTo-Json -Compress -Depth 4
