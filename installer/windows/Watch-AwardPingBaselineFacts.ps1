param(
  [string]$InstallRoot = "",
  [int]$Limit = 50000,
  [int]$MaxCalls = 50000,
  [string]$Model = "gemini-2.5-flash-lite",
  [string]$BatchMode = "batch",
  [int]$BatchMaxRequests = 25,
  [int]$BatchParallelJobs = 4,
  [int]$BatchPollSeconds = 30,
  [int]$DirectCatchupThreshold = 1000,
  [decimal]$CostCapUsd = 5,
  [int]$IntervalMinutes = 60,
  [switch]$Install,
  [switch]$InstallDisabled
)

$ErrorActionPreference = "Stop"

throw "This watchdog is retired and cannot run or recreate the obsolete baseline-facts task. Use installer\windows\Install-AwardPingWorker.ps1 for the two atomically capped paid review lanes and all independent no-charge lanes."
