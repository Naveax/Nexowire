[CmdletBinding()]
param([switch]$Json)

$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSEdition -eq 'Core' -and -not $IsWindows) {
    throw 'WINDOWS_REQUIRED'
}

function Read-DiskReserve {
    param([string]$Path)
    # Advisory only: this never authorizes a migration or replaces its disk gate.
    $requiredGiB = 8
    try {
        if ([string]::IsNullOrWhiteSpace($Path)) { throw 'MISSING_PATH' }
        $root = [System.IO.Path]::GetPathRoot([System.IO.Path]::GetFullPath($Path))
        if ([string]::IsNullOrWhiteSpace($root)) { throw 'MISSING_DRIVE_ROOT' }
        $drive = New-Object System.IO.DriveInfo($root)
        if (-not $drive.IsReady) { throw 'DRIVE_NOT_READY' }
        $available = [long]$drive.AvailableFreeSpace
        return [pscustomobject]@{
            root = $root
            availableGiB = [math]::Round($available / 1GB, 2)
            recommendedReserveGiB = $requiredGiB
            recommendedReserveMet = [bool]($available -ge ($requiredGiB * 1GB))
            evidence = 'READ_ONLY_AVAILABLE_FREE_SPACE'
            advisoryOnly = $true
        }
    } catch {
        return [pscustomobject]@{
            root = $null
            availableGiB = $null
            recommendedReserveGiB = $requiredGiB
            recommendedReserveMet = $null
            evidence = 'UNKNOWN'
            advisoryOnly = $true
        }
    }
}

function ConvertTo-TaskResultHex {
    param([Parameter(Mandatory=$true)][long]$Result)
    # Task Scheduler records Win32/HRESULT-style unsigned 32-bit status codes.
    # Displaying a code is not proof of current Broker effect admission.
    $unsigned = [uint32]($Result -band [long]4294967295)
    return ('0x{0:X8}' -f $unsigned)
}

function Read-TaskState {
    param([Parameter(Mandatory=$true)][string]$Name)
    try {
        $task = Get-ScheduledTask -TaskName $Name -TaskPath '\' -ErrorAction Stop
        $info = $task | Get-ScheduledTaskInfo -ErrorAction Stop
        return [pscustomobject]@{
            name = $Name
            visibility = 'VISIBLE'
            state = [string]$task.State
            principal = [string]$task.Principal.UserId
            runLevel = [string]$task.Principal.RunLevel
            lastResult = [long]$info.LastTaskResult
            lastResultHex = ConvertTo-TaskResultHex -Result ([long]$info.LastTaskResult)
        }
    } catch {
        return [pscustomobject]@{
            name = $Name
            visibility = 'NOT_VISIBLE_OR_ABSENT'
            state = 'UNKNOWN'
            principal = $null
            runLevel = 'UNKNOWN'
            lastResult = $null
            lastResultHex = $null
        }
    }
}
function Read-LoopbackListener {
    param([int]$Port)
    try {
        $entries = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop |
            Where-Object { $_.LocalAddress -eq '127.0.0.1' -or $_.LocalAddress -eq '::1' })
        return [pscustomobject]@{ port=$Port; loopbackListeners=$entries.Count }
    } catch {
        return [pscustomobject]@{ port=$Port; loopbackListeners=0 }
    }
}

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
$elevated = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$result = [pscustomobject]@{
    schema = 1
    candidateVersion = '1.0.9-exp.0'
    evidence = 'READ_ONLY_LOCAL_OBSERVATION'
    observer = $identity.Name
    elevated = [bool]$elevated
    diskReserve = [pscustomobject]@{
        systemStateVolume = Read-DiskReserve -Path $env:ProgramData
        userStateVolume = Read-DiskReserve -Path $env:USERPROFILE
    }
    tasks = @(
        Read-TaskState -Name 'Nexowire Hub'
        Read-TaskState -Name 'Nexowire Native Agent'
        Read-TaskState -Name 'Nexowire Privileged Broker'
        Read-TaskState -Name 'Nexowire Hub Boot'
    )
    listeners = @(
        Read-LoopbackListener -Port 43110
        Read-LoopbackListener -Port 43112
    )
    fullCoreAccessVerified = $false
    trustedSystemHubAcceptance = 'NOT_RUN'
    brokerAuthenticatedEffectAcceptance = 'NOT_RUN'
    protectedSqliteAndDpapiAcceptance = 'NOT_RUN'
    revocationAndNoReplayAcceptance = 'NOT_RUN'
    warning = 'Task Running and a loopback listener do not attest elevated CORE effect admission.'
}
if ($Json) {
    $result | ConvertTo-Json -Depth 7 -Compress
} else {
    $result | Format-List
}
