param(
  [string]$InstallRoot = "",
  [Parameter(Mandatory = $true)]
  [ValidateSet(
    "new_page_review",
    "changed_page_review",
    "feedback_promotion",
    "suppression",
    "reconciliation",
    "page_audit",
    "manual_quarantine",
    "nightly_report"
  )]
  [string]$Lane,
  [ValidateRange(2, 120)]
  [int]$TimeoutMinutes = 10
)

$ErrorActionPreference = "Stop"

function Resolve-InstallRoot {
  param([string]$RequestedRoot)

  if (-not [string]::IsNullOrWhiteSpace($RequestedRoot)) {
    return [System.IO.Path]::GetFullPath($RequestedRoot)
  }

  $scriptDirectory = Split-Path -Parent $PSCommandPath
  if (Test-Path -LiteralPath (Join-Path $scriptDirectory "app")) {
    return $scriptDirectory
  }

  return (Join-Path $env:LOCALAPPDATA "AwardPingWorker")
}

$InstallRoot = Resolve-InstallRoot -RequestedRoot $InstallRoot
$AppDir = Join-Path $InstallRoot "app"
$LogDir = Join-Path $InstallRoot "logs"
$LockPath = Join-Path $InstallRoot "downstream-lane-$Lane.lock"
$SummaryLog = Join-Path $LogDir "awardping-downstream-$Lane.log"
$LaneScript = Join-Path $AppDir "scripts\run-downstream-lane.mjs"

