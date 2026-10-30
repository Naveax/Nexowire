param(
    [Parameter(Mandatory=$true)][string]$BundleDirectory,
    [Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{64}$')][string]$ExpectedManifestSha256,
    [Parameter(Mandatory=$true)][string]$EnrollmentRequestFile,
    [Parameter(Mandatory=$true)][string]$AgentIdentityFile,
    [Parameter(Mandatory=$true)][Guid]$ExpectedDeviceId,
    [Parameter(Mandatory=$true)][Guid[]]$AllowedDeviceIds,
    [ValidateSet('tpm','software')][string]$KeyProvider='tpm',
    [switch]$PreflightOnly
)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
function Assert-PlainPath([string]$path){
    $item=Get-Item -LiteralPath $path -Force
    while($null -ne $item){
        if(($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'REPARSE_POINT_DENIED'}
        if($item -is [IO.FileInfo]){$item=$item.Directory}else{$item=$item.Parent}
    }
}
function New-ProtectedDirectory([string]$path){
    if(Test-Path -LiteralPath $path){throw 'INSTALL_DESTINATION_ALREADY_EXISTS'}
    $acl=[Security.AccessControl.DirectorySecurity]::new()
    $acl.SetSecurityDescriptorSddlForm('O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)')
    $dir=[IO.DirectoryInfo]::new($path)
    $dir.Create($acl)
    Assert-PlainPath $path
    $actual=Get-Acl -LiteralPath $path
    if(-not $actual.AreAccessRulesProtected){throw 'INSTALL_ACL_NOT_PROTECTED'}
    foreach($rule in $actual.Access){
        $sid=$rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
        if($sid -notin @('S-1-5-18','S-1-5-32-544') -or $rule.AccessControlType -ne 'Allow' -or
            $rule.FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl){throw 'INSTALL_ACL_INVALID'}
    }
    if(@($actual.Access).Count -ne 2){throw 'INSTALL_ACL_INVALID'}
}
# Preflight is read-only, including against the original Agent identity.
if($AllowedDeviceIds.Count -ne 2 -or @($AllowedDeviceIds|Select-Object -Unique).Count -ne 2 -or
    $ExpectedDeviceId -notin $AllowedDeviceIds){throw 'EXACT_TWO_DEVICE_ALLOWLIST_REQUIRED'}
Assert-PlainPath $BundleDirectory
Assert-PlainPath $EnrollmentRequestFile
Assert-PlainPath $AgentIdentityFile
$manifestFile=Join-Path $BundleDirectory 'manifest.json'
Assert-PlainPath $manifestFile
if((Get-Item -LiteralPath $manifestFile).Length -gt 1048576){throw 'MANIFEST_TOO_LARGE'}
if((Get-FileHash -LiteralPath $manifestFile -Algorithm SHA256).Hash.ToLowerInvariant() -cne $ExpectedManifestSha256){throw 'MANIFEST_HASH_MISMATCH'}
$manifest=Get-Content -LiteralPath $manifestFile -Raw -Encoding UTF8|ConvertFrom-Json
if($manifest.version -ne 1 -or $manifest.kind -cne 'nexowire-local-enrollment-opt-in' -or
    $manifest.source -cnotmatch '^[a-f0-9]{40}$' -or @($manifest.files).Count -lt 1 -or @($manifest.files).Count -gt 2000){throw 'INVALID_MANIFEST'}
if((Get-Item -LiteralPath $EnrollmentRequestFile).Length -gt 16384 -or
    (Get-Item -LiteralPath $AgentIdentityFile).Length -gt 16384){throw 'IDENTITY_INPUT_TOO_LARGE'}
$requestText=[IO.File]::ReadAllText((Resolve-Path -LiteralPath $EnrollmentRequestFile).Path)
$request=$requestText|ConvertFrom-Json
$identity=Get-Content -LiteralPath $AgentIdentityFile -Raw -Encoding UTF8|ConvertFrom-Json
$owner=[Security.Principal.WindowsIdentity]::GetCurrent()
if([Guid]$identity.id -ne $ExpectedDeviceId -or [Guid]$request.deviceId -ne $ExpectedDeviceId -or
    $request.ownerSid -cne $owner.User.Value){throw 'LOCAL_OWNER_DEVICE_MISMATCH'}
$runtime=Join-Path (Resolve-Path -LiteralPath $BundleDirectory).Path 'runtime'
Assert-PlainPath $runtime
$seen=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
$total=0L
foreach($row in $manifest.files){
    if($row.path -cnotmatch '^[A-Za-z0-9._/-]+$' -or $row.path.StartsWith('/') -or
        @($row.path.Split('/')|Where-Object {$_ -in @('','.','..')}).Count -gt 0 -or
        -not $seen.Add([string]$row.path) -or $row.sha256 -cnotmatch '^[a-f0-9]{64}$' -or
        $row.bytes -lt 0 -or $row.bytes -gt 134217728){throw 'INVALID_MANIFEST_ENTRY'}
    $sourceFile=Join-Path $runtime $row.path
    Assert-PlainPath $sourceFile
    if((Get-Item -LiteralPath $sourceFile).Length -ne $row.bytes -or
        (Get-FileHash -LiteralPath $sourceFile -Algorithm SHA256).Hash.ToLowerInvariant() -cne $row.sha256){throw 'RUNTIME_HASH_MISMATCH'}
    $total+=$row.bytes
}
if($total -gt 536870912 -or -not $seen.Contains('Nexowire.LocalEnrollment.exe')){throw 'INVALID_RUNTIME_SIZE_OR_ENTRYPOINT'}
if(Get-Service -Name 'NexowireLocalEnrollment' -ErrorAction SilentlyContinue){throw 'EXISTING_SERVICE_REQUIRES_REVIEWED_UPGRADE'}
$state=Join-Path $env:ProgramData 'NexowireLocalEnrollment'
if(Test-Path -LiteralPath $state){throw 'EXISTING_ENROLLMENT_REQUIRES_EXPLICIT_RECOVERY'}
$destination=Join-Path $env:ProgramFiles ('NexowireLocalEnrollment-'+$ExpectedManifestSha256.Substring(0,16))
if(Test-Path -LiteralPath $destination){throw 'INSTALL_DESTINATION_ALREADY_EXISTS'}
if($PreflightOnly){[ordered]@{preflight='passed';deviceId=$ExpectedDeviceId.ToString();files=$seen.Count;
    manifestSha256=$ExpectedManifestSha256;installed=$false}|ConvertTo-Json -Compress;exit 0}
if($PSVersionTable.PSEdition -ne 'Desktop'){throw 'USE_WINDOWS_POWERSHELL_5_1_FOR_INSTALL'}
if(-not [Security.Principal.WindowsPrincipal]::new($owner).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){
    throw 'RUN_REVIEWED_INSTALLER_WITH_STANDARD_LOCAL_UAC'
}
New-ProtectedDirectory $destination
$createdService=$false
try{
    foreach($row in $manifest.files){
        $target=Join-Path $destination $row.path
        $parent=[IO.Path]::GetDirectoryName($target)
        if(-not(Test-Path -LiteralPath $parent)){[void](New-Item -ItemType Directory -Path $parent)}
        [IO.File]::Copy((Join-Path $runtime $row.path),$target,$false)
        Assert-PlainPath $target
        if((Get-Item -LiteralPath $target).Length -ne $row.bytes -or
            (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant() -cne $row.sha256){throw 'PROTECTED_RUNTIME_POSTCOPY_MISMATCH'}
    }
    $protectedRequest=Join-Path $destination 'enrollment-request.json'
    [IO.File]::WriteAllText($protectedRequest,$requestText,[Text.UTF8Encoding]::new($false))
    $exe=Join-Path $destination 'Nexowire.LocalEnrollment.exe'
    & $exe '--enroll' $protectedRequest $KeyProvider
    if($LASTEXITCODE -ne 0){throw 'VISIBLE_LOCAL_ENROLLMENT_NOT_COMPLETED'}
    & $exe '--inspect'
    if($LASTEXITCODE -ne 0){throw 'LOCAL_ENROLLMENT_POSTCHECK_FAILED'}
    [void](New-Service -Name 'NexowireLocalEnrollment' -DisplayName 'Nexowire Local Enrollment' -StartupType Automatic -BinaryPathName ('"'+$exe+'" --service'))
    $createdService=$true
    Start-Service -Name 'NexowireLocalEnrollment'
    $service=Get-Service -Name 'NexowireLocalEnrollment'
    $service.WaitForStatus('Running',[TimeSpan]::FromSeconds(30))
    [ordered]@{installed=$true;service=$service.Name;deviceId=$ExpectedDeviceId.ToString();
        manifestSha256=$ExpectedManifestSha256;coreActivated=$false}|ConvertTo-Json -Compress
}catch{
    # Never roll back an operation journal, old Agent/Broker or a revocation.
    # Keep protected evidence and any grant/key after partial installation.
    if($createdService){
        $found=Get-CimInstance Win32_Service -Filter "Name='NexowireLocalEnrollment'"
        if($null -ne $found -and $found.PathName -ceq ('"'+$exe+'" --service')){
            Stop-Service -Name 'NexowireLocalEnrollment' -ErrorAction SilentlyContinue
            & "$env:SystemRoot\System32\sc.exe" delete 'NexowireLocalEnrollment'|Out-Null
        }
    }
    throw
}
