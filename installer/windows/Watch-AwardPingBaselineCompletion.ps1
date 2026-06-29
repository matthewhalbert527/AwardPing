param(
  [string]$InstallRoot = "",
  [int]$Limit = 50000,
  [int]$BatchLimit = 250,
  [int]$IntervalMinutes = 5,
  [switch]$Install
)

$ErrorActionPreference = "Stop"

function Resolve-InstallRoot {
  param([string]$RequestedRoot)

  if (-not [string]::IsNullOrWhiteSpace($RequestedRoot)) {
    return (Resolve-Path -LiteralPath $RequestedRoot).Path
  }

  $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
  if (Test-Path (Join-Path $scriptDir "Run-AwardPingVisualSnapshots.ps1")) {
    return $scriptDir
  }

  return (Join-Path $env:LOCALAPPDATA "AwardPingWorker")
}

$InstallRoot = Resolve-InstallRoot -RequestedRoot $InstallRoot
$LogDir = Join-Path $InstallRoot "logs"
$WatchdogLog = Join-Path $LogDir "awardping-baseline-watchdog.log"
$VisualLockPath = Join-Path $InstallRoot "visual-worker.lock"
$RunScript = Join-Path $InstallRoot "Run-AwardPingVisualSnapshots.ps1"
$CoverageScript = Join-Path $InstallRoot "app\scripts\read-visual-snapshot-coverage.mjs"

function Write-WatchdogLog {
  param([string]$Message)

  New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
  $line = "{0} {1}" -f (Get-Date -Format "o"), $Message
  Add-Content -Path $WatchdogLog -Value $line -Encoding UTF8
}

function Install-WatchdogTask {
  $targetScript = Join-Path $InstallRoot "Watch-AwardPingBaselineCompletion.ps1"
  $currentScript = $PSCommandPath

  if (-not (Test-Path -LiteralPath $currentScript)) {
    throw "Could not locate watchdog script path."
  }

  if ($currentScript -ne $targetScript) {
    Copy-Item -LiteralPath $currentScript -Destination $targetScript -Force
  }

  $taskName = "AwardPing Baseline Completion Watchdog"
  $action = New-ScheduledTaskAction `
    -Execute "powershell.exe" `
    -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$targetScript`" -InstallRoot `"$InstallRoot`" -Limit $Limit -BatchLimit $BatchLimit"
  $trigger = New-ScheduledTaskTrigger `
    -Once `
    -At (Get-Date).AddMinutes(1) `
    -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes) `
    -RepetitionDuration (New-TimeSpan -Days 3650)
  $settings = New-ScheduledTaskSettingsSet `
    -MultipleInstances IgnoreNew `
    -StartWhenAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Minutes ([Math]::Max(2, $IntervalMinutes - 1)))
  $settings.DisallowStartIfOnBatteries = $false
  $settings.StopIfGoingOnBatteries = $false
  $settings.Hidden = $true

  Register-ScheduledTask `
    -TaskName $taskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Description "Restarts AwardPing missing visual baseline completion if it stops before actionable baseline coverage is complete." `
    -Force | Out-Null

  Write-WatchdogLog "installed task=$taskName interval_minutes=$IntervalMinutes install_root=$InstallRoot batch_limit=$BatchLimit"
}

function Test-ProcessMatches {
  param(
    [object]$Process,
    [string[]]$Patterns
  )

  $commandLine = [string]$Process.CommandLine
  if ([string]::IsNullOrWhiteSpace($commandLine)) {
    return $false
  }

  foreach ($pattern in $Patterns) {
    if ($commandLine -like $pattern) {
      return $true
    }
  }

  return $false
}

function Test-ProcessHasVisualWorkerAncestor {
  param(
    [object]$Process,
    [hashtable]$ProcessesById
  )

  $current = $Process
  $visited = @{}
  $runScriptPattern = "*$RunScript*"

  while ($current) {
    if ($visited.ContainsKey($current.ProcessId)) {
      return $false
    }
    $visited[$current.ProcessId] = $true

    $commandLine = [string]$current.CommandLine
    if (
      -not [string]::IsNullOrWhiteSpace($commandLine) -and
      $commandLine -like $runScriptPattern -and
      $commandLine -like "*-CompleteMissingBaselines*"
    ) {
      return $true
    }

    if (-not $current.ParentProcessId -or -not $ProcessesById.ContainsKey($current.ParentProcessId)) {
      return $false
    }

    $current = $ProcessesById[$current.ParentProcessId]
  }

  return $false
}

