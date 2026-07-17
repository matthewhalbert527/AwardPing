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

throw "This runner is retired and cannot start the obsolete overnight source-quality worker. Use installer\windows\Install-AwardPingWorker.ps1 for the normal capture path, durable quarantine, and the independent downstream lanes."
