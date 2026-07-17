param(
  [int]$Limit = 50000,
  [int]$MaxCalls = 50000,
  [string]$Model = "gemini-2.5-flash-lite",
  [string]$BatchMode = "batch",
  [int]$BatchMaxRequests = 25,
  [int]$BatchParallelJobs = 4,
  [int]$BatchPollSeconds = 30,
  [decimal]$CostCapUsd = 10,
  [int]$MaxRestarts = 3,
  [switch]$Force
)

$ErrorActionPreference = "Stop"

throw "This runner is retired and cannot start the obsolete baseline-facts worker. Use installer\windows\Install-AwardPingWorker.ps1; new-page information review must enter AwardPing New Page Review Lane, which is atomically capped at USD 5/day."
