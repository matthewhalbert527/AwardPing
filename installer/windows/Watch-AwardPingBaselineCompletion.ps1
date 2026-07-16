param(
  [string]$InstallRoot = "",
  [int]$Limit = 50000,
  [int]$BatchLimit = 250,
  [int]$IntervalMinutes = 5,
  [switch]$Install
)

$ErrorActionPreference = "Stop"

throw "This watchdog is retired and cannot run or recreate the obsolete baseline-completion task. Use installer\windows\Install-AwardPingWorker.ps1 for the current 6 PM capture shards and independent downstream lanes."
