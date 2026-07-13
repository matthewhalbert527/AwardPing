param(
  [string]$InstallRoot = "",
  [int]$IntervalMinutes = 60,
  [int]$VisualReviewLimit = 250,
  [int]$VisualReviewBatchSize = 25,
  [int]$ReconciliationLimit = 250,
  [int]$PageAuditLimit = 250,
  [int]$PageAuditBatchSize = 50,
  [switch]$Install
)

$ErrorActionPreference = "Stop"
$TaskName = "AwardPing Downstream Queue Pipeline"

function Resolve-InstallRoot {
  param([string]$RequestedRoot)

  if (-not [string]::IsNullOrWhiteSpace($RequestedRoot)) {
    return [System.IO.Path]::GetFullPath($RequestedRoot)
  }

  $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
  if (Test-Path (Join-Path $scriptDir "app")) {
    return $scriptDir
  }

  return (Join-Path $env:LOCALAPPDATA "AwardPingWorker")
}

$InstallRoot = Resolve-InstallRoot -RequestedRoot $InstallRoot
$LogDir = Join-Path $InstallRoot "logs"
$LockPath = Join-Path $InstallRoot "downstream-queue-pipeline.lock"
$AppDir = Join-Path $InstallRoot "app"

function Write-PipelineLog {
  param([string]$Message)

  New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
  Add-Content -LiteralPath (Join-Path $LogDir "awardping-downstream-queue-pipeline.log") -Value ("{0} {1}" -f (Get-Date -Format "o"), $Message) -Encoding UTF8
}

