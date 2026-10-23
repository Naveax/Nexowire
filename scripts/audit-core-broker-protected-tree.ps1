# P0 SOURCE-ONLY read-only import/updater/ancestor inspection.
# A list supplied by a caller is NOT independent evidence of complete imports.
[CmdletBinding(DefaultParameterSetName='Envelope')]
param(
 [Parameter(Mandatory=$true,ParameterSetName='Envelope')][string]$EvidenceRequestBase64,
 [Parameter(Mandatory=$true,ParameterSetName='Legacy')][string]$ProtectedInstallRoot,
 [Parameter(Mandatory=$true,ParameterSetName='Legacy')][string]$LauncherPath,
 [Parameter(Mandatory=$true,ParameterSetName='Legacy')][string]$UpdaterPath,
 [Parameter(Mandatory=$true,ParameterSetName='Legacy')][string[]]$ImportedModulePaths
)
$ErrorActionPreference='Stop'
if($env:OS -ne 'Windows_NT'){throw 'WINDOWS_ONLY'}
# A single exact UTF-8 JSON envelope avoids pwsh -File's argument-array
# binding differences on hosted Windows, including DOS 8.3 temp paths.
# Unrecognized fields, missing imports or incomplete absolute paths fail.
# The original #700 QA clients use -File legacy named parameters.
# Retain a READ-ONLY compatibility surface, never a second trust policy:
# both invocation types feed the exact same strict, versioned validation.
if($PSCmdlet.ParameterSetName -eq 'Legacy'){
 $request=@{
  version=1
  protectedInstallRoot=$ProtectedInstallRoot
  launcherPath=$LauncherPath
  updaterPath=$UpdaterPath
  importedModulePaths=@($ImportedModulePaths)
 }
}else{
 if($EvidenceRequestBase64.Length -lt 8 -or $EvidenceRequestBase64.Length -gt 90000){
  throw 'BROKER_TREE_REQUEST_ENVELOPE_INVALID_LENGTH'
 }
 try{
  $json=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($EvidenceRequestBase64))
  $request=ConvertFrom-Json -InputObject $json -AsHashtable -ErrorAction Stop
 }catch{throw 'BROKER_TREE_REQUEST_ENVELOPE_INVALID_ENCODING_OR_JSON'}
}
$expectedFields=@('version','protectedInstallRoot','launcherPath','updaterPath','importedModulePaths')
if($request -isnot [System.Collections.IDictionary] -or
   $request.Count -ne $expectedFields.Count -or
   @($request.Keys | Where-Object {$_ -notin $expectedFields}).Count -gt 0 -or
   @($expectedFields | Where-Object {-not $request.ContainsKey($_)}).Count -gt 0 -or
   # ConvertFrom-Json -AsHashtable returns an Int64 for JSON integer 1,
   # while legacy named-parameter mode constructs Int32 1. Explicitly
   # reject JSON string "1", boolean true and floating-point 1.0/1e0.
   -not (($request.version -is [long] -or $request.version -is [int]) -and
     $request.version -eq 1) -or
   $request.protectedInstallRoot -isnot [string] -or
   $request.launcherPath -isnot [string] -or
   $request.updaterPath -isnot [string] -or
   $request.importedModulePaths -isnot [array] -or
   $request.importedModulePaths.Count -gt 128 -or
   $request.importedModulePaths.Count -lt 1){
 throw 'BROKER_TREE_REQUEST_SCHEMA_INVALID'
}
# Never coerce JSON imported-module values to strings before validation:
# PowerShell [string[]] would silently accept booleans/numbers and turn
# malformed requests into filesystem paths.
foreach($imported in $request.importedModulePaths){
 if($imported -isnot [string]){throw 'BROKER_TREE_REQUEST_SCHEMA_INVALID'}
}
$ProtectedInstallRoot=[string]$request.protectedInstallRoot
$LauncherPath=[string]$request.launcherPath
$UpdaterPath=[string]$request.updaterPath
$ImportedModulePaths=[string[]]$request.importedModulePaths
foreach($rawPath in @($ProtectedInstallRoot,$LauncherPath,$UpdaterPath)+$ImportedModulePaths){
 if($rawPath -isnot [string] -or [string]::IsNullOrWhiteSpace($rawPath) -or
    -not [IO.Path]::IsPathFullyQualified($rawPath) -or
    $rawPath.Contains('*') -or $rawPath.Contains('?')){
   throw 'BROKER_TREE_REQUEST_PATH_INVALID'
 }
}

