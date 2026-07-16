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

throw "This installer is retired and cannot create the obsolete overnight source-quality task. Use installer\windows\Install-AwardPingWorker.ps1 to install the three 6 PM capture shards and independent downstream lanes."
