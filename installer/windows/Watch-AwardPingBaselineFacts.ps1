param(
  [string]$InstallRoot = "",
  [int]$Limit = 50000,
  [int]$MaxCalls = 50000,
  [string]$Model = "gemini-2.5-flash-lite",
  [string]$BatchMode = "batch",
  [int]$BatchMaxRequests = 250,
  [int]$BatchParallelJobs = 4,
  [int]$BatchPollSeconds = 30,
  [int]$DirectCatchupThreshold = 1000,
  [decimal]$CostCapUsd = 10,
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
  if (Test-Path (Join-Path $scriptDir "Run-AwardPingBaselineFacts.ps1")) {
    return $scriptDir
  }

  return (Join-Path $env:LOCALAPPDATA "AwardPingWorker")
}

$InstallRoot = Resolve-InstallRoot -RequestedRoot $InstallRoot
$LogDir = Join-Path $InstallRoot "logs"
$WatchdogLog = Join-Path $LogDir "awardping-baseline-facts-watchdog.log"
$RunScript = Join-Path $InstallRoot "Run-AwardPingBaselineFacts.ps1"
$AppReportsDir = Join-Path $InstallRoot "app\reports"
$LockPath = Join-Path $InstallRoot "baseline-facts-worker.lock"
$DatabaseStatusScript = Join-Path $InstallRoot "app\scripts\read-baseline-facts-status.mjs"
$AggregateScript = Join-Path $InstallRoot "app\scripts\aggregate-award-baseline-facts.mjs"
$AggregateMarkerPath = Join-Path $LogDir "awardping-award-facts-aggregate.marker"

function Write-WatchdogLog {
  param([string]$Message)

  New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
  $line = "{0} {1}" -f (Get-Date -Format "o"), $Message
  Add-Content -Path $WatchdogLog -Value $line -Encoding UTF8
}

function Install-WatchdogTask {
  $targetScript = Join-Path $InstallRoot "Watch-AwardPingBaselineFacts.ps1"
  $targetRunScript = Join-Path $InstallRoot "Run-AwardPingBaselineFacts.ps1"
  $currentScript = $PSCommandPath
  $currentDir = Split-Path -Parent $currentScript
  $sourceRunScript = Join-Path $currentDir "Run-AwardPingBaselineFacts.ps1"

  if (-not (Test-Path -LiteralPath $currentScript)) {
    throw "Could not locate baseline-facts watchdog script path."
  }
  if (-not (Test-Path -LiteralPath $sourceRunScript)) {
    throw "Could not locate baseline-facts run script beside watchdog: $sourceRunScript"
  }

  if ($currentScript -ne $targetScript) {
    Copy-Item -LiteralPath $currentScript -Destination $targetScript -Force
  }
  if ($sourceRunScript -ne $targetRunScript) {
    Copy-Item -LiteralPath $sourceRunScript -Destination $targetRunScript -Force
  }

  $taskName = "AwardPing Baseline Facts Watchdog"
  $action = New-ScheduledTaskAction `
    -Execute "powershell.exe" `
    -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$targetScript`" -InstallRoot `"$InstallRoot`" -Limit $Limit -MaxCalls $MaxCalls -Model `"$Model`" -BatchMode `"$BatchMode`" -BatchMaxRequests $BatchMaxRequests -BatchParallelJobs $BatchParallelJobs -BatchPollSeconds $BatchPollSeconds -DirectCatchupThreshold $DirectCatchupThreshold -CostCapUsd $CostCapUsd"
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
    -Description "Restarts AwardPing Gemini baseline page-info extraction if it stops before source-page facts are complete." `
    -Force | Out-Null

  Write-WatchdogLog "installed task=$taskName interval_minutes=$IntervalMinutes install_root=$InstallRoot model=$Model mode=$BatchMode max_calls=$MaxCalls cost_cap_usd=$CostCapUsd batch_max_requests=$BatchMaxRequests batch_parallel_jobs=$BatchParallelJobs direct_catchup_threshold=$DirectCatchupThreshold"
}

function Test-BaselineFactsWorkerActive {
  if (Test-Path -LiteralPath $LockPath) {
    try {
      $raw = Get-Content -LiteralPath $LockPath -Raw -ErrorAction Stop
      $match = [regex]::Match($raw, "pid=(\d+)")
      if ($match.Success) {
        $workerPid = [int]$match.Groups[1].Value
        $process = Get-CimInstance Win32_Process -Filter "ProcessId = $workerPid" -ErrorAction SilentlyContinue
        if ($process -and (
          $process.CommandLine -like "*Run-AwardPingBaselineFacts.ps1*" -or
          $process.CommandLine -like "*backfill-baseline-facts.mjs*"
        )) {
          return $true
        }
      }
    } catch {
      Write-WatchdogLog "lock_inspection_failed message=$($_.Exception.Message)"
    }

    Write-WatchdogLog "removing_stale_baseline_facts_lock path=$LockPath"
    Remove-Item -LiteralPath $LockPath -Force -ErrorAction SilentlyContinue
  }

  $currentPid = $PID
  $activeProcess = Get-CimInstance Win32_Process -Filter "name = 'node.exe' OR name = 'powershell.exe'" |
    Where-Object {
      $_.ProcessId -ne $currentPid -and
      $_.CommandLine -and
      $_.CommandLine -like "*backfill-baseline-facts.mjs*"
    } |
    Select-Object -First 1

  return [bool]$activeProcess
}

