param([Parameter(Mandatory=$true)][string]$OutputDirectory)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$repo=(Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
if(Test-Path -LiteralPath $OutputDirectory){throw 'OUTPUT_MUST_NOT_EXIST'}
$output=[IO.Path]::GetFullPath($OutputDirectory)
[void](New-Item -ItemType Directory -Path $output)
$runtime=Join-Path $output 'runtime'
& dotnet publish (Join-Path $repo 'native\windows-local-enrollment\Nexowire.LocalEnrollment.csproj') -c Release -r win-x64 --self-contained true -o $runtime --nologo
if($LASTEXITCODE -ne 0){throw 'LOCAL_ENROLLMENT_PUBLISH_FAILED'}
$rows=@(Get-ChildItem -LiteralPath $runtime -Recurse -File | Sort-Object FullName | ForEach-Object {
    if(($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'REPARSE_POINT_DENIED'}
    [ordered]@{path=$_.FullName.Substring($runtime.Length+1).Replace('\','/');bytes=$_.Length;
        sha256=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()}
})
$source=(& git -C $repo rev-parse HEAD).Trim()
if($LASTEXITCODE -ne 0){throw 'SOURCE_IDENTITY_REQUIRED'}
$manifest=[ordered]@{version=1;kind='nexowire-local-enrollment-opt-in';source=$source;files=$rows}
$file=Join-Path $output 'manifest.json'
[IO.File]::WriteAllText($file,($manifest|ConvertTo-Json -Depth 5),[Text.UTF8Encoding]::new($false))
[ordered]@{manifestSha256=(Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant();
    files=$rows.Count;output=$output;installed=$false}|ConvertTo-Json -Compress
