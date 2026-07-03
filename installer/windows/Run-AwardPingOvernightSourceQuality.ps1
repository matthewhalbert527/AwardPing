param(
  [int]$Hours = 10,
  [int]$MaxAwards = 90,
  [int]$MinOpenSources = 75,
  [ValidateSet("safe", "full")]
  [string]$Safety = "full",
  [switch]$DryRun,
  [switch]$SkipCleanupTitles,
  [switch]$SkipAggregateFacts,
  [switch]$SkipForceAggregateFacts,
  [int]$MaxRestarts = 1
)

$ErrorActionPreference = "Stop"
$InstallRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$AppDir = Join-Path $InstallRoot "app"
$LogDir = Join-Path $InstallRoot "logs"
$LockPath = Join-Path $InstallRoot "overnight-source-quality.lock"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

function Test-OvernightSourceQualityLockActive {
  param([string]$Path)

  if (-not (Test-Path -LiteralPath $Path)) {
    return $false
  }

  try {
    $raw = Get-Content -LiteralPath $Path -Raw -ErrorAction Stop
    $match = [regex]::Match($raw, "pid=(\d+)")
    if ($match.Success) {
      $workerPid = [int]$match.Groups[1].Value
      $process = Get-CimInstance Win32_Process -Filter "ProcessId = $workerPid" -ErrorAction SilentlyContinue
      if ($process -and (
        $process.CommandLine -like "*Run-AwardPingOvernightSourceQuality.ps1*" -or
        $process.CommandLine -like "*run-overnight-source-quality-pass.mjs*"
      )) {
        return $true
      }
    }
  } catch {
    Write-Host "Could not inspect overnight source-quality lock; treating it as stale."
  }

  Write-Host "Removing stale AwardPing overnight source-quality lock."
  Remove-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
  return $false
}

if (Test-OvernightSourceQualityLockActive -Path $LockPath) {
  Write-Host "AwardPing overnight source-quality pass is already running. Skipping this launch."
  exit 0
}

$nodePath = (Get-Command node.exe -ErrorAction Stop).Source
$workerScript = Join-Path $AppDir "scripts\run-overnight-source-quality-pass.mjs"
if (-not (Test-Path -LiteralPath $workerScript)) {
  throw "Missing AwardPing overnight source-quality worker script: $workerScript"
}

$applyValue = -not $DryRun.IsPresent
$cleanupTitlesValue = -not $SkipCleanupTitles.IsPresent
$aggregateFactsValue = -not $SkipAggregateFacts.IsPresent
$forceAggregateFactsValue = $aggregateFactsValue -and (-not $SkipForceAggregateFacts.IsPresent)
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$logPath = Join-Path $LogDir "awardping-overnight-source-quality-$stamp.log"
$workerArgs = @(
  $workerScript,
  "--env",
  ".env.worker.local",
  "--hours=$Hours",
  "--max-awards=$MaxAwards",
  "--min-open-sources=$MinOpenSources",
  "--safety=$Safety",
  "--apply=$applyValue",
  "--cleanup-titles=$cleanupTitlesValue",
  "--aggregate-facts=$aggregateFactsValue",
  "--force-aggregate-facts=$forceAggregateFactsValue",
  "--stop-on-failure=false"
)

Write-Host "Running AwardPing overnight source-quality pass. Log: $logPath"
Set-Content -Path $LockPath -Value "pid=$PID started=$(Get-Date -Format o) log=$logPath hours=$Hours max_awards=$MaxAwards min_open_sources=$MinOpenSources safety=$Safety apply=$applyValue" -Encoding ASCII
$exitCode = 1
Set-Content -Path $logPath -Value "OVERNIGHT_SOURCE_QUALITY_START pid=$PID started=$(Get-Date -Format o) hours=$Hours max_awards=$MaxAwards min_open_sources=$MinOpenSources safety=$Safety apply=$applyValue cleanup_titles=$cleanupTitlesValue aggregate_facts=$aggregateFactsValue force_aggregate_facts=$forceAggregateFactsValue" -Encoding UTF8
try {
  $attempt = 0
  do {
    $attempt += 1
    if ($attempt -gt 1) {
      $waitSeconds = [Math]::Min(120, 20 * $attempt)
      Add-Content -Path $logPath -Value "OVERNIGHT_SOURCE_QUALITY_RESTART attempt=$attempt max_restarts=$MaxRestarts wait_seconds=$waitSeconds started=$(Get-Date -Format o)" -Encoding UTF8
      Start-Sleep -Seconds $waitSeconds
    }

    $previousErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
      & $nodePath @workerArgs 2>&1 | ForEach-Object {
        $line = [string]$_
        Write-Host $line
        Add-Content -Path $logPath -Value $line -Encoding UTF8
      }
    } finally {
      $ErrorActionPreference = $previousErrorActionPreference
    }
    $exitCode = $LASTEXITCODE
    Add-Content -Path $logPath -Value "OVERNIGHT_SOURCE_QUALITY_EXIT attempt=$attempt exit_code=$exitCode finished=$(Get-Date -Format o)" -Encoding UTF8
  } while ($exitCode -ne 0 -and $attempt -le $MaxRestarts)
} catch {
  Add-Content -Path $logPath -Value "OVERNIGHT_SOURCE_QUALITY_WRAPPER_ERROR message=$($_.Exception.Message) finished=$(Get-Date -Format o)" -Encoding UTF8
  throw
} finally {
  Remove-Item -LiteralPath $LockPath -Force -ErrorAction SilentlyContinue
}

exit $exitCode
