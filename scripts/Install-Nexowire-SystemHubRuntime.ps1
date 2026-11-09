#requires -Version 5.1
<#
  AI-01 offline SYSTEM Hub runtime staging. Plan is read-only.
  Install does NOT modify tasks, running Hubs, DPAPI, or SQLite.
  Source must be a complete unpacked pinned release, not a Git worktree.
#>
[CmdletBinding()]
param(
  [ValidateSet('Plan','Install')][string]$Action='Plan',
  [string]$SourceDirectory='',
  [string]$ExpectedTreeSha256=''
)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$target='C:\Program Files\Nexowire\SystemHub'
$parent=Split-Path -Parent $target
$node='C:\Program Files\nodejs\node.exe'
function Get-RuntimeTree([string]$root) {
  $base=[IO.Path]::GetFullPath($root).TrimEnd('\')
  if($base.StartsWith('\\')){throw 'AI01_SOURCE_PATH_UNTRUSTED'}
  if(-not (Test-Path -LiteralPath $base -PathType Container)){throw 'AI01_SOURCE_DIRECTORY_MISSING'}
  $items=@(Get-Item -LiteralPath $base -Force)
  $items+=@(Get-ChildItem -LiteralPath $base -Recurse -Force -ErrorAction Stop)
  if($items.Count -gt 30000){throw 'AI01_RUNTIME_TREE_LIMIT'}
  $files=New-Object 'System.Collections.Generic.List[object]'
  foreach($item in $items){
    if(($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'AI01_RUNTIME_REPARSE_POINT'}
    if(-not $item.PSIsContainer){
      $relative=$item.FullName.Substring($base.Length+1).Replace('\','/')
      $files.Add([pscustomobject]@{relative=$relative;full=$item.FullName;bytes=[long]$item.Length})
    }
  }
  foreach($needed in @('package.json','package-lock.json','dist/src/cli.js')){
    if(@($files | Where-Object {$_.relative -ceq $needed}).Count -ne 1){
      throw ('AI01_RUNTIME_FILE_MISSING: '+$needed)
    }
  }
  if(-not @($files | Where-Object {$_.relative.StartsWith('node_modules/',[StringComparison]::Ordinal)}).Count){
    throw 'AI01_RUNTIME_NODE_MODULES_MISSING'
  }
  $lines=New-Object 'System.Collections.Generic.List[string]'
  foreach($file in @($files | Sort-Object relative)){
    $hash=(Get-FileHash -LiteralPath $file.full -Algorithm SHA256).Hash.ToLowerInvariant()
    $lines.Add($file.relative+'  '+$hash)
  }
  $raw=[Text.Encoding]::UTF8.GetBytes([string]::Join([char]10,$lines))
  $sha=[Security.Cryptography.SHA256]::Create()
  try{$digest=([BitConverter]::ToString($sha.ComputeHash($raw))).Replace('-','').ToLowerInvariant()}
  finally{$sha.Dispose()}
  return [pscustomobject]@{
    root=$base;digest=$digest;files=$files.Count
    size=($files | Measure-Object -Property bytes -Sum).Sum
  }
}
function Assert-PrivateTree([string]$root){
  $allow=@{
    'S-1-5-18'=$true
    'S-1-5-32-544'=$true
    'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464'=$true
  }
  $items=@(Get-Item -LiteralPath $root -Force)
  $items+=@(Get-ChildItem -LiteralPath $root -Force -Recurse -ErrorAction Stop)
  $writeMask=[int64]0x40000000 -bor [int64]0x10000000 -bor [int64]0x00010000 -bor [int64]0x00040000 -bor [int64]0x00080000 -bor [int64]0x00000002 -bor [int64]0x00000004
  foreach($item in $items){
    if(($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'AI01_TARGET_REPARSE_POINT'}
    $acl=Get-Acl -LiteralPath $item.FullName
    if(-not $allow.ContainsKey($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value)){
      throw 'AI01_TARGET_OWNER_UNTRUSTED'
    }
    foreach($ace in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])){
      if($ace.AccessControlType -eq 'Allow' -and
         ($ace.FileSystemRights -band $writeMask) -ne 0 -and
         -not $allow.ContainsKey($ace.IdentityReference.Value)){
        throw 'AI01_TARGET_WRITABLE_BY_UNTRUSTED_ACCOUNT'
      }
    }
  }
}
$issues=New-Object 'System.Collections.Generic.List[string]'
if(-not (Test-Path -LiteralPath $node -PathType Leaf)){
  $issues.Add('SIGNED_NODE_MISSING')
}else{
  $signature=Get-AuthenticodeSignature -LiteralPath $node
  if($signature.Status -ne 'Valid' -or
     $null -eq $signature.SignerCertificate -or
     $signature.SignerCertificate.Subject -cne 'CN=OpenJS Foundation, O=OpenJS Foundation, L=San Francisco, S=California, C=US'){
    $issues.Add('SIGNED_NODE_UNVERIFIED')
  }
}
if(Test-Path -LiteralPath $target){$issues.Add('TARGET_ALREADY_EXISTS')}
$tree=$null
if([string]::IsNullOrWhiteSpace($SourceDirectory)){
  $issues.Add('SOURCE_DIRECTORY_REQUIRED')
}else{
  try{$tree=Get-RuntimeTree $SourceDirectory}catch{$issues.Add($_.Exception.Message)}
}
if($ExpectedTreeSha256 -notmatch '^[a-fA-F0-9]{64}$'){
  $issues.Add('PINNED_TREE_SHA256_REQUIRED')
}elseif($null -ne $tree -and $tree.digest -cne $ExpectedTreeSha256.ToLowerInvariant()){
  $issues.Add('PINNED_TREE_SHA256_MISMATCH')
}
if($null -ne $tree){
  $disk=Get-PSDrive -Name C -ErrorAction Stop
  if([long]$disk.Free -lt ([long]$tree.size + 536870912)){
    $issues.Add('INSUFFICIENT_STAGING_DISK')
  }
}
$plan=[pscustomobject]@{
  action=$Action;target=$target
  executable=$node;cli=($target+'\dist\src\cli.js')
  files=if($tree){$tree.files}else{0}
  bytes=if($tree){$tree.size}else{0}
  treeSha256=if($tree){$tree.digest}else{$null}
  blockers=@($issues);ready=($issues.Count -eq 0)
}
if($Action -eq 'Plan'){
  $plan|ConvertTo-Json -Depth 4
  return
}
if($issues.Count -gt 0){throw ('AI01_INSTALL_PREFLIGHT_BLOCKED: '+($issues -join ', '))}
$id=[Security.Principal.WindowsIdentity]::GetCurrent()
$principal=New-Object Security.Principal.WindowsPrincipal($id)
if(-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){
  throw 'AI01_ADMINISTRATOR_TOKEN_REQUIRED'
}
# Preserve the exact first failing phase on a real administrator install.
# The previous aggregate child exit code made the Work-PC failure opaque.
$phase='CHECK_PARENT'
$staging=$null
try {
  if(Test-Path -LiteralPath $parent){
    $parentItem=Get-Item -LiteralPath $parent -Force
    if(($parentItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'AI01_PARENT_REPARSE_POINT'}
  }else{
    New-Item -ItemType Directory -Path $parent -ErrorAction Stop | Out-Null
    $phase='SET_NEW_PARENT_DACL'
    # This is a newly created empty root. Strip inherited ACEs rather than
    # relaxing the private-tree validator for Creator Owner / Users entries.
    & 'C:\Windows\System32\icacls.exe' $parent '/inheritance:r' '/grant:r' '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
    if($LASTEXITCODE -ne 0){throw 'AI01_NEW_PARENT_DACL_FAILED'}
    $phase='PIN_NEW_PARENT_OWNER'
    # Freshly created protected parents must never retain the interactive
    # administrator's SID as owner. Never take ownership of existing roots.
    & 'C:\Windows\System32\icacls.exe' $parent '/setowner' '*S-1-5-32-544' | Out-Null
    if($LASTEXITCODE -ne 0){throw 'AI01_NEW_PARENT_OWNER_PIN_FAILED'}
  }
  $phase='VERIFY_PARENT_ACL'
  # An untrusted parent makes even a properly ACL'd subtree replaceable.
  Assert-PrivateTree $parent

  $phase='CREATE_PRIVATE_STAGE'
  $staging=Join-Path $parent ('.ai01-stage-'+[guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $staging -ErrorAction Stop | Out-Null

  $phase='SET_PRIVATE_STAGE_DACL'
  & 'C:\Windows\System32\icacls.exe' $staging '/inheritance:r' '/grant:r' '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
  if($LASTEXITCODE -ne 0){throw 'AI01_STAGE_DACL_FAILED'}

  $phase='COPY_RUNTIME'
  Get-ChildItem -LiteralPath $tree.root -Force | Copy-Item -Destination $staging -Recurse -Force -ErrorAction Stop

  $phase='VERIFY_STAGED_HASH'
  $copied=Get-RuntimeTree $staging
  if($copied.digest -cne $tree.digest){throw 'AI01_STAGE_HASH_MISMATCH'}

  $phase='PIN_STAGED_OWNER'
  # The copy can create new files owned by the elevated *user*, not the
  # Administrators group. Set owner only inside the verified private stage.
  & 'C:\Windows\System32\icacls.exe' $staging '/setowner' '*S-1-5-32-544' '/T' | Out-Null
  if($LASTEXITCODE -ne 0){throw 'AI01_STAGE_OWNER_PIN_FAILED'}

  $phase='VERIFY_STAGED_ACL'
  Assert-PrivateTree $staging

  $phase='PROMOTE_RUNTIME'
  if(Test-Path -LiteralPath $target){throw 'AI01_TARGET_RACE'}
  Move-Item -LiteralPath $staging -Destination $target -ErrorAction Stop
  [pscustomobject]@{
    status='STAGED_NOT_ACTIVATED';target=$target
    cli=($target+'\dist\src\cli.js');node=$node
    treeSha256=$copied.digest;taskChanged=$false;sqliteChanged=$false
  }|ConvertTo-Json -Depth 4
}catch{
  $reason=$_.Exception.Message
  # Do not recursively clean a stage that became a junction/reparse point.
  if($null -ne $staging -and (Test-Path -LiteralPath $staging)){
    $stageItem=Get-Item -LiteralPath $staging -Force -ErrorAction SilentlyContinue
    if($null -ne $stageItem -and
       ($stageItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0){
      Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
  throw ('AI01_INSTALL_PHASE_'+$phase+': '+$reason)
}