function Test-DownstreamLogPathWithinDirectory {
  param([string]$Path)

  if ([string]::IsNullOrWhiteSpace($Path)) {
    return $false
  }

  try {
    $normalizedLogDir = [System.IO.Path]::GetFullPath($LogDir).TrimEnd("\", "/")
    $normalizedPath = [System.IO.Path]::GetFullPath($Path)
    $directoryPrefix = "$normalizedLogDir$([System.IO.Path]::DirectorySeparatorChar)"
    return $normalizedPath.StartsWith(
      $directoryPrefix,
      [System.StringComparison]::OrdinalIgnoreCase
    )
  } catch {
    return $false
  }
}

function Remove-DownstreamLogFile {
  param([string]$Path)

  if (-not (Test-DownstreamLogPathWithinDirectory -Path $Path)) {
    throw "Refusing to remove a downstream log outside the verified log directory: $Path"
  }
  if (Test-Path -LiteralPath $Path -PathType Container) {
    throw "Refusing to remove a directory during downstream log retention: $Path"
  }
  if (Test-Path -LiteralPath $Path -PathType Leaf) {
    Remove-Item -LiteralPath $Path -Force -ErrorAction Stop
  }
}

function Invoke-DownstreamLogRetention {
  param(
    [ValidateRange(1, 10000)]
    [int]$MaxRunLogFiles = 2000,
    [ValidateRange(1, 365)]
    [int]$MaxRunLogAgeDays = 14,
    [ValidateRange(1, 1000)]
    [int]$MaxTemporaryLogFiles = 64,
    [ValidateRange(1, 168)]
    [int]$MaxTemporaryLogAgeHours = 24
  )

  New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
  $lanePattern = "(?:new_page_review|changed_page_review|feedback_promotion|suppression|reconciliation|page_audit|manual_quarantine|nightly_report)"
  $runLogPattern = "^awardping-downstream-$lanePattern-\d{8}-\d{6}-\d{3}-\d+\.log$"
  $temporaryLogPattern = "^awardping-downstream-$lanePattern-\d{8}-\d{6}-\d{3}-\d+\.(?:stdout|stderr)\.tmp$"
  $now = [DateTime]::UtcNow

  $runLogs = @(Get-ChildItem -LiteralPath $LogDir -File -ErrorAction Stop | Where-Object {
    $_.Name -match $runLogPattern
  })
  foreach ($file in @($runLogs | Where-Object {
    $_.LastWriteTimeUtc -lt $now.AddDays(-$MaxRunLogAgeDays)
  })) {
    Remove-DownstreamLogFile -Path $file.FullName
  }

  $runLogs = @(Get-ChildItem -LiteralPath $LogDir -File -ErrorAction Stop | Where-Object {
    $_.Name -match $runLogPattern
  } | Sort-Object LastWriteTimeUtc, FullName -Descending)
  foreach ($file in @($runLogs | Select-Object -Skip $MaxRunLogFiles)) {
    Remove-DownstreamLogFile -Path $file.FullName
  }

  $temporaryLogs = @(Get-ChildItem -LiteralPath $LogDir -File -ErrorAction Stop | Where-Object {
    $_.Name -match $temporaryLogPattern
  })
  foreach ($file in @($temporaryLogs | Where-Object {
    $_.LastWriteTimeUtc -lt $now.AddHours(-$MaxTemporaryLogAgeHours)
  })) {
    Remove-DownstreamLogFile -Path $file.FullName
  }

  $temporaryLogs = @(Get-ChildItem -LiteralPath $LogDir -File -ErrorAction Stop | Where-Object {
    $_.Name -match $temporaryLogPattern
  } | Sort-Object LastWriteTimeUtc, FullName -Descending)
  foreach ($file in @($temporaryLogs | Select-Object -Skip $MaxTemporaryLogFiles)) {
    Remove-DownstreamLogFile -Path $file.FullName
  }
}

function Rotate-DownstreamLaneSummaryLog {
  param(
    [ValidateRange(1024, 104857600)]
    [long]$MaxBytes = 5MB
  )

  if (-not (Test-Path -LiteralPath $SummaryLog -PathType Leaf)) {
    return
  }
  if ((Get-Item -LiteralPath $SummaryLog -ErrorAction Stop).Length -lt $MaxBytes) {
    return
  }

  $previousSummaryLog = "$SummaryLog.previous.log"
  if (
    -not (Test-DownstreamLogPathWithinDirectory -Path $SummaryLog) -or
    -not (Test-DownstreamLogPathWithinDirectory -Path $previousSummaryLog)
  ) {
    throw "Refusing to rotate a downstream summary outside the verified log directory."
  }
  Remove-DownstreamLogFile -Path $previousSummaryLog
  Move-Item `
    -LiteralPath $SummaryLog `
    -Destination $previousSummaryLog `
    -ErrorAction Stop
}

function Write-LaneLog {
  param([string]$Message)

  New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
  Rotate-DownstreamLaneSummaryLog
  $boundedMessage = [string]$Message
  if ($boundedMessage.Length -gt 4096) {
    $boundedMessage = $boundedMessage.Substring(0, 4096) + " [truncated]"
  }
  Add-Content `
    -LiteralPath $SummaryLog `
    -Value ("{0} {1}" -f (Get-Date -Format "o"), $boundedMessage) `
    -Encoding UTF8
}

function Test-LaneLockActive {
  if (-not (Test-Path -LiteralPath $LockPath)) {
    return $false
  }

  try {
    $raw = Get-Content -LiteralPath $LockPath -Raw -ErrorAction Stop
    $match = [regex]::Match($raw, "pid=(\d+)")
    if ($match.Success) {
      $workerPid = [int]$match.Groups[1].Value
      $process = Get-CimInstance Win32_Process -Filter "ProcessId = $workerPid" -ErrorAction SilentlyContinue
      $commandLine = [string]$process.CommandLine
      $lanePattern = "(?i)(?:-Lane\s+|--lane=)[`"]?$([regex]::Escape($Lane))(?:[`"]?(?:\s|$))"
      if (
        $process -and
        $commandLine.IndexOf("Run-AwardPingDownstreamLane.ps1", [System.StringComparison]::OrdinalIgnoreCase) -ge 0 -and
        [regex]::IsMatch($commandLine, $lanePattern)
      ) {
        return $true
      }
    }
  } catch {
    Write-LaneLog "lock_inspection_failed lane=$Lane message=$($_.Exception.Message)"
  }

  Remove-Item -LiteralPath $LockPath -Force -ErrorAction SilentlyContinue
  return $false
}

function Append-OutputFile {
  param(
    [string]$Path,
    [string]$RunLog,
    [string]$Stream
  )

  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    return
  }

  foreach ($line in @(Get-Content -LiteralPath $Path -ErrorAction SilentlyContinue)) {
    $text = [string]$line
    Write-Host $text
    Add-Content -LiteralPath $RunLog -Value ("{0} {1}" -f $Stream, $text) -Encoding UTF8
  }
}

if (Test-LaneLockActive) {
  Write-LaneLog "already_running lane=$Lane lock=$LockPath no_restart=true"
  exit 0
}

if (-not (Test-Path -LiteralPath $LaneScript -PathType Leaf)) {
  throw "Missing downstream lane runner: $LaneScript"
}

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
try {
  Invoke-DownstreamLogRetention
} catch {
  Write-Warning "Downstream log retention could not complete safely: $($_.Exception.Message)"
}
$nodePath = (Get-Command node.exe -ErrorAction Stop).Source
$stamp = "{0}-{1}" -f (Get-Date -Format "yyyyMMdd-HHmmss-fff"), $PID
$runLog = Join-Path $LogDir "awardping-downstream-$Lane-$stamp.log"
$stdoutPath = Join-Path $LogDir "awardping-downstream-$Lane-$stamp.stdout.tmp"
$stderrPath = Join-Path $LogDir "awardping-downstream-$Lane-$stamp.stderr.tmp"
$timeBudgetMs = [Math]::Max(60000, ($TimeoutMinutes * 60 * 1000) - 60000)
$exitCode = 1
$process = $null

$lockContent = "pid=$PID lane=$Lane started=$(Get-Date -Format o) log=$runLog"
try {
  $lockBytes = [System.Text.Encoding]::ASCII.GetBytes($lockContent)
  $lockStream = [System.IO.File]::Open(
    $LockPath,
    [System.IO.FileMode]::CreateNew,
    [System.IO.FileAccess]::Write,
    [System.IO.FileShare]::None
  )
  try {
    $lockStream.Write($lockBytes, 0, $lockBytes.Length)
    $lockStream.Flush()
  } finally {
    $lockStream.Dispose()
  }
} catch {
  if (Test-Path -LiteralPath $LockPath) {
    Write-LaneLog "lock_contention lane=$Lane lock=$LockPath no_restart=true"
    exit 0
  }
  throw
}
Set-Content `
  -LiteralPath $runLog `
  -Value "DOWNSTREAM_LANE_START pid=$PID lane=$Lane started=$(Get-Date -Format o) timeout_minutes=$TimeoutMinutes time_budget_ms=$timeBudgetMs" `
  -Encoding UTF8

try {
  $process = Start-Process `
    -FilePath $nodePath `
    -ArgumentList @(
      "`"$LaneScript`"",
      "--env=.env.worker.local",
      "--lane=$Lane",
      "--time-budget-ms=$timeBudgetMs"
    ) `
    -WorkingDirectory $AppDir `
    -RedirectStandardOutput $stdoutPath `
    -RedirectStandardError $stderrPath `
    -WindowStyle Hidden `
    -PassThru

  $completed = $process.WaitForExit($TimeoutMinutes * 60 * 1000)
  if (-not $completed) {
    Add-Content -LiteralPath $runLog -Value "DOWNSTREAM_LANE_TIMEOUT lane=$Lane pid=$($process.Id)" -Encoding UTF8
    $taskkill = Get-Command taskkill.exe -ErrorAction SilentlyContinue
    if ($taskkill) {
      & $taskkill.Source /PID $process.Id /T /F 2>&1 | ForEach-Object {
        Add-Content -LiteralPath $runLog -Value ("TASKKILL {0}" -f [string]$_) -Encoding UTF8
      }
    } else {
      Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    }
    if (-not $process.WaitForExit(10000)) {
      Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
      $process.WaitForExit(5000) | Out-Null
    }
    $exitCode = 124
  } else {
    $process.WaitForExit()
    $exitCode = $process.ExitCode
  }

  Append-OutputFile -Path $stdoutPath -RunLog $runLog -Stream "STDOUT"
  Append-OutputFile -Path $stderrPath -RunLog $runLog -Stream "STDERR"
  Add-Content `
    -LiteralPath $runLog `
    -Value "DOWNSTREAM_LANE_EXIT lane=$Lane exit_code=$exitCode finished=$(Get-Date -Format o)" `
    -Encoding UTF8
  Write-LaneLog "finished lane=$Lane exit_code=$exitCode run_log=$runLog"
} catch {
  if ($process -and -not $process.HasExited) {
    $taskkill = Get-Command taskkill.exe -ErrorAction SilentlyContinue
    if ($taskkill) {
      & $taskkill.Source /PID $process.Id /T /F 2>&1 | ForEach-Object {
        Add-Content -LiteralPath $runLog -Value ("TASKKILL {0}" -f [string]$_) -Encoding UTF8
      }
    }
    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
  }
  Add-Content `
    -LiteralPath $runLog `
    -Value "DOWNSTREAM_LANE_FAILED lane=$Lane message=$($_.Exception.Message) finished=$(Get-Date -Format o)" `
    -Encoding UTF8
  Write-LaneLog "failed lane=$Lane message=$($_.Exception.Message) run_log=$runLog"
  $exitCode = 1
} finally {
  Remove-Item -LiteralPath $stdoutPath -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $stderrPath -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $LockPath -Force -ErrorAction SilentlyContinue
  try {
    Invoke-DownstreamLogRetention
  } catch {
    Write-Warning "Downstream log retention could not complete safely: $($_.Exception.Message)"
  }
}

exit $exitCode
