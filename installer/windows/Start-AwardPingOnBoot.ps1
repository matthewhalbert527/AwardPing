param(
  [string]$InstallRoot = "",
  [switch]$Install
)

$ErrorActionPreference = "Stop"
$TaskName = "AwardPing Startup Supervisor"

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
$SupervisorLog = Join-Path $LogDir "awardping-startup-supervisor.log"

function Write-StartupLog {
  param([string]$Message)

  New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
  $line = "{0} {1}" -f (Get-Date -Format "o"), $Message
  Add-Content -Path $SupervisorLog -Value $line -Encoding UTF8
}

function Install-StartupTask {
  $targetScript = Join-Path $InstallRoot "Start-AwardPingOnBoot.ps1"
  $currentScript = $PSCommandPath

  if (-not (Test-Path -LiteralPath $currentScript)) {
    throw "Could not locate startup supervisor script path."
  }

  if ($currentScript -ne $targetScript) {
    Copy-Item -LiteralPath $currentScript -Destination $targetScript -Force
  }

  $action = New-ScheduledTaskAction `
    -Execute "powershell.exe" `
    -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$targetScript`" -InstallRoot `"$InstallRoot`""
  $trigger = New-ScheduledTaskTrigger -AtLogOn
  $settings = New-ScheduledTaskSettingsSet `
    -MultipleInstances IgnoreNew `
    -StartWhenAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 10)
  $settings.DisallowStartIfOnBatteries = $false
  $settings.StopIfGoingOnBatteries = $false
  $settings.Hidden = $true

  try {
    Register-ScheduledTask `
      -TaskName $TaskName `
      -Action $action `
      -Trigger $trigger `
      -Settings $settings `
      -User $env:USERNAME `
      -Description "On Windows sign-in, resumes AwardPing watchdogs and starts a missed daily screenshot run if the PC was off at the scheduled time." `
      -Force | Out-Null

    Write-StartupLog "installed task=$TaskName install_root=$InstallRoot"
  } catch {
    Write-StartupLog "task_install_failed_using_startup_folder task=$TaskName message=$($_.Exception.Message)"
    Install-StartupFolderLauncher -TargetScript $targetScript
  }
}

function Install-StartupFolderLauncher {
  param([string]$TargetScript)

  $startupDir = [Environment]::GetFolderPath("Startup")
  if ([string]::IsNullOrWhiteSpace($startupDir)) {
    throw "Could not resolve the Windows Startup folder."
  }

  New-Item -ItemType Directory -Force -Path $startupDir | Out-Null
  $launcherPath = Join-Path $startupDir "AwardPing Startup Supervisor.vbs"
  $content = @"
Set shell = CreateObject("WScript.Shell")
cmd = "powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File ""$TargetScript"" -InstallRoot ""$InstallRoot"""
shell.Run cmd, 0, False
"@

  Set-Content -LiteralPath $launcherPath -Value $content -Encoding ASCII
  Write-StartupLog "installed startup_folder_launcher path=$launcherPath install_root=$InstallRoot"
}

function Enable-TaskIfPresent {
  param([string]$Name)

  $task = Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue
  if (-not $task) {
    Write-StartupLog "task_missing name=$Name"
    return $null
  }

  if ($task.State -eq "Disabled") {
    Enable-ScheduledTask -TaskName $Name -ErrorAction Stop | Out-Null
    Write-StartupLog "task_enabled name=$Name"
    $task = Get-ScheduledTask -TaskName $Name -ErrorAction Stop
  }

  return $task
}

function Start-TaskIfIdle {
  param(
    [string]$Name,
    [string]$Reason
  )

  $task = Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue
  if (-not $task) {
    Write-StartupLog "start_skipped_missing name=$Name reason=$Reason"
    return
  }

  if ($task.State -eq "Running") {
    Write-StartupLog "start_skipped_running name=$Name reason=$Reason"
    return
  }

  Start-ScheduledTask -TaskName $Name -ErrorAction Stop
  Write-StartupLog "task_started name=$Name reason=$Reason"
}

function Get-LatestVisualScheduleTime {
  $now = Get-Date
  $todayAtSix = Get-Date -Hour 18 -Minute 0 -Second 0
  if ($now -ge $todayAtSix) {
    return $todayAtSix
  }

  return $todayAtSix.AddDays(-1)
}

function Get-TaskStartBoundary {
  param([Microsoft.Management.Infrastructure.CimInstance]$Task)

  foreach ($trigger in @($Task.Triggers)) {
    $boundary = [string]$trigger.StartBoundary
    if ([string]::IsNullOrWhiteSpace($boundary)) {
      continue
    }

    try {
      return ([DateTimeOffset]::Parse($boundary)).LocalDateTime
    } catch {
      continue
    }
  }

  return $null
}

function Test-VisualRunMissed {
  param(
    [Microsoft.Management.Infrastructure.CimInstance]$Task,
    [DateTime]$LatestScheduledAt
  )

  $startBoundary = Get-TaskStartBoundary -Task $Task
  if ($startBoundary -and $startBoundary -gt $LatestScheduledAt) {
    return $false
  }

  $info = Get-ScheduledTaskInfo -TaskName $Task.TaskName -ErrorAction SilentlyContinue
  if (-not $info) {
    return $true
  }

  $lastRun = $info.LastRunTime
  if (-not $lastRun -or $lastRun.Year -lt 2000) {
    return $true
  }

  return $lastRun -lt $LatestScheduledAt
}

if ($Install) {
  Install-StartupTask
  return
}

try {
  Write-StartupLog "startup_check_started install_root=$InstallRoot"

  $factsTask = Enable-TaskIfPresent -Name "AwardPing Baseline Facts Watchdog"
  if ($factsTask) {
    Start-TaskIfIdle -Name "AwardPing Baseline Facts Watchdog" -Reason "startup_resume"
  }

  $downstreamTask = Enable-TaskIfPresent -Name "AwardPing Downstream Queue Pipeline"
  if ($downstreamTask) {
    Start-TaskIfIdle -Name "AwardPing Downstream Queue Pipeline" -Reason "startup_resume"
  }

  $latestVisualSchedule = Get-LatestVisualScheduleTime
  foreach ($index in 1..3) {
    $taskName = "AwardPing Visual Snapshot Worker Shard $index"
    $task = Enable-TaskIfPresent -Name $taskName
    if (-not $task) {
      continue
    }

    if (Test-VisualRunMissed -Task $task -LatestScheduledAt $latestVisualSchedule) {
      Start-TaskIfIdle -Name $taskName -Reason "missed_daily_run scheduled_at=$($latestVisualSchedule.ToString("o"))"
    } else {
      Write-StartupLog "visual_task_current name=$taskName latest_schedule=$($latestVisualSchedule.ToString("o"))"
    }
  }

  Write-StartupLog "startup_check_finished"
} catch {
  Write-StartupLog "startup_check_failed message=$($_.Exception.Message)"
  throw
}
