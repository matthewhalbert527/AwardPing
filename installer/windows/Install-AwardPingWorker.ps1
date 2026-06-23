param(
  [string]$InstallRoot = "$env:LOCALAPPDATA\AwardPingWorker",
  [string]$SupabaseUrl = "https://zploenljxkqzyxcmbyec.supabase.co",
  [switch]$UpdateOnly
)

$ErrorActionPreference = "Stop"

function Write-Step {
  param([string]$Message)
  Write-Host ""
  Write-Host "== $Message ==" -ForegroundColor Cyan
}

function Read-PlainSecret {
  param(
    [string]$Prompt,
    [switch]$AllowEmpty
  )

  while ($true) {
    $secure = Read-Host -Prompt $Prompt -AsSecureString
    $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try {
      $value = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
    } finally {
      [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
    }

    if ($AllowEmpty -or -not [string]::IsNullOrWhiteSpace($value)) {
      return $value.Trim()
    }

    Write-Host "This value is required." -ForegroundColor Yellow
  }
}

function Read-Default {
  param(
    [string]$Prompt,
    [string]$Default
  )

  $value = Read-Host "$Prompt [$Default]"
  if ([string]::IsNullOrWhiteSpace($value)) {
    return $Default
  }
  return $value.Trim()
}

function Read-YesNo {
  param(
    [string]$Prompt,
    [bool]$DefaultYes = $true
  )

  $suffix = if ($DefaultYes) { "Y/n" } else { "y/N" }
  while ($true) {
    $value = Read-Host "$Prompt [$suffix]"
    if ([string]::IsNullOrWhiteSpace($value)) {
      return $DefaultYes
    }
    switch ($value.Trim().ToLowerInvariant()) {
      "y" { return $true }
      "yes" { return $true }
      "n" { return $false }
      "no" { return $false }
    }
    Write-Host "Enter y or n." -ForegroundColor Yellow
  }
}

function Get-WebErrorBody {
  param($ErrorRecord)

  $response = $ErrorRecord.Exception.Response
  if (-not $response) {
    return $ErrorRecord.Exception.Message
  }

  try {
    $stream = $response.GetResponseStream()
    if (-not $stream) { return $ErrorRecord.Exception.Message }
    $reader = New-Object System.IO.StreamReader($stream)
    return $reader.ReadToEnd()
  } catch {
    return $ErrorRecord.Exception.Message
  }
}

function Test-SupabaseSecretKey {
  param([string]$Key)
  return $Key.Trim().StartsWith("sb_secret_")
}

function Test-SupabasePublishableKey {
  param([string]$Key)
  return $Key.Trim().StartsWith("sb_publishable_")
}

function Get-JwtRole {
  param([string]$Key)

  $parts = $Key.Trim().Split(".")
  if ($parts.Length -lt 2) { return $null }

  try {
    $payload = $parts[1].Replace("-", "+").Replace("_", "/")
    while ($payload.Length % 4 -ne 0) {
      $payload = "$payload="
    }
    $bytes = [Convert]::FromBase64String($payload)
    $json = [Text.Encoding]::UTF8.GetString($bytes)
    $parsed = $json | ConvertFrom-Json
    return $parsed.role
  } catch {
    return $null
  }
}

function New-SupabaseKeyHeaders {
  param([string]$Key)

  $headers = @{
    "apikey" = $Key
  }

  if (-not (Test-SupabaseSecretKey $Key)) {
    $headers["Authorization"] = "Bearer $Key"
  }

  return $headers
}

function Test-SupabaseServiceRoleKey {
  param(
    [string]$SupabaseUrl,
    [string]$SupabaseServiceRoleKey
  )

  $SupabaseServiceRoleKey = $SupabaseServiceRoleKey.Trim()
  if (Test-SupabasePublishableKey $SupabaseServiceRoleKey) {
    return @{
      Ok = $false
      Message = "That is a Supabase publishable key. The worker needs either the legacy JWT service_role key or the newer sb_secret key."
    }
  }

  $jwtRole = Get-JwtRole $SupabaseServiceRoleKey
  if ($jwtRole -and $jwtRole -ne "service_role") {
    return @{
      Ok = $false
      Message = "That JWT key has role '$jwtRole'. The worker needs the service_role key, not the anon key."
    }
  }

  $baseUrl = $SupabaseUrl.TrimEnd("/")
  $endpoint = "${baseUrl}/rest/v1/shared_awards?select=id&limit=1"
  $headers = New-SupabaseKeyHeaders $SupabaseServiceRoleKey

  try {
    Invoke-RestMethod -Method Get -Uri $endpoint -Headers $headers -ErrorAction Stop | Out-Null
    if (Test-SupabaseSecretKey $SupabaseServiceRoleKey) {
      return @{ Ok = $true; Message = "Supabase sb_secret key validated." }
    }
    return @{ Ok = $true; Message = "Supabase service_role JWT key validated." }
  } catch {
    $body = Get-WebErrorBody $_
    $status = $null
    if ($_.Exception.Response -and $_.Exception.Response.StatusCode) {
      $status = [int]$_.Exception.Response.StatusCode
    }

    if ($body -match "Invalid API key" -or $status -eq 401) {
      return @{
        Ok = $false
        Message = "Supabase rejected that key for $baseUrl. Paste the AwardPing Supabase project service_role JWT key or sb_secret key, not the Gemini API key, Vercel key, anon/publishable key, or Cloudflare token. Response: $body"
      }
    }

    if ($body -match "shared_awards" -and ($body -match "does not exist" -or $body -match "schema cache")) {
      return @{
        Ok = $false
        Message = "This Supabase project responded, but it does not have the AwardPing tables. Use the AwardPing Supabase project or apply the Supabase migrations first."
      }
    }

    return @{
      Ok = $false
      Message = "Could not validate the Supabase key against $endpoint. Status: $status. Response: $body"
    }
  }
}

function Read-SupabaseServiceRoleKey {
  param([string]$SupabaseUrl)

  while ($true) {
    $key = Read-PlainSecret "Paste Supabase service_role JWT key or sb_secret key"
    Write-Host "Checking Supabase key..."
    $result = Test-SupabaseServiceRoleKey -SupabaseUrl $SupabaseUrl -SupabaseServiceRoleKey $key
    if ($result.Ok) {
      Write-Host $result.Message -ForegroundColor Green
      return $key
    }

    Write-Host $result.Message -ForegroundColor Yellow
  }
}

function Get-CommandPath {
  param([string]$Command)
  $found = Get-Command $Command -ErrorAction SilentlyContinue
  if ($found) { return $found.Source }
  return $null
}

function Ensure-Node {
  Write-Step "Checking Node.js"
  $nodePath = Get-CommandPath "node.exe"
  $npmPath = Get-CommandPath "npm.cmd"

  if ($nodePath -and $npmPath) {
    $version = (& node --version)
    Write-Host "Found Node.js $version"
    return
  }

  $winget = Get-CommandPath "winget.exe"
  if (-not $winget) {
    throw "Node.js is not installed and winget was not found. Install Node.js LTS from https://nodejs.org, then run this installer again."
  }

  Write-Host "Node.js was not found. Installing Node.js LTS with winget..."
  & winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements
  if ($LASTEXITCODE -ne 0) {
    throw "Node.js installation failed. Install Node.js LTS manually from https://nodejs.org, then run this installer again."
  }

  $nodeDir = "$env:ProgramFiles\nodejs"
  if (Test-Path $nodeDir) {
    $env:Path = "$nodeDir;$env:Path"
  }

  $nodePath = Get-CommandPath "node.exe"
  $npmPath = Get-CommandPath "npm.cmd"
  if (-not $nodePath -or -not $npmPath) {
    throw "Node.js installed, but this terminal cannot see node/npm yet. Close this window and run the installer again."
  }

  Write-Host "Installed Node.js $(& node --version)"
}

function Copy-AppFiles {
  param(
    [string]$SourceRoot,
    [string]$AppDir
  )

  Write-Step "Installing AwardPing worker files"
  New-Item -ItemType Directory -Force -Path $AppDir | Out-Null

  $robocopy = Get-CommandPath "robocopy.exe"
  if ($robocopy) {
    $args = @(
      $SourceRoot,
      $AppDir,
      "/E",
      "/XD", "node_modules", ".next", ".git", ".vercel", "dist", "reports", "tmp",
      "AwardPingVisualSnapshots", "visual-snapshots", "visual-snapshot-archive",
      "/XF", ".env*", "*.tsbuildinfo", ".DS_Store",
      "/NFL", "/NDL", "/NJH", "/NJS", "/NC", "/NS"
    )
    & robocopy @args | Out-Null
    if ($LASTEXITCODE -ge 8) {
      throw "File copy failed with robocopy exit code $LASTEXITCODE."
    }
    return
  }

  Get-ChildItem -Path $SourceRoot -Force | Where-Object {
    $_.Name -notin @(
      "node_modules",
      ".next",
      ".git",
      ".vercel",
      "dist",
      "reports",
      "tmp",
      "AwardPingVisualSnapshots",
      "visual-snapshots",
      "visual-snapshot-archive"
    ) -and
    $_.Name -notlike ".env*" -and
    $_.Name -notlike "*.tsbuildinfo" -and
    $_.Name -ne ".DS_Store"
  } | ForEach-Object {
    Copy-Item -Path $_.FullName -Destination $AppDir -Recurse -Force
  }
}

function Write-EnvFile {
  param(
    [string]$Path,
    [string]$SupabaseUrl,
    [string]$SupabaseServiceRoleKey,
    [string]$GeminiApiKey
  )

  Write-Step "Writing local worker environment"
  $content = @"
NEXT_PUBLIC_SUPABASE_URL=$SupabaseUrl
SUPABASE_SERVICE_ROLE_KEY=$SupabaseServiceRoleKey

AI_PROVIDER=gemini
GEMINI_API_KEY=$GeminiApiKey
GEMINI_MODEL=gemini-2.5-flash-lite
GEMINI_DISCOVERY_MODEL=gemini-2.5-flash-lite
GEMINI_SUMMARY_MODEL=gemini-2.5-flash-lite
AWARDPING_GEMINI_API_DAILY_COST_CAP_USD=10

AWARDPING_R2_SNAPSHOT_SYNC=false
R2_BUCKET=awardping-snapshots
R2_ACCOUNT_ID=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
"@

  Set-Content -Path $Path -Value $content -Encoding UTF8
}

function Update-ExistingEnvFileDefaults {
  param([string]$Path)

  if (-not (Test-Path $Path)) {
    return
  }

  Write-Step "Refreshing local worker defaults"
  $content = Get-Content -Path $Path -Raw
  $updates = [ordered]@{
    "AI_PROVIDER" = "gemini"
    "GEMINI_MODEL" = "gemini-2.5-flash-lite"
    "GEMINI_DISCOVERY_MODEL" = "gemini-2.5-flash-lite"
    "GEMINI_SUMMARY_MODEL" = "gemini-2.5-flash-lite"
  }
  $missingDefaults = [ordered]@{
    "AWARDPING_GEMINI_API_DAILY_COST_CAP_USD" = "10"
    "AWARDPING_R2_SNAPSHOT_SYNC" = "false"
    "R2_BUCKET" = "awardping-snapshots"
    "R2_ACCOUNT_ID" = ""
    "R2_ACCESS_KEY_ID" = ""
    "R2_SECRET_ACCESS_KEY" = ""
  }

  foreach ($key in $updates.Keys) {
    $value = $updates[$key]
    $pattern = "(?m)^$([regex]::Escape($key))=.*$"
    if ($content -match $pattern) {
      $content = [regex]::Replace($content, $pattern, "$key=$value")
    } else {
      $content = $content.TrimEnd() + "`r`n$key=$value`r`n"
    }
  }

  foreach ($key in $missingDefaults.Keys) {
    $pattern = "(?m)^$([regex]::Escape($key))=.*$"
    if ($content -notmatch $pattern) {
      $content = $content.TrimEnd() + "`r`n$key=$($missingDefaults[$key])`r`n"
    }
  }

  Set-Content -Path $Path -Value $content -Encoding UTF8
  Write-Host "Gemini API defaults set to gemini-2.5-flash-lite with an AwardPing estimated daily cost cap."
}

function Write-UninstallScript {
  param([string]$InstallRoot)

  $scriptPath = Join-Path $InstallRoot "Uninstall-AwardPingWorker.ps1"
  $content = @"
`$ErrorActionPreference = "Stop"
`$taskNames = @(
  "AwardPing Local Source Worker",
  "AwardPing Local Worker Auto Update",
  "AwardPing Visual Snapshot Worker",
  "AwardPing Baseline Completion Watchdog"
)

foreach (`$taskName in `$taskNames) {
  Unregister-ScheduledTask -TaskName `$taskName -Confirm:`$false -ErrorAction SilentlyContinue
}

Write-Host "Scheduled tasks removed. Delete this folder if you also want to remove logs and env files:"
Write-Host "$InstallRoot"
"@

  Set-Content -Path $scriptPath -Value $content -Encoding UTF8
}

function Write-LauncherScripts {
  param([string]$InstallRoot)

  $visualRunScript = Join-Path $InstallRoot "Run-AwardPingVisualSnapshots.ps1"
$visualRunContent = @"
param(
  [int]`$Limit = 50000,
  [switch]`$All,
  [switch]`$BaselineRefresh,
  [switch]`$PdfOnly,
  [switch]`$WebOnly,
  [switch]`$CompleteMissingBaselines,
  [switch]`$SkipExistingBaseline,
  [int]`$DomainDelayMs = 1500,
  [int]`$CompleteMissingBatchLimit = 250
)

`$ErrorActionPreference = "Stop"
`$InstallRoot = Split-Path -Parent `$MyInvocation.MyCommand.Path
`$AppDir = Join-Path `$InstallRoot "app"
`$LogDir = Join-Path `$InstallRoot "logs"
`$LockPath = Join-Path `$InstallRoot "visual-worker.lock"
New-Item -ItemType Directory -Force -Path `$LogDir | Out-Null

function Test-VisualLockActive {
  param([string]`$Path)

  if (-not (Test-Path `$Path)) {
    return `$false
  }

  try {
    `$raw = Get-Content -Path `$Path -Raw -ErrorAction Stop
    `$match = [regex]::Match(`$raw, "pid=(\d+)")
    if (`$match.Success) {
      `$workerPid = [int]`$match.Groups[1].Value
      `$process = Get-CimInstance Win32_Process -Filter "ProcessId = `$workerPid" -ErrorAction SilentlyContinue
      if (`$process -and (
        `$process.CommandLine -like "*Run-AwardPingVisualSnapshots.ps1*" -or
        `$process.CommandLine -like "*source:visual-snapshots*"
      )) {
        return `$true
      }
    }
  } catch {
    Write-Host "Could not inspect visual worker lock; treating it as stale."
  }

  Write-Host "Removing stale AwardPing visual worker lock."
  Remove-Item -Path `$Path -Force -ErrorAction SilentlyContinue
  return `$false
}

if (Test-VisualLockActive -Path `$LockPath) {
  Write-Host "AwardPing visual snapshot worker is already running. Skipping this launch."
  exit 0
}

`$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
`$mode = if (`$CompleteMissingBaselines) { "complete-missing-baselines" } elseif (`$BaselineRefresh) { "baseline-refresh" } else { "snapshots" }
`$logPrefix = if (`$CompleteMissingBaselines) { "awardping-visual-complete-baselines" } elseif (`$BaselineRefresh) { "awardping-visual-baseline-refresh" } else { "awardping-visual-snapshots" }
`$logPath = Join-Path `$LogDir "`$logPrefix-`$stamp.log"

Set-Location `$AppDir
`$workerArgs = @(
  "run",
  "source:visual-snapshots",
  "--",
  "--env",
  ".env.worker.local",
  "--limit",
  [string]`$Limit,
  "--domain-delay-ms",
  [string]`$DomainDelayMs
)
if (`$All) { `$workerArgs += "--all=true" }
if (`$BaselineRefresh) { `$workerArgs += "--baseline-refresh=true" }
if (`$PdfOnly) { `$workerArgs += "--pdf-only=true" }
if (`$WebOnly) { `$workerArgs += "--web-only=true" }
if (`$CompleteMissingBaselines) {
  `$workerArgs += "--complete-missing-baselines=true"
  `$workerArgs += "--skip-existing-baseline=true"
  `$workerArgs += "--extract-baseline-info=false"
  `$workerArgs += "--complete-missing-batch-limit"
  `$workerArgs += [string]`$CompleteMissingBatchLimit
}
if (`$SkipExistingBaseline) { `$workerArgs += "--skip-existing-baseline=true" }

if (`$CompleteMissingBaselines) {
  Write-Host "Running AwardPing missing visual baseline completion. Log: `$logPath"
} elseif (`$BaselineRefresh) {
  Write-Host "Running AwardPing visual baseline refresh. Log: `$logPath"
} else {
  Write-Host "Running AwardPing visual snapshot worker. Log: `$logPath"
}
Set-Content -Path `$LockPath -Value "pid=`$PID started=`$(Get-Date -Format o) mode=`$mode log=`$logPath" -Encoding ASCII
`$exitCode = 1
Set-Content -Path `$logPath -Value "VISUAL_WORKER_START pid=`$PID mode=`$mode started=`$(Get-Date -Format o) limit=`$Limit all=`$All baseline_refresh=`$BaselineRefresh complete_missing_baselines=`$CompleteMissingBaselines complete_missing_batch_limit=`$CompleteMissingBatchLimit" -Encoding UTF8
try {
  & npm @workerArgs *>&1 | ForEach-Object {
    `$line = [string]`$_
    Write-Host `$line
    Add-Content -Path `$logPath -Value `$line -Encoding UTF8
  }
  `$exitCode = `$LASTEXITCODE
  Add-Content -Path `$logPath -Value "VISUAL_WORKER_EXIT exit_code=`$exitCode finished=`$(Get-Date -Format o)" -Encoding UTF8
} catch {
  Add-Content -Path `$logPath -Value "VISUAL_WORKER_WRAPPER_ERROR message=`$(`$_.Exception.Message) finished=`$(Get-Date -Format o)" -Encoding UTF8
  throw
} finally {
  Remove-Item -Path `$LockPath -Force -ErrorAction SilentlyContinue
}
exit `$exitCode
"@

  Set-Content -Path $visualRunScript -Value $visualRunContent -Encoding UTF8

  $visualCheckPath = Join-Path $InstallRoot "3-RUN-VISUAL-SNAPSHOT-CHECK-NOW.bat"
  $visualCheckContent = @"
@echo off
echo Running AwardPing visual snapshot check now.
echo This captures screenshots and normalized visible text under D:\AwardPingVisualSnapshots.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$visualRunScript" -All -Limit 20000
echo.
pause
"@

  Set-Content -Path $visualCheckPath -Value $visualCheckContent -Encoding ASCII

  $visualBaselinePath = Join-Path $InstallRoot "5-RUN-VISUAL-BASELINE-REFRESH-NOW.bat"
  $visualBaselineContent = @"
@echo off
echo Running AwardPing visual baseline refresh now.
echo This replaces screenshot baselines so the next scheduled run can compare against them.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$visualRunScript" -All -Limit 20000 -BaselineRefresh
echo.
pause
"@

  Set-Content -Path $visualBaselinePath -Value $visualBaselineContent -Encoding ASCII

  $pdfBaselinePath = Join-Path $InstallRoot "7-RUN-PDF-BASELINE-REFRESH-NOW.bat"
  $pdfBaselineContent = @"
@echo off
echo Running AwardPing PDF baseline refresh now.
echo This downloads PDF sources and compares future runs by PDF file hash.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$visualRunScript" -All -Limit 20000 -BaselineRefresh -PdfOnly
echo.
pause
"@

  Set-Content -Path $pdfBaselinePath -Value $pdfBaselineContent -Encoding ASCII

  $completeBaselinePath = Join-Path $InstallRoot "8-COMPLETE-MISSING-VISUAL-BASELINES-NOW.bat"
  $completeBaselineContent = @"
@echo off
echo Completing missing AwardPing visual baselines now.
echo Existing baselines will be skipped so this only works on pages that still need a baseline.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$visualRunScript" -All -Limit 50000 -CompleteMissingBaselines -CompleteMissingBatchLimit 250
echo.
pause
"@

  Set-Content -Path $completeBaselinePath -Value $completeBaselineContent -Encoding ASCII

  $visualStatusScriptPath = Join-Path $InstallRoot "Show-AwardPingVisualStatus.ps1"
  $visualStatusScriptContent = @"
`$ErrorActionPreference = "Stop"
`$InstallRoot = Split-Path -Parent `$MyInvocation.MyCommand.Path
`$LogDir = Join-Path `$InstallRoot "logs"
`$LockPath = Join-Path `$InstallRoot "visual-worker.lock"
`$ReportDir = Join-Path `$InstallRoot "app\reports"

function Count-Matches {
  param(
    [string[]]`$Lines,
    [string]`$Pattern
  )

  return (`$Lines | Select-String -Pattern `$Pattern | Measure-Object).Count
}

function Read-JsonIfExists {
  param([string]`$Path)

  if (-not `$Path -or -not (Test-Path `$Path)) {
    return `$null
  }

  try {
    return Get-Content -Path `$Path -Raw | ConvertFrom-Json
  } catch {
    return `$null
  }
}

`$running = Get-CimInstance Win32_Process | Where-Object {
  `$cmd = `$_.CommandLine
  `$cmd -and
  `$cmd -notlike "*Show-AwardPingVisualStatus.ps1*" -and
  `$cmd -notlike "*Get-CimInstance Win32_Process*" -and
  (
    `$cmd -like "*Run-AwardPingVisualSnapshots.ps1*" -or
    `$cmd -like "*source:visual-snapshots*" -or
    `$cmd -like "*capture-visual-snapshots.mjs*"
  )
}
`$lockText = if (Test-Path `$LockPath) { Get-Content -Path `$LockPath -Raw -ErrorAction SilentlyContinue } else { "" }
`$latestLog = Get-ChildItem -Path `$LogDir -Filter "awardping-visual*.log" -ErrorAction SilentlyContinue |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 1
`$lines = if (`$latestLog) { Get-Content -Path `$latestLog.FullName -ErrorAction SilentlyContinue } else { @() }
`$reportLine = `$lines | Select-String -Pattern "^REPORT " | Select-Object -Last 1
`$reportPath = if (`$reportLine) { `$reportLine.Line -replace "^REPORT\s+", "" } else { "" }
`$report = Read-JsonIfExists -Path `$reportPath

if (-not `$running -and -not `$report -and (Test-Path `$ReportDir)) {
  `$latestReport = Get-ChildItem -Path `$ReportDir -Filter "visual-snapshot-run-*.json" -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
  if (`$latestReport) {
    `$report = Read-JsonIfExists -Path `$latestReport.FullName
    `$reportPath = `$latestReport.FullName
  }
}

Write-Host "AwardPing visual snapshot status"
Write-Host ""
Write-Host "Running: `$([bool]`$running)"
if (`$running) {
  Write-Host "Process IDs: `$((`$running | Select-Object -ExpandProperty ProcessId) -join ', ')"
}
if (`$lockText) {
  Write-Host "Lock: `$(`$lockText.Trim())"
}
Write-Host ""

if (`$latestLog) {
  Write-Host "Latest log: `$(`$latestLog.FullName)"
  Write-Host "Log updated: `$(`$latestLog.LastWriteTime)"
  Write-Host "Baselines: `$(Count-Matches `$lines '^BASELINE ')"
  Write-Host "Unchanged: `$(Count-Matches `$lines '^UNCHANGED')"
  Write-Host "PDF checked: `$(Count-Matches `$lines '^BASELINE PDF |^UNCHANGED pdf_|^REVIEW pdf_')"
  Write-Host "PDF skipped: `$(Count-Matches `$lines '^NOISE skipped_pdf ')"
  Write-Host "Failed: `$(Count-Matches `$lines '^FAILED ')"
  Write-Host "Candidate changes: `$(Count-Matches `$lines '^AI TRUE|^AI REJECTED|^REVIEW ')"
  Write-Host ""
  Write-Host "Last log line:"
  Write-Host (`$lines | Select-Object -Last 1)
} else {
  Write-Host "No visual snapshot logs found."
}

Write-Host ""
if (`$report) {
  Write-Host "Latest report: `$reportPath"
  Write-Host "Status: `$(`$report.status)"
  Write-Host "Started: `$(`$report.started_at)"
  Write-Host "Finished: `$(`$report.finished_at)"
  Write-Host "Checked: `$(`$report.checked)"
  Write-Host "Baselined: `$(`$report.baselined)"
  Write-Host "Unchanged: `$(`$report.unchanged)"
  Write-Host "AI true changes: `$(`$report.ai_true_changes)"
  Write-Host "AI rejected: `$(`$report.ai_rejected)"
  Write-Host "Review: `$(`$report.review)"
  Write-Host "Failed: `$(`$report.failed)"
  if (`$null -ne `$report.skipped_existing_baseline) {
    Write-Host "Skipped existing baselines: `$(`$report.skipped_existing_baseline)"
  }
  Write-Host "PDF skipped: `$(`$report.skipped_pdf)"
  if (`$null -ne `$report.pdf_checked) {
    Write-Host "PDF checked: `$(`$report.pdf_checked)"
    Write-Host "PDF changed: `$(`$report.pdf_changed)"
    Write-Host "PDF unchanged: `$(`$report.pdf_unchanged)"
  }
  if (`$report.gemini_usage) {
    Write-Host "Gemini calls: `$(`$report.gemini_usage.calls)"
    Write-Host "Gemini tokens: `$(`$report.gemini_usage.total_tokens)"
  }
  if (`$report.baseline_coverage_start) {
    Write-Host "Baseline coverage start: existing `$(`$report.baseline_coverage_start.existing_baselines) / `$(`$report.baseline_coverage_start.loaded_sources); missing `$(`$report.baseline_coverage_start.missing_baselines); actionable missing `$(`$report.baseline_coverage_start.actionable_missing_baselines); known broken missing `$(`$report.baseline_coverage_start.known_broken_missing_baselines)"
  }
  if (`$report.baseline_coverage_finish) {
    Write-Host "Baseline coverage finish: existing `$(`$report.baseline_coverage_finish.existing_baselines) / `$(`$report.baseline_coverage_finish.loaded_sources); missing `$(`$report.baseline_coverage_finish.missing_baselines); actionable missing `$(`$report.baseline_coverage_finish.actionable_missing_baselines); known broken missing `$(`$report.baseline_coverage_finish.known_broken_missing_baselines)"
  }
}

Write-Host ""
`$taskInfo = Get-ScheduledTaskInfo -TaskName "AwardPing Visual Snapshot Worker" -ErrorAction SilentlyContinue
if (`$taskInfo) {
  Write-Host "Scheduled task next run: `$(`$taskInfo.NextRunTime)"
  Write-Host "Scheduled task last run: `$(`$taskInfo.LastRunTime)"
  Write-Host "Scheduled task last result: `$(`$taskInfo.LastTaskResult)"
}
"@

  Set-Content -Path $visualStatusScriptPath -Value $visualStatusScriptContent -Encoding UTF8

  $visualStatusBatPath = Join-Path $InstallRoot "6-SHOW-VISUAL-SNAPSHOT-STATUS.bat"
  $visualStatusBatContent = @"
@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$visualStatusScriptPath"
echo.
pause
"@

  Set-Content -Path $visualStatusBatPath -Value $visualStatusBatContent -Encoding ASCII

  $usageScriptPath = Join-Path $InstallRoot "Show-AwardPingGeminiUsage.ps1"
  $usageScriptContent = @"
`$ErrorActionPreference = "Stop"
`$UsageDir = "D:\AwardPingVisualSnapshots\usage"
`$SummaryPath = Join-Path `$UsageDir "gemini-usage-current.json"

if (-not (Test-Path `$SummaryPath)) {
  Write-Host "No AwardPing Gemini usage records yet."
  Write-Host "Gemini usage is recorded only when the visual checker finds a screenshot change and asks Gemini to review it."
  Write-Host "Dollar spend/cap is shown in Google AI Studio > Spend; the Gemini API response does not return account dollar spend."
  Write-Host "Usage folder: `$UsageDir"
  exit 0
}

`$summary = Get-Content -Path `$SummaryPath -Raw | ConvertFrom-Json
`$month = `$summary.month_total

Write-Host "AwardPing Gemini usage"
Write-Host "Month: `$(`$summary.month)"
Write-Host "Updated: `$(`$summary.updated_at)"
Write-Host ""
Write-Host "Month calls: `$(`$month.calls)"
Write-Host "Month tokens: `$(`$month.total_tokens)"
Write-Host "Prompt tokens: `$(`$month.prompt_tokens)"
Write-Host "Output tokens: `$(`$month.candidates_tokens)"
Write-Host ""
Write-Host "Dollar spend/cap: check Google AI Studio > Spend. The Gemini API response does not return account dollar spend."
Write-Host "AI Studio cost information may take up to 24 hours to update."
Write-Host ""
Write-Host "Daily usage:"
`$summary.daily |
  Sort-Object date -Descending |
  Select-Object -First 31 @{Name="Date";Expression={`$_.date}}, @{Name="Calls";Expression={`$_.calls}}, @{Name="Tokens";Expression={`$_.total_tokens}}, @{Name="Prompt";Expression={`$_.prompt_tokens}}, @{Name="Output";Expression={`$_.candidates_tokens}} |
  Format-Table -AutoSize
Write-Host ""
Write-Host "Raw usage folder: `$UsageDir"
"@

  Set-Content -Path $usageScriptPath -Value $usageScriptContent -Encoding UTF8

  $usageBatPath = Join-Path $InstallRoot "4-SHOW-GEMINI-USAGE.bat"
  $usageBatContent = @"
@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$usageScriptPath"
echo.
pause
"@

  Set-Content -Path $usageBatPath -Value $usageBatContent -Encoding ASCII

  $logsPath = Join-Path $InstallRoot "OPEN-LOGS.bat"
  $logsContent = @"
@echo off
explorer.exe "$InstallRoot\logs"
"@

  Set-Content -Path $logsPath -Value $logsContent -Encoding ASCII

  $readmePath = Join-Path $InstallRoot "README-INSTALLED-RUNNER.txt"
  $readmeContent = @"
AwardPing runner is installed here:
$InstallRoot

Use:
3-RUN-VISUAL-SNAPSHOT-CHECK-NOW.bat
  Runs the disk-backed visual screenshot checker across all source pages.
  The daily scheduled visual task uses the same runner.

4-SHOW-GEMINI-USAGE.bat
  Shows AwardPing Gemini usage recorded by this PC, grouped by day and month.

5-RUN-VISUAL-BASELINE-REFRESH-NOW.bat
  Replaces screenshot baselines across all source pages so the next scheduled run can compare against a fresh baseline.

6-SHOW-VISUAL-SNAPSHOT-STATUS.bat
  Shows whether the visual worker is running, live log counts, the latest report, and the next scheduled run.

OPEN-LOGS.bat
  Opens crawler logs.
"@

  Set-Content -Path $readmePath -Value $readmeContent -Encoding ASCII
}

function Install-Dependencies {
  param([string]$AppDir)

  Write-Step "Installing npm dependencies"
  Set-Location $AppDir

  $nodeModules = Join-Path $AppDir "node_modules"
  for ($attempt = 1; $attempt -le 2; $attempt += 1) {
    Remove-DirectoryWithRetry -Path $nodeModules
    & npm ci --omit=dev
    if ($LASTEXITCODE -eq 0) {
      return
    }

    if ($attempt -lt 2) {
      Write-Host "npm install failed; retrying after a clean dependency removal." -ForegroundColor Yellow
    }
  }

  throw "npm install failed."
}

function Remove-DirectoryWithRetry {
  param([string]$Path)

  if (-not (Test-Path $Path)) {
    return
  }

  for ($attempt = 1; $attempt -le 5; $attempt += 1) {
    try {
      Remove-Item -LiteralPath $Path -Recurse -Force -ErrorAction Stop
      return
    } catch {
      if ($attempt -eq 5) {
        throw
      }
      Start-Sleep -Milliseconds (500 * $attempt)
    }
  }
}

function Remove-LegacySourceTask {
  param([string]$InstallRoot)

  Write-Step "Removing legacy scheduled tasks"
  foreach ($taskName in @("AwardPing Local Source Worker", "AwardPing Local Worker Auto Update")) {
    $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if ($task) {
      Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
      Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
      Write-Host "Removed legacy scheduled task: $taskName"
    } else {
      Write-Host "Legacy scheduled task is not present: $taskName"
    }
  }

  foreach ($fileName in @(
    "Run-AwardPingWorker.ps1",
    "worker.lock",
    "1-RUN-DEEP-CRAWL-AGAIN.bat",
    "2-RUN-90-MINUTE-CHECK-NOW.bat",
    "2-RUN-HOURLY-CHECK-NOW.bat",
    "RUN-DAILY-CHECK-NOW.bat",
    "RUN-DEEP-CRAWL-ALL.bat"
  )) {
    $legacyPath = Join-Path $InstallRoot $fileName
    if (Test-Path $legacyPath) {
      Remove-Item -LiteralPath $legacyPath -Force -ErrorAction SilentlyContinue
      Write-Host "Removed legacy launcher: $fileName"
    }
  }

  $legacyWorkerScript = Join-Path $InstallRoot "app\scripts\run-local-source-worker.mjs"
  if (Test-Path $legacyWorkerScript) {
    Remove-Item -LiteralPath $legacyWorkerScript -Force -ErrorAction SilentlyContinue
    Write-Host "Removed legacy source/text worker script from installed app."
  }
}

function Register-VisualSnapshotTask {
  param([string]$InstallRoot)

  Write-Step "Creating AwardPing visual snapshot task"
  $taskName = "AwardPing Visual Snapshot Worker"
  $visualRunScript = Join-Path $InstallRoot "Run-AwardPingVisualSnapshots.ps1"
  $action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$visualRunScript`" -All -Limit 50000"
  $trigger = New-ScheduledTaskTrigger -Daily -At 6pm
  $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 23)
  $settings.DisallowStartIfOnBatteries = $false
  $settings.StopIfGoingOnBatteries = $false
  $settings.Hidden = $true
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Description "Captures visual AwardPing source-page snapshots daily from this PC." -Force | Out-Null
  Write-Host "Scheduled task created: $taskName daily at 6:00 PM"
}

$packageRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$payloadRoot = Join-Path $packageRoot "runner-files"
if (Test-Path (Join-Path $payloadRoot "package.json")) {
  $sourceRoot = Resolve-Path $payloadRoot
} else {
  $sourceRoot = $packageRoot
}

if (-not (Test-Path (Join-Path $sourceRoot "package.json"))) {
  throw "Could not find runner-files\package.json. Run this installer from the extracted AwardPing worker package."
}

if ($UpdateOnly) {
  Write-Host "AwardPing Local PC Worker Code Update" -ForegroundColor Green
  Write-Host "This updates the crawler under: $InstallRoot"
  Write-Host "Existing keys in .env.worker.local will be kept."
} else {
  Write-Host "AwardPing Local PC Worker Installer" -ForegroundColor Green
  Write-Host "This installs the crawler under: $InstallRoot"
  Write-Host "Secrets are written only to the PC's .env.worker.local file."
  Write-Host "For Supabase, paste the legacy JWT service_role key or the newer sb_secret key. Do not use the anon/publishable key."
}

$appDir = Join-Path $InstallRoot "app"
$envPath = Join-Path $appDir ".env.worker.local"
$logDir = Join-Path $InstallRoot "logs"
$runTest = $false

if ($UpdateOnly -and -not (Test-Path $envPath)) {
  throw "Update-only mode did not find $envPath. Run the installer first."
}

New-Item -ItemType Directory -Force -Path $InstallRoot | Out-Null
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

Ensure-Node
Copy-AppFiles -SourceRoot $sourceRoot -AppDir $appDir

if ($UpdateOnly) {
  Write-Host "Update-only mode: keeping existing keys and scheduled task settings, then refreshing worker defaults."
  Update-ExistingEnvFileDefaults -Path $envPath
} else {
  $supabaseServiceRoleKey = Read-SupabaseServiceRoleKey -SupabaseUrl $SupabaseUrl
  $geminiApiKey = Read-PlainSecret "Paste Gemini API key"
  $runTest = Read-YesNo "Run a one-page visual snapshot test after install?" $true
  Write-Host "Only the daily visual screenshot checker will be scheduled. The legacy hourly source/text worker will be removed."
  Write-EnvFile -Path $envPath -SupabaseUrl $SupabaseUrl -SupabaseServiceRoleKey $supabaseServiceRoleKey -GeminiApiKey $geminiApiKey
}

Write-UninstallScript -InstallRoot $InstallRoot
Write-LauncherScripts -InstallRoot $InstallRoot
Install-Dependencies -AppDir $appDir
Remove-LegacySourceTask -InstallRoot $InstallRoot
Register-VisualSnapshotTask -InstallRoot $InstallRoot

if ((-not $UpdateOnly) -and $runTest) {
  Write-Step "Running one-page visual snapshot test"
  $visualRunScript = Join-Path $InstallRoot "Run-AwardPingVisualSnapshots.ps1"
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $visualRunScript -All -Limit 1
  if ($LASTEXITCODE -ne 0) {
    throw "The one-page visual snapshot test failed. Check logs under $logDir."
  }
}

Write-Step "Done"
Write-Host "Installed at: $InstallRoot"
Write-Host "Run the daily screenshot checker manually with:"
Write-Host "`"$InstallRoot\3-RUN-VISUAL-SNAPSHOT-CHECK-NOW.bat`""
Write-Host "Run a fresh visual baseline refresh with:"
Write-Host "`"$InstallRoot\5-RUN-VISUAL-BASELINE-REFRESH-NOW.bat`""
Write-Host "Run a fresh PDF-only baseline refresh with:"
Write-Host "`"$InstallRoot\7-RUN-PDF-BASELINE-REFRESH-NOW.bat`""
Write-Host "Check visual worker status with:"
Write-Host "`"$InstallRoot\6-SHOW-VISUAL-SNAPSHOT-STATUS.bat`""
Write-Host "Logs are in: $logDir"
