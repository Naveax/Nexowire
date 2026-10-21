# P0 SOURCE-ONLY read-only import/updater/ancestor inspection.
# A list supplied by a caller is NOT independent evidence of complete imports.
[CmdletBinding()]
param(
 [Parameter(Mandatory=$true)][string]$ProtectedInstallRoot,
 [Parameter(Mandatory=$true)][string]$LauncherPath,
 [Parameter(Mandatory=$true)][string]$UpdaterPath,
 [string[]]$ImportedModulePaths=@()
)
$ErrorActionPreference='Stop'
if($env:OS -ne 'Windows_NT'){throw 'WINDOWS_ONLY'}
$root=[IO.Path]::GetFullPath($ProtectedInstallRoot).TrimEnd([IO.Path]::DirectorySeparatorChar,[IO.Path]::AltDirectorySeparatorChar)
$rootPrefix=$root+[IO.Path]::DirectorySeparatorChar
$lowTrustSids=@('S-1-1-0','S-1-5-11','S-1-5-32-545','S-1-5-4','S-1-5-7')
# WriteData/CreateFiles, Append/CreateDirectories, WriteEA, WriteAttributes,
# DELETE, DELETE_CHILD, WRITE_DAC, WRITE_OWNER plus generic write.
$writeMask=[int64](0x2 -bor 0x4 -bor 0x10 -bor 0x100 -bor 0x10000 -bor 0x40000 -bor 0x80000)
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
 kind='windows_core_broker_protected_tree_readonly_v1'
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
 protectedCompleteImageTreeAttested=$false
 elevatedCoreDispatchEnabled=$false
 productionReady=$false
} | ConvertTo-Json -Compress -Depth 8