function Test-VisualWorkerActive {
  $patterns = @(
    "*Run-AwardPingVisualSnapshots.ps1*",
    "*source:visual-snapshots*",
    "*capture-visual-snapshots.mjs*"
  )

  if (Test-Path -LiteralPath $VisualLockPath) {
    try {
      $raw = Get-Content -Path $VisualLockPath -Raw -ErrorAction Stop
      $match = [regex]::Match($raw, "pid=(\d+)")
      if ($match.Success) {
        $workerPid = [int]$match.Groups[1].Value
        $process = Get-CimInstance Win32_Process -Filter "ProcessId = $workerPid" -ErrorAction SilentlyContinue
        if ($process -and (Test-ProcessMatches -Process $process -Patterns $patterns)) {
          return $true
        }
      }
    } catch {
      Write-WatchdogLog "lock_inspection_failed message=$($_.Exception.Message)"
    }

    Write-WatchdogLog "removing_stale_visual_lock path=$VisualLockPath"
    Remove-Item -LiteralPath $VisualLockPath -Force -ErrorAction SilentlyContinue
  }

  $currentPid = $PID
  $processes = @(Get-CimInstance Win32_Process -Filter "name = 'node.exe' OR name = 'powershell.exe' OR name = 'cmd.exe'")
  $processesById = @{}
  foreach ($process in $processes) {
    $processesById[$process.ProcessId] = $process
  }

  $activeProcess = $processes |
    Where-Object {
      $_.ProcessId -ne $currentPid -and
      (
        (Test-ProcessMatches -Process $_ -Patterns $patterns) -or
        (Test-ProcessHasVisualWorkerAncestor -Process $_ -ProcessesById $processesById)
      )
    } |
    Select-Object -First 1

  return [bool]$activeProcess
}

function Get-DatabaseBaselineCompletionStatus {
  $result = [ordered]@{
    Available = $false
    Error = $null
    Source = "database"
    Complete = $false
    Loaded = $null
    Existing = $null
    Missing = $null
    ActionableMissing = $null
    KnownBrokenMissing = $null
  }

  if (-not (Test-Path -LiteralPath $CoverageScript)) {
    $result.Error = "Missing coverage script: $CoverageScript"
    return [pscustomobject]$result
  }

  try {
    $nodePath = (Get-Command node.exe -ErrorAction Stop).Source
    $raw = & $nodePath $CoverageScript --env .env.worker.local --limit $Limit 2>&1
    $exitCode = $LASTEXITCODE
    if ($exitCode -ne 0) {
      $result.Error = "Coverage script exited with code $exitCode"
      return [pscustomobject]$result
    }

    $text = ($raw | ForEach-Object { [string]$_ }) -join "`n"
    $jsonLine = (($text -split "`n") | Where-Object { $_.Trim().StartsWith("{") } | Select-Object -Last 1)
    if (-not $jsonLine) {
      $result.Error = "Coverage script returned no JSON"
      return [pscustomobject]$result
    }

    $parsed = $jsonLine | ConvertFrom-Json
    if (-not $parsed.available) {
      $result.Error = if ($parsed.error) { [string]$parsed.error } else { "Coverage script unavailable" }
      return [pscustomobject]$result
    }

    $result.Available = $true
    $result.Complete = [bool]$parsed.complete
    $result.Loaded = [int]$parsed.sourceCount
    $result.Existing = [int]$parsed.snapshotSourceCount
    $result.Missing = [int]$parsed.missingCount
    $result.ActionableMissing = [int]$parsed.actionableMissingCount
    $result.KnownBrokenMissing = [int]$parsed.knownBrokenMissingCount
    return [pscustomobject]$result
  } catch {
    $result.Error = $_.Exception.Message
    return [pscustomobject]$result
  }
}