function Read-JsonIfExists {
  param([string]$Path)

  if (-not $Path -or -not (Test-Path -LiteralPath $Path)) {
    return $null
  }

  try {
    return Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
  } catch {
    return $null
  }
}

function Get-IntProperty {
  param(
    [object]$Object,
    [string]$Name
  )

  if (-not $Object) {
    return 0
  }

  $property = $Object.PSObject.Properties[$Name]
  if (-not $property) {
    return 0
  }

  $number = 0
  if ([int]::TryParse([string]$property.Value, [ref]$number)) {
    return $number
  }

  return 0
}

function Get-BaselineFactsStatus {
  $result = [ordered]@{
    Source = "local_report"
    Complete = $false
    Drained = $false
    PausedForCostCapToday = $false
    LatestReport = $null
    Loaded = 0
    Processed = 0
    Extracted = 0
    SkippedExisting = 0
    SkippedIneligible = 0
    Failed = 0
    StopReason = $null
  }

  $latestReport = Get-ChildItem -Path $AppReportsDir -Filter "baseline-facts-*.json" -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -ne "baseline-facts-latest.json" } |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
  if (-not $latestReport) {
    return [pscustomobject]$result
  }

  $report = Read-JsonIfExists -Path $latestReport.FullName
  if (-not $report) {
    return [pscustomobject]$result
  }

  $loaded = Get-IntProperty -Object $report -Name "loaded_baselines"
  $extracted = Get-IntProperty -Object $report -Name "extracted"
  $skippedExisting = Get-IntProperty -Object $report -Name "skipped_existing"
  $skippedIneligible = Get-IntProperty -Object $report -Name "skipped_ineligible"
  $failed = Get-IntProperty -Object $report -Name "failed"
  $processed = $extracted + $skippedExisting + $skippedIneligible
  $stopReason = [string]$report.stop_reason
  $startedDay = if ($report.started_at) { ([DateTime]$report.started_at).ToLocalTime().ToString("yyyy-MM-dd") } else { "" }
  $today = (Get-Date).ToString("yyyy-MM-dd")

  $result.LatestReport = $latestReport.FullName
  $result.Loaded = $loaded
  $result.Processed = $processed
  $result.Extracted = $extracted
  $result.SkippedExisting = $skippedExisting
  $result.SkippedIneligible = $skippedIneligible
  $result.Failed = $failed
  $result.StopReason = $stopReason
  $result.Complete = $loaded -gt 0 -and $processed -ge $loaded -and $failed -eq 0
  $result.Drained = $loaded -gt 0 -and ($processed + $failed) -ge $loaded
  $result.PausedForCostCapToday =
    $stopReason -eq "gemini_api_cost_cap_reached" -and
    $startedDay -eq $today

  return [pscustomobject]$result
}

function Get-BaselineFactsStatusFromDatabase {
  if (-not (Test-Path -LiteralPath $DatabaseStatusScript)) {
    return $null
  }

  try {
    $nodePath = (Get-Command node.exe -ErrorAction Stop).Source
    $raw = & $nodePath $DatabaseStatusScript "--env" ".env.worker.local" 2>$null
    if (-not $raw) {
      return $null
    }

    $status = ($raw -join "`n") | ConvertFrom-Json
    if (-not $status.available) {
      Write-WatchdogLog "database_status_unavailable message=$($status.error)"
      return $null
    }

    return [pscustomobject]([ordered]@{
      Source = "database"
      Complete = [bool]$status.complete
      Drained = [bool]$status.drained
      PausedForCostCapToday = [bool]$status.pausedForCostCapToday
      LatestReport = [string]$status.latestReport
      Loaded = [int]$status.loaded
      Processed = [int]$status.processed
      Extracted = [int]$status.extracted
      SkippedExisting = [int]$status.skippedExisting
      SkippedIneligible = [int]$status.skippedIneligible
      Failed = [int]$status.failed
      StopReason = [string]$status.stopReason
    })
  } catch {
    Write-WatchdogLog "database_status_failed message=$($_.Exception.Message)"
    return $null
  }
}

