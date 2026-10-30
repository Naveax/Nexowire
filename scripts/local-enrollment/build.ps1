param([Parameter(Mandatory=$true)][string]$OutputDirectory)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$repo=(Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$dirty=@(& git -C $repo status --porcelain)
if($LASTEXITCODE -ne 0 -or $dirty.Count -ne 0){throw 'CLEAN_SOURCE_CHECKOUT_REQUIRED'}
$source=(& git -C $repo rev-parse HEAD).Trim()
if($LASTEXITCODE -ne 0){throw 'SOURCE_IDENTITY_REQUIRED'}
$sourceTree=(& git -C $repo rev-parse 'HEAD^{tree}').Trim()
if($LASTEXITCODE -ne 0){throw 'SOURCE_TREE_REQUIRED'}
if(Test-Path -LiteralPath $OutputDirectory){throw 'OUTPUT_MUST_NOT_EXIST'}
$output=[IO.Path]::GetFullPath($OutputDirectory)
if($output.StartsWith($repo+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){
    throw 'BUILD_OUTPUT_MUST_BE_OUTSIDE_SOURCE_CHECKOUT'
}
[void](New-Item -ItemType Directory -Path $output)
$runtime=Join-Path $output 'runtime'
& dotnet publish (Join-Path $repo 'native\windows-local-enrollment\Nexowire.LocalEnrollment.csproj') -c Release -r win-x64 --self-contained true -o $runtime --nologo
if($LASTEXITCODE -ne 0){throw 'LOCAL_ENROLLMENT_PUBLISH_FAILED'}
$rows=@(Get-ChildItem -LiteralPath $runtime -Recurse -File | Sort-Object FullName | ForEach-Object {
    if(($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'REPARSE_POINT_DENIED'}
    [ordered]@{path=$_.FullName.Substring($runtime.Length+1).Replace('\','/');bytes=$_.Length;
        sha256=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()}
})
$manifest=[ordered]@{version=1;kind='nexowire-local-enrollment-opt-in';source=$source;sourceTree=$sourceTree;files=$rows}
$file=Join-Path $output 'manifest.json'
[IO.File]::WriteAllText($file,($manifest|ConvertTo-Json -Depth 5),[Text.UTF8Encoding]::new($false))
[ordered]@{manifestSha256=(Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant();
    files=$rows.Count;output=$output;installed=$false}|ConvertTo-Json -Compress
