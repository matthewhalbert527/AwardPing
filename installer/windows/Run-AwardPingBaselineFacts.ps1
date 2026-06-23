param(
  [int]$Limit = 50000,
  [int]$MaxCalls = 50000,
  [string]$Model = "gemini-3.1-flash-lite",
  [decimal]$CostCapUsd = 10,
  [int]$MaxRestarts = 3,
  [switch]$Force
)

$ErrorActionPreference = "Stop"
$InstallRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$AppDir = Join-Path $InstallRoot "app"
$LogDir = Join-Path $InstallRoot "logs"
$LockPath = Join-Path $InstallRoot "baseline-facts-worker.lock"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

function Test-BaselineFactsLockActive {
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
        $process.CommandLine -like "*Run-AwardPingBaselineFacts.ps1*" -or
        $process.CommandLine -like "*backfill-baseline-facts.mjs*"
      )) {
        return $true
      }
    }
  } catch {
    Write-Host "Could not inspect baseline-facts worker lock; treating it as stale."
  }

  Write-Host "Removing stale AwardPing baseline-facts worker lock."
  Remove-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
  return $false
}

if (Test-BaselineFactsLockActive -Path $LockPath) {
  Write-Host "AwardPing baseline-facts worker is already running. Skipping this launch."
  exit 0
}

$nodePath = (Get-Command node.exe -ErrorAction Stop).Source
$workerScript = Join-Path $AppDir "scripts\backfill-baseline-facts.mjs"
if (-not (Test-Path -LiteralPath $workerScript)) {
  throw "Missing AwardPing baseline-facts worker script: $workerScript"
}

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$logPath = Join-Path $LogDir "awardping-baseline-facts-$stamp.log"
$workerArgs = @(
  $workerScript,
  "--env",
  ".env.worker.local",
  "--ai-provider=gemini",
  "--model=$Model",
  "--limit=$Limit",
  "--max-calls=$MaxCalls",
  "--gemini-api-daily-cost-cap-usd=$CostCapUsd"
)
if ($Force) {
  $workerArgs += "--force=true"
}

Write-Host "Running AwardPing baseline page-info extraction. Log: $logPath"
Set-Content -Path $LockPath -Value "pid=$PID started=$(Get-Date -Format o) log=$logPath model=$Model limit=$Limit max_calls=$MaxCalls cost_cap_usd=$CostCapUsd" -Encoding ASCII
$exitCode = 1
Set-Content -Path $logPath -Value "BASELINE_FACTS_WORKER_START pid=$PID started=$(Get-Date -Format o) limit=$Limit max_calls=$MaxCalls model=$Model cost_cap_usd=$CostCapUsd force=$Force" -Encoding UTF8
try {
  $attempt = 0
  do {
    $attempt += 1
    if ($attempt -gt 1) {
      $waitSeconds = [Math]::Min(60, 10 * $attempt)
      Add-Content -Path $logPath -Value "BASELINE_FACTS_WORKER_RESTART attempt=$attempt max_restarts=$MaxRestarts wait_seconds=$waitSeconds started=$(Get-Date -Format o)" -Encoding UTF8
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
    Add-Content -Path $logPath -Value "BASELINE_FACTS_WORKER_EXIT attempt=$attempt exit_code=$exitCode finished=$(Get-Date -Format o)" -Encoding UTF8
  } while ($exitCode -ne 0 -and $attempt -le $MaxRestarts)
} catch {
  Add-Content -Path $logPath -Value "BASELINE_FACTS_WORKER_WRAPPER_ERROR message=$($_.Exception.Message) finished=$(Get-Date -Format o)" -Encoding UTF8
  throw
} finally {
  Remove-Item -LiteralPath $LockPath -Force -ErrorAction SilentlyContinue
}
exit $exitCode