function Install-PipelineTask {
  $targetScript = Join-Path $InstallRoot "Run-AwardPingDownstreamQueues.ps1"
  $currentScript = $PSCommandPath
  if (-not (Test-Path -LiteralPath $currentScript)) {
    throw "Could not locate the downstream queue pipeline script."
  }
  if ($currentScript -ne $targetScript) {
    Copy-Item -LiteralPath $currentScript -Destination $targetScript -Force
  }

  $action = New-ScheduledTaskAction `
    -Execute "powershell.exe" `
    -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$targetScript`" -InstallRoot `"$InstallRoot`" -VisualReviewLimit $VisualReviewLimit -VisualReviewBatchSize $VisualReviewBatchSize -ReconciliationLimit $ReconciliationLimit -PageAuditLimit $PageAuditLimit -PageAuditBatchSize $PageAuditBatchSize"
  $trigger = New-ScheduledTaskTrigger `
    -Once `
    -At (Get-Date).AddMinutes(1) `
    -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes) `
    -RepetitionDuration (New-TimeSpan -Days 3650)
  $settings = New-ScheduledTaskSettingsSet `
    -MultipleInstances IgnoreNew `
    -StartWhenAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Minutes ([Math]::Max(10, $IntervalMinutes - 5)))
  $settings.DisallowStartIfOnBatteries = $false
  $settings.StopIfGoingOnBatteries = $false
  $settings.Hidden = $true

  Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Description "Polls/submits Gemini Batch visual reviews, reconciles pending public award facts, and processes flagged page audits." `
    -Force | Out-Null

  Write-PipelineLog "installed task=$TaskName interval_minutes=$IntervalMinutes visual_limit=$VisualReviewLimit visual_batch_size=$VisualReviewBatchSize reconciliation_limit=$ReconciliationLimit page_audit_limit=$PageAuditLimit page_audit_batch_size=$PageAuditBatchSize"
}

function Test-PipelineLockActive {
  if (-not (Test-Path -LiteralPath $LockPath)) {
    return $false
  }

  try {
    $raw = Get-Content -LiteralPath $LockPath -Raw -ErrorAction Stop
    $match = [regex]::Match($raw, "pid=(\d+)")
    if ($match.Success) {
      $workerPid = [int]$match.Groups[1].Value
      $process = Get-CimInstance Win32_Process -Filter "ProcessId = $workerPid" -ErrorAction SilentlyContinue
      if ($process -and $process.CommandLine -like "*Run-AwardPingDownstreamQueues.ps1*") {
        return $true
      }
    }
  } catch {
    Write-PipelineLog "lock_inspection_failed message=$($_.Exception.Message)"
  }

  Remove-Item -LiteralPath $LockPath -Force -ErrorAction SilentlyContinue
  return $false
}

function Invoke-NodeStep {
  param(
    [string]$Name,
    [string]$ScriptPath,
    [string[]]$Arguments,
    [string]$RunLog
  )

  Add-Content -LiteralPath $RunLog -Value "PIPELINE_STEP_START name=$Name started=$(Get-Date -Format o)" -Encoding UTF8
  $previousErrorActionPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  $exitCode = 1
  try {
    & $script:NodePath $ScriptPath @Arguments 2>&1 | ForEach-Object {
      $line = [string]$_
      Write-Host $line
      Add-Content -LiteralPath $RunLog -Value $line -Encoding UTF8
    }
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }
  Add-Content -LiteralPath $RunLog -Value "PIPELINE_STEP_EXIT name=$Name exit_code=$exitCode finished=$(Get-Date -Format o)" -Encoding UTF8
  return $exitCode
}

if ($Install) {
  Install-PipelineTask
  exit 0
}

if (Test-PipelineLockActive) {
  Write-PipelineLog "already_running no_restart=true"
  exit 0
}

$visualReviewScript = Join-Path $AppDir "scripts\process-visual-review-batch.mjs"
$reconciliationScript = Join-Path $AppDir "scripts\reconcile-impacted-award-pages.mjs"
$pageAuditScript = Join-Path $AppDir "scripts\process-page-audit-batch.mjs"
if (-not (Test-Path -LiteralPath $visualReviewScript)) {
  throw "Missing visual review Batch worker: $visualReviewScript"
}
if (-not (Test-Path -LiteralPath $reconciliationScript)) {
  throw "Missing award reconciliation worker: $reconciliationScript"
}
if (-not (Test-Path -LiteralPath $pageAuditScript)) {
  throw "Missing page audit Batch worker: $pageAuditScript"
}

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$script:NodePath = (Get-Command node.exe -ErrorAction Stop).Source
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$runLog = Join-Path $LogDir "awardping-downstream-queues-$stamp.log"
Set-Content -LiteralPath $LockPath -Value "pid=$PID started=$(Get-Date -Format o) log=$runLog" -Encoding ASCII
Set-Content -LiteralPath $runLog -Value "DOWNSTREAM_QUEUE_PIPELINE_START pid=$PID started=$(Get-Date -Format o) visual_limit=$VisualReviewLimit visual_batch_size=$VisualReviewBatchSize reconciliation_limit=$ReconciliationLimit page_audit_limit=$PageAuditLimit page_audit_batch_size=$PageAuditBatchSize" -Encoding UTF8

$visualExit = 1
$reconciliationExit = 1
$pageAuditExit = 1
try {
  $visualExit = Invoke-NodeStep `
    -Name "visual-review-batch" `
    -ScriptPath $visualReviewScript `
    -Arguments @(
      "--env", ".env.worker.local",
      "--limit=$VisualReviewLimit",
      "--max-requests-per-batch=$VisualReviewBatchSize",
      "--inline-threshold=$VisualReviewBatchSize",
      "--poll=true",
      "--submit=true",
      "--apply=true"
    ) `
    -RunLog $runLog

  $reconciliationExit = Invoke-NodeStep `
    -Name "award-reconciliation" `
    -ScriptPath $reconciliationScript `
    -Arguments @(
      "--env", ".env.worker.local",
      "--limit=$ReconciliationLimit",
      "--only-pending=true",
      "--only-failed=false",
      "--dry-run=false",
      "--apply=true",
      "--include-warnings=true"
    ) `
    -RunLog $runLog

  $pageAuditExit = Invoke-NodeStep `
    -Name "page-audit-batch" `
    -ScriptPath $pageAuditScript `
    -Arguments @(
      "--env", ".env.worker.local",
      "--limit=$PageAuditLimit",
      "--max-requests-per-batch=$PageAuditBatchSize",
      "--poll=true",
      "--submit=true",
      "--apply=true"
    ) `
    -RunLog $runLog
} finally {
  Remove-Item -LiteralPath $LockPath -Force -ErrorAction SilentlyContinue
}

$exitCode = if ($visualExit -eq 0 -and $reconciliationExit -eq 0 -and $pageAuditExit -eq 0) { 0 } else { 1 }
Add-Content -LiteralPath $runLog -Value "DOWNSTREAM_QUEUE_PIPELINE_EXIT exit_code=$exitCode visual_exit=$visualExit reconciliation_exit=$reconciliationExit page_audit_exit=$pageAuditExit finished=$(Get-Date -Format o)" -Encoding UTF8
Write-PipelineLog "finished exit_code=$exitCode visual_exit=$visualExit reconciliation_exit=$reconciliationExit page_audit_exit=$pageAuditExit run_log=$runLog"
exit $exitCode