function Get-BaselineCompletionStatus {
  $result = [ordered]@{
    Source = "log"
    DatabaseAvailable = $false
    DatabaseError = $null
    Complete = $false
    LatestLog = $null
    FinishLine = $null
    Loaded = $null
    Existing = $null
    Missing = $null
    ActionableMissing = $null
    KnownBrokenMissing = $null
  }

  $databaseStatus = Get-DatabaseBaselineCompletionStatus
  if ($databaseStatus.Available) {
    $result.Source = "database"
    $result.DatabaseAvailable = $true
    $result.Complete = $databaseStatus.Complete
    $result.Loaded = $databaseStatus.Loaded
    $result.Existing = $databaseStatus.Existing
    $result.Missing = $databaseStatus.Missing
    $result.ActionableMissing = $databaseStatus.ActionableMissing
    $result.KnownBrokenMissing = $databaseStatus.KnownBrokenMissing
    return [pscustomobject]$result
  }

  $result.DatabaseError = $databaseStatus.Error

  $latestLog = Get-ChildItem -Path $LogDir -Filter "awardping-visual-complete-baselines-*.log" -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1

  if (-not $latestLog) {
    return [pscustomobject]$result
  }

  $result.LatestLog = $latestLog.FullName
  $tail = Get-Content -Path $latestLog.FullName -Tail 400 -ErrorAction SilentlyContinue |
    ForEach-Object { ([string]$_) -replace "`0", "" }
  $finishLine = $tail |
    Where-Object { $_ -match "BASELINE_COVERAGE finish loaded=\d+ existing=\d+ missing=\d+ actionable_missing=\d+ known_broken_missing=\d+" } |
    Select-Object -Last 1

  if (-not $finishLine) {
    return [pscustomobject]$result
  }

  $result.FinishLine = $finishLine
  $match = [regex]::Match(
    $finishLine,
    "loaded=(\d+) existing=(\d+) missing=(\d+) actionable_missing=(\d+) known_broken_missing=(\d+)"
  )

  if ($match.Success) {
    $result.Loaded = [int]$match.Groups[1].Value
    $result.Existing = [int]$match.Groups[2].Value
    $result.Missing = [int]$match.Groups[3].Value
    $result.ActionableMissing = [int]$match.Groups[4].Value
    $result.KnownBrokenMissing = [int]$match.Groups[5].Value
    $result.Complete = $result.ActionableMissing -eq 0
  }

  return [pscustomobject]$result
}

function Start-BaselineCompletion {
  if (-not (Test-Path -LiteralPath $RunScript)) {
    throw "Missing baseline runner script: $RunScript"
  }

  $arguments = @(
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    $RunScript,
    "-All",
    "-Limit",
    [string]$Limit,
    "-CompleteMissingBaselines",
    "-CompleteMissingBatchLimit",
    [string]$BatchLimit
  )

  $process = Start-Process `
    -FilePath "powershell.exe" `
    -ArgumentList $arguments `
    -WorkingDirectory $InstallRoot `
    -WindowStyle Hidden `
    -PassThru

  Write-WatchdogLog "restarted_baseline_completion pid=$($process.Id) limit=$Limit batch_limit=$BatchLimit"
}

function Disable-WatchdogTask {
  param([string]$Reason)

  $taskName = "AwardPing Baseline Completion Watchdog"
  try {
    Disable-ScheduledTask -TaskName $taskName -ErrorAction Stop | Out-Null
    Write-WatchdogLog "disabled task=$taskName reason=$Reason"
  } catch {
    Write-WatchdogLog "disable_failed task=$taskName reason=$Reason message=$($_.Exception.Message)"
  }
}

if ($Install) {
  Install-WatchdogTask
  exit 0
}

$status = Get-BaselineCompletionStatus
if ($status.Complete) {
  Write-WatchdogLog "complete source=$($status.Source) loaded=$($status.Loaded) existing=$($status.Existing) missing=$($status.Missing) actionable_missing=0 known_broken_missing=$($status.KnownBrokenMissing) latest_log=$($status.LatestLog)"
  Disable-WatchdogTask -Reason "baseline_complete"
  exit 0
}

if (Test-VisualWorkerActive) {
  Write-WatchdogLog "active no_restart source=$($status.Source) loaded=$($status.Loaded) existing=$($status.Existing) missing=$($status.Missing) actionable_missing=$($status.ActionableMissing) known_broken_missing=$($status.KnownBrokenMissing) latest_log=$($status.LatestLog) db_error=$($status.DatabaseError)"
  exit 0
}

Write-WatchdogLog "inactive_incomplete restarting source=$($status.Source) loaded=$($status.Loaded) existing=$($status.Existing) missing=$($status.Missing) actionable_missing=$($status.ActionableMissing) known_broken_missing=$($status.KnownBrokenMissing) latest_log=$($status.LatestLog) db_error=$($status.DatabaseError)"
Start-BaselineCompletion
