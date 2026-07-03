param(
  [string]$InstallRoot = "$env:LOCALAPPDATA\AwardPingWorker",
  [int]$Hours = 10,
  [int]$MaxAwards = 90,
  [int]$MinOpenSources = 75,
  [ValidateSet("safe", "full")]
  [string]$Safety = "full",
  [string]$At = "6pm",
  [switch]$DryRun,
  [switch]$SkipTaskRegistration
)

$ErrorActionPreference = "Stop"
$TaskName = "AwardPing Overnight Source Quality Pass"

function Write-Step {
  param([string]$Message)
  Write-Host ""
  Write-Host "== $Message ==" -ForegroundColor Cyan
}

function Resolve-RepoRoot {
  return (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
}

$repoRoot = Resolve-RepoRoot
$appDir = Join-Path $InstallRoot "app"
$installedScriptsDir = Join-Path $appDir "scripts"
$installedScriptsLibDir = Join-Path $installedScriptsDir "lib"
$installedConfigDir = Join-Path $appDir "config"
$envPath = Join-Path $appDir ".env.worker.local"
$sourceRunner = Join-Path $repoRoot "installer\windows\Run-AwardPingOvernightSourceQuality.ps1"
$targetRunner = Join-Path $InstallRoot "Run-AwardPingOvernightSourceQuality.ps1"
$sourceWorker = Join-Path $repoRoot "scripts\run-overnight-source-quality-pass.mjs"
$targetWorker = Join-Path $installedScriptsDir "run-overnight-source-quality-pass.mjs"
$sourcePolicyHelper = Join-Path $repoRoot "scripts\lib\award-monitoring-policy.mjs"
$targetPolicyHelper = Join-Path $installedScriptsLibDir "award-monitoring-policy.mjs"
$sourcePolicyConfig = Join-Path $repoRoot "config\award-monitoring-policy.json"
$targetPolicyConfig = Join-Path $installedConfigDir "award-monitoring-policy.json"

Write-Step "Checking installed AwardPing worker"
if (-not (Test-Path -LiteralPath $appDir)) {
  throw "Missing installed app folder: $appDir. Run installer\windows\Install-AwardPingWorker.ps1 first."
}

if (-not (Test-Path -LiteralPath $envPath)) {
  throw "Missing worker env file: $envPath. Run installer\windows\Install-AwardPingWorker.ps1 first."
}

if (-not (Test-Path -LiteralPath $sourceRunner)) {
  throw "Missing source runner: $sourceRunner"
}

if (-not (Test-Path -LiteralPath $sourceWorker)) {
  throw "Missing source-quality worker: $sourceWorker"
}

if (-not (Test-Path -LiteralPath $sourcePolicyHelper)) {
  throw "Missing source policy helper: $sourcePolicyHelper"
}

if (-not (Test-Path -LiteralPath $sourcePolicyConfig)) {
  throw "Missing source policy config: $sourcePolicyConfig"
}

Write-Step "Copying overnight source-quality runner"
New-Item -ItemType Directory -Force -Path $InstallRoot | Out-Null
New-Item -ItemType Directory -Force -Path $installedScriptsDir | Out-Null
New-Item -ItemType Directory -Force -Path $installedScriptsLibDir | Out-Null
New-Item -ItemType Directory -Force -Path $installedConfigDir | Out-Null
Copy-Item -LiteralPath $sourceRunner -Destination $targetRunner -Force
Copy-Item -LiteralPath $sourceWorker -Destination $targetWorker -Force
Copy-Item -LiteralPath $sourcePolicyHelper -Destination $targetPolicyHelper -Force
Copy-Item -LiteralPath $sourcePolicyConfig -Destination $targetPolicyConfig -Force
Write-Host "Installed wrapper: $targetRunner"
Write-Host "Installed worker: $targetWorker"
Write-Host "Installed policy helper: $targetPolicyHelper"
Write-Host "Installed policy config: $targetPolicyConfig"

Write-Step "Creating manual launch shortcut"
$runNowBatPath = Join-Path $InstallRoot "9-RUN-OVERNIGHT-SOURCE-QUALITY-NOW.bat"
$dryRunArg = if ($DryRun) { " -DryRun" } else { "" }
$runNowBatContent = @"
@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$targetRunner" -Hours $Hours -MaxAwards $MaxAwards -MinOpenSources $MinOpenSources -Safety "$Safety"$dryRunArg
echo.
pause
"@
Set-Content -Path $runNowBatPath -Value $runNowBatContent -Encoding ASCII
Write-Host "Created: $runNowBatPath"

Write-Step "Creating daily scheduled task"
$runAt = [DateTime]::Parse($At)
$actionArgs = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$targetRunner`" -Hours $Hours -MaxAwards $MaxAwards -MinOpenSources $MinOpenSources -Safety `"$Safety`"$dryRunArg"
if ($SkipTaskRegistration) {
  Write-Host "Skipped scheduled task registration."
} else {
  $action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $actionArgs
  $trigger = New-ScheduledTaskTrigger -Daily -At $runAt
  $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 13)
  $settings.DisallowStartIfOnBatteries = $false
  $settings.StopIfGoingOnBatteries = $false
  $settings.Hidden = $true
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Description "Runs the AwardPing overnight source-quality cleanup pass beside the visual snapshot runner." -Force | Out-Null

  Write-Host "Scheduled task created: $TaskName daily at $($runAt.ToShortTimeString())"
  Write-Host "This runs alongside the existing 6 PM visual snapshot shard tasks."
}
if ($DryRun) {
  Write-Host "Mode: dry run. Reinstall without -DryRun when you want it to apply changes."
} else {
  Write-Host "Mode: apply changes."
}
Write-Host "Logs will be written to: $(Join-Path $InstallRoot "logs")"
