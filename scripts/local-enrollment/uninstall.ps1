param(
    [Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{64}$')][string]$ExpectedManifestSha256,
    [Parameter(Mandatory=$true)][Guid]$ExpectedDeviceId,
    [switch]$Execute
)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest

# Separate opt-in service removal. Never reset grants, nonce claims, owner
# credentials, revocation markers or the existing Agent/Broker installation.
# Default is read-only. Removing service registration is not CORE approval.
if([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT){
    throw 'WINDOWS_ONLY'
}
function Assert-PlainPath([string]$path){
    $item=Get-Item -LiteralPath $path -Force -ErrorAction Stop
    while($null -ne $item){
        if(($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){
            throw 'REPARSE_POINT_DENIED'
        }
        if($item -is [IO.FileInfo]){$item=$item.Directory}else{$item=$item.Parent}
    }
}
$serviceName='NexowireLocalEnrollment'
$destination=Join-Path $env:ProgramFiles ('NexowireLocalEnrollment-'+$ExpectedManifestSha256.Substring(0,16))
$exe=Join-Path $destination 'Nexowire.LocalEnrollment.exe'
$expectedCommand='"'+$exe+'" --service'
$state=Join-Path $env:ProgramData 'NexowireLocalEnrollment'
$service=Get-CimInstance Win32_Service -Filter "Name='NexowireLocalEnrollment'" -ErrorAction Stop
if($null -eq $service){
    if($Execute){throw 'SERVICE_ABSENT_MANUAL_RECOVERY_REQUIRED'}
    [ordered]@{preflight='not-installed';servicePresent=$false;changed=$false;
        protectedStatePreserved=$true;runtimePreserved=$true}|ConvertTo-Json -Compress
    exit 0
}
if($service.PathName -cne $expectedCommand){
    throw 'SERVICE_BINARY_PATH_MISMATCH'
}
Assert-PlainPath $destination
Assert-PlainPath $exe
$requestFile=Join-Path $destination 'enrollment-request.json'
Assert-PlainPath $requestFile
if((Get-Item -LiteralPath $requestFile).Length -gt 16384){
    throw 'ENROLLMENT_REQUEST_TOO_LARGE'
}
$request=Get-Content -LiteralPath $requestFile -Raw -Encoding UTF8|ConvertFrom-Json
if('deviceId' -notin $request.PSObject.Properties.Name -or
    [Guid]$request.deviceId -ne $ExpectedDeviceId){
    throw 'DEVICE_ID_MISMATCH'
}
if(-not $Execute){
    [ordered]@{preflight='verified';servicePresent=$true;
        serviceName=$serviceName;deviceId=$ExpectedDeviceId.ToString();
        changed=$false;protectedStatePreserved=$true;runtimePreserved=$true}|ConvertTo-Json -Compress
    exit 0
}
# Require a real, already recorded local revoke. Uninstalling the service
# without revocation could leave a valid persistent grant reusable later.
$revoked=Join-Path $state 'revoked.json'
Assert-PlainPath $state
Assert-PlainPath $revoked
if($PSVersionTable.PSEdition -ne 'Desktop'){
    throw 'USE_WINDOWS_POWERSHELL_5_1_FOR_UNINSTALL'
}
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
$principal=[Security.Principal.WindowsPrincipal]::new($identity)
if(-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) -or
    -not [Environment]::UserInteractive){
    throw 'LOCAL_ADMIN_CONSOLE_REQUIRED'
}
$expectedText='REMOVE '+$ExpectedDeviceId.ToString('D')
$typed=Read-Host ('Type '+$expectedText+' to remove ONLY this opt-in service')
if($typed -cne $expectedText){throw 'OPERATOR_REJECTED_UNINSTALL'}
# Avoid attempting to remove a replaced service after the human confirmation.
$current=Get-CimInstance Win32_Service -Filter "Name='NexowireLocalEnrollment'" -ErrorAction Stop
if($null -eq $current -or $current.PathName -cne $expectedCommand){
    throw 'SERVICE_IDENTITY_CHANGED'
}
if($current.State -cne 'Stopped'){
    Stop-Service -Name $serviceName -ErrorAction Stop
    (Get-Service -Name $serviceName -ErrorAction Stop).WaitForStatus('Stopped',[TimeSpan]::FromSeconds(30))
}
& "$env:SystemRoot\System32\sc.exe" delete $serviceName | Out-Null
if($LASTEXITCODE -ne 0){throw 'SCM_DELETE_FAILED'}
[ordered]@{serviceDeleteRequested=$true;serviceName=$serviceName;deviceId=$ExpectedDeviceId.ToString();
    protectedStatePreserved=$true;runtimePreserved=$true;coreActivated=$false}|ConvertTo-Json -Compress