function Start-BaselineFacts {
  if (-not (Test-Path -LiteralPath $RunScript)) {
    throw "Missing baseline-facts runner script: $RunScript"
  }

  $effectiveBatchMode = Get-RestartBatchMode -Status $status
  $arguments = @(
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    $RunScript,
    "-Limit",
    [string]$Limit,
    "-MaxCalls",
    [string]$MaxCalls,
    "-Model",
    $Model,
    "-BatchMode",
    $effectiveBatchMode,
    "-BatchMaxRequests",
    [string]$BatchMaxRequests,
    "-BatchParallelJobs",
    [string]$BatchParallelJobs,
    "-BatchPollSeconds",
    [string]$BatchPollSeconds,
    "-CostCapUsd",
    [string]$CostCapUsd
  )

  $process = Start-Process `
    -FilePath "powershell.exe" `
    -ArgumentList $arguments `
    -WorkingDirectory $InstallRoot `
    -WindowStyle Hidden `
    -PassThru

  Write-WatchdogLog "restarted_baseline_facts pid=$($process.Id) limit=$Limit model=$Model mode=$effectiveBatchMode configured_mode=$BatchMode max_calls=$MaxCalls cost_cap_usd=$CostCapUsd batch_max_requests=$BatchMaxRequests batch_parallel_jobs=$BatchParallelJobs"
}

function Get-RestartBatchMode {
  param([object]$Status)

  $loaded = if ($Status) { [int]$Status.Loaded } else { 0 }
  $processed = if ($Status) { [int]$Status.Processed } else { 0 }
  $remaining = [Math]::Max(0, $loaded - $processed)
  if ($BatchMode -eq "batch" -and $remaining -le $DirectCatchupThreshold) {
    return "immediate"
  }
  return $BatchMode
}

function Start-AwardFactsAggregate {
  param(
    [string]$Reason,
    [string]$StatusKey
  )

  $marker = "$Reason|$StatusKey"
  if ((Test-Path -LiteralPath $AggregateMarkerPath) -and (Get-Content -LiteralPath $AggregateMarkerPath -Raw -ErrorAction SilentlyContinue).Trim() -eq $marker) {
    Write-WatchdogLog "aggregate_already_started reason=$Reason status_key=$StatusKey"
    return
  }

  if (-not (Test-Path -LiteralPath $AggregateScript)) {
    Write-WatchdogLog "aggregate_missing reason=$Reason path=$AggregateScript"
    return
  }

  $nodePath = (Get-Command node.exe -ErrorAction Stop).Source
  $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $outLog = Join-Path $LogDir "awardping-award-facts-aggregate-$stamp.log"
  $errLog = Join-Path $LogDir "awardping-award-facts-aggregate-$stamp.err.log"
  $arguments = @(
    $AggregateScript,
    "--env",
    ".env.worker.local",
    "--limit=all",
    "--apply=true",
    "--force=false"
  )

  $process = Start-Process `
    -FilePath $nodePath `
    -ArgumentList $arguments `
    -WorkingDirectory (Join-Path $InstallRoot "app") `
    -WindowStyle Hidden `
    -RedirectStandardOutput $outLog `
    -RedirectStandardError $errLog `
    -PassThru

  Set-Content -LiteralPath $AggregateMarkerPath -Value $marker -Encoding ASCII
  Write-WatchdogLog "started_award_facts_aggregate reason=$Reason pid=$($process.Id) stdout=$outLog stderr=$errLog"
}

function Get-ProgressAggregateStatusKey {
  param([object]$Status)

  if (-not $Status) {
    return $null
  }

  $processed = [int]$Status.Processed
  if ($processed -lt 500) {
    return $null
  }

  $bucket = [Math]::Floor($processed / 500)
  return "$($Status.LatestReport)|progress_bucket=$bucket"
}

if ($Install) {
  Install-WatchdogTask
  exit 0
}

$status = Get-BaselineFactsStatusFromDatabase
if (-not $status) {
  $status = Get-BaselineFactsStatus
}

if ($status.Complete) {
  Write-WatchdogLog "complete source=$($status.Source) latest_report=$($status.LatestReport) loaded=$($status.Loaded) processed=$($status.Processed) failed=$($status.Failed)"
  Start-AwardFactsAggregate -Reason "baseline_facts_complete" -StatusKey $status.LatestReport
  exit 0
}

if ($status.Drained) {
  Write-WatchdogLog "drained_with_failures source=$($status.Source) latest_report=$($status.LatestReport) loaded=$($status.Loaded) processed=$($status.Processed) failed=$($status.Failed)"
  Start-AwardFactsAggregate -Reason "baseline_facts_drained" -StatusKey "$($status.LatestReport)|failed=$($status.Failed)"
  exit 0
}

if ($status.PausedForCostCapToday) {
  Write-WatchdogLog "paused_cost_cap_today source=$($status.Source) latest_report=$($status.LatestReport) processed=$($status.Processed)/$($status.Loaded) failed=$($status.Failed)"
  Start-AwardFactsAggregate -Reason "baseline_facts_cost_cap" -StatusKey $status.LatestReport
  exit 0
}

if (Test-BaselineFactsWorkerActive) {
  $progressAggregateStatusKey = Get-ProgressAggregateStatusKey -Status $status
  if ($progressAggregateStatusKey) {
    Start-AwardFactsAggregate -Reason "baseline_facts_progress" -StatusKey $progressAggregateStatusKey
  }
  Write-WatchdogLog "active no_restart source=$($status.Source) latest_report=$($status.LatestReport) processed=$($status.Processed)/$($status.Loaded) failed=$($status.Failed)"
  exit 0
}

Write-WatchdogLog "inactive_incomplete restarting source=$($status.Source) latest_report=$($status.LatestReport) processed=$($status.Processed)/$($status.Loaded) failed=$($status.Failed) stop_reason=$($status.StopReason)"
Start-BaselineFacts