$root=[IO.Path]::GetFullPath($ProtectedInstallRoot).TrimEnd([IO.Path]::DirectorySeparatorChar,[IO.Path]::AltDirectorySeparatorChar)
$rootPrefix=$root+[IO.Path]::DirectorySeparatorChar
$lowTrustSids=@('S-1-1-0','S-1-5-11','S-1-5-32-545','S-1-5-4','S-1-5-7')
# WriteData/CreateFiles, Append/CreateDirectories, WriteEA, WriteAttributes,
# DELETE, DELETE_CHILD, WRITE_DAC, WRITE_OWNER plus generic write.
# Include FILE_DELETE_CHILD (0x40): a low-trust parent directory ACE with
# DeleteSubdirectoriesAndFiles can remove a child even if its file DACL
# does not grant DELETE. A DACL scan remains read-only/source-only evidence.
$writeMask=[int64](0x2 -bor 0x4 -bor 0x10 -bor 0x40 -bor 0x100 -bor 0x10000 -bor 0x40000 -bor 0x80000)
$evidence=@()
$seen=@{}
function Observe-Path([string]$requested,[bool]$isDirectory){
 $path=[IO.Path]::GetFullPath($requested)
 if($seen.ContainsKey($path)){return}
 $seen[$path]=$true
 $item=$null;$acl=$null;$errorName=''
 $unsafe=@()
 try{
   $item=Get-Item -LiteralPath $path -Force -ErrorAction Stop
   if([bool]$item.PSIsContainer -ne $isDirectory){throw 'UNEXPECTED_FILE_TYPE'}
   if($isDirectory){
      $acl=[IO.FileSystemAclExtensions]::GetAccessControl([IO.DirectoryInfo]$item)
   }else{
      $acl=[IO.FileSystemAclExtensions]::GetAccessControl([IO.FileInfo]$item)
   }
   foreach($ace in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])){
     if($ace.AccessControlType -ne 'Allow'){continue}
     $sid=try{$ace.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value}catch{$ace.IdentityReference.Value}
     if($sid -in $lowTrustSids -and (([int64]$ace.FileSystemRights -band $writeMask) -ne 0)){
       $unsafe+= $sid
     }
   }
 }catch{$errorName=$_.Exception.GetType().Name;$item=$null;$acl=$null}
 $script:evidence+=,[ordered]@{
   path=$path
   isDirectory=$isDirectory
   evidenceAvailable=($null -ne $acl)
   providerError=$errorName
   reparsePointDetected=$(if($null -ne $item){[bool](($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)}else{$null})
   aclProtected=$(if($null -ne $acl){[bool]$acl.AreAccessRulesProtected}else{$null})
   broadLowTrustWriteFound=$(if($null -ne $acl){$unsafe.Count -gt 0}else{$null})
 }
}
# PowerShell function scopes can differ; return results with a script-scoped list
# rather than trusting a Boolean caller input.
function In-Root([string]$p){
 $resolved=[IO.Path]::GetFullPath($p)
 return [string]::Equals($resolved,$root,[StringComparison]::OrdinalIgnoreCase) -or
    $resolved.StartsWith($rootPrefix,[StringComparison]::OrdinalIgnoreCase)
}
$required=@($LauncherPath,$UpdaterPath)+@($ImportedModulePaths)
$badPaths=@()
$resolvedFiles=@()
foreach($entry in $required){
 if([string]::IsNullOrWhiteSpace($entry)){ $badPaths+= '<empty>';continue }
 try{
   $absolute=[IO.Path]::GetFullPath($entry)
   if(-not (In-Root $absolute)){$badPaths+=$absolute;continue}
   $resolvedFiles+= $absolute
   Observe-Path $absolute $false
   $parent=[IO.Path]::GetDirectoryName($absolute)
   while(-not [string]::IsNullOrWhiteSpace($parent)){
     Observe-Path $parent $true
     if([string]::Equals($parent,[IO.Path]::GetPathRoot($parent),[StringComparison]::OrdinalIgnoreCase)){break}
     $next=[IO.Path]::GetDirectoryName($parent)
     if($next -eq $parent){break}
     $parent=$next
   }
 }catch{$badPaths+= $entry}
}
# Even a correctly inspected file set is not proof that the set is complete.
# A protected first-party signed manifest and independent runtime import
# enumeration are required but not implemented in this read-only audit.
$allEvidencePresent=($badPaths.Count -eq 0) -and ($evidence.Count -gt 0) -and
  (@($evidence | Where-Object {-not $_.evidenceAvailable}).Count -eq 0)
$anyUnsafe=@($evidence | Where-Object {
 $_.broadLowTrustWriteFound -eq $true -or $_.reparsePointDetected -eq $true
}).Count -gt 0
[ordered]@{
 kind='windows_core_broker_protected_tree_readonly_v2'
 requestEnvelopeVersion=1
 requestInputKind=$(if($PSCmdlet.ParameterSetName -eq 'Legacy'){'legacy-named-readonly'}else{'envelope-v1-readonly'})
 acceptedInputPaths=@($ProtectedInstallRoot,$LauncherPath,$UpdaterPath)+@($ImportedModulePaths)
 protectedRoot=$root
 inputsInsideRoot=($badPaths.Count -eq 0)
 rejectedOutOfRootPaths=@($badPaths)
 requestedImportsCount=$ImportedModulePaths.Count
 inspectedFilesCount=$resolvedFiles.Count
 inspectedEntries=@($evidence)
 allInspectedPathsHaveAclEvidence=[bool]$allEvidencePresent
 anyInspectedPathUnsafe=[bool]$anyUnsafe
 importListIndependentlyEnumerated=$false
 signedImportManifestVerified=$false
 updaterReleaseRollbackVerified=$false
 publisherOfEveryImportVerified=$false
 pidCreationFiletimeVerified=$false
 processDupHandleBoundaryVerified=$false
 # DACL listing is not effective access-check against an installed token.
 # Complete transitive loaded-import discovery requires signed manifest /
 # independent OS loader inventory, not a caller-provided subset.
 nativeEffectiveLowPrivilegeAccessCheckCompleted=$false
 transitiveImportsIndependentlyEnumerated=$false
 protectedCompleteImageTreeAttested=$false
 elevatedCoreDispatchEnabled=$false
 productionReady=$false
} | ConvertTo-Json -Compress -Depth 8
