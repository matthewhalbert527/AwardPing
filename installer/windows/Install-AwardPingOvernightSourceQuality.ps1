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

function Publish-StagedFileAtomically {
  param(
    [string]$StagedPath,
    [string]$DestinationPath,
    [string]$Token
  )

  $publishPath = "$DestinationPath.update-$Token"
  $replaceBackupPath = "$DestinationPath.pre-update-$Token"
  try {
    Copy-Item -LiteralPath $StagedPath -Destination $publishPath -Force -ErrorAction Stop
    if (Test-Path -LiteralPath $DestinationPath) {
      Remove-Item -LiteralPath $replaceBackupPath -Force -ErrorAction SilentlyContinue
      [System.IO.File]::Replace($publishPath, $DestinationPath, $replaceBackupPath, $true)
    } else {
      [System.IO.File]::Move($publishPath, $DestinationPath)
    }
  } finally {
    Remove-Item -LiteralPath $publishPath -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $replaceBackupPath -Force -ErrorAction SilentlyContinue
  }
}

function Test-OvernightTaskTargetsInstallRoot {
  param(
    [object]$Task,
    [string]$InstallRoot
  )

  if (-not $Task -or [string]$Task.TaskName -ne "AwardPing Overnight Source Quality Pass") {
    return $false
  }
  $targetRunner = Join-Path ([System.IO.Path]::GetFullPath($InstallRoot).TrimEnd("\", "/")) "Run-AwardPingOvernightSourceQuality.ps1"
  foreach ($action in @($Task.Actions)) {
    $command = ("{0} {1}" -f [string]$action.Execute, [string]$action.Arguments).Replace("/", "\")
    if ($command.IndexOf($targetRunner, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
      return $true
    }
  }
  return $false
}

function Get-OvernightTaskSnapshot {
  param(
    [string]$TaskName,
    [string]$InstallRoot
  )

  $tasks = @(Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue)
  foreach ($task in $tasks) {
    $taskPath = if ([string]::IsNullOrWhiteSpace([string]$task.TaskPath)) { "\" } else { [string]$task.TaskPath }
    if ($taskPath -ne "\" -or -not (Test-OvernightTaskTargetsInstallRoot -Task $task -InstallRoot $InstallRoot)) {
      throw "Refusing to overwrite scheduled task '$taskPath$TaskName' because it is not the AwardPing overnight task for this install root: $InstallRoot"
    }
  }
  if ($tasks.Count -gt 1) {
    throw "Refusing to update duplicate scheduled tasks named '$TaskName'."
  }
  if ($tasks.Count -eq 0) {
    return [pscustomobject]@{
      Existed = $false
      TaskName = $TaskName
      TaskPath = "\"
      Xml = $null
      WasEnabled = $false
      WasRunning = $false
    }
  }

  $task = $tasks[0]
  $taskPath = if ([string]::IsNullOrWhiteSpace([string]$task.TaskPath)) { "\" } else { [string]$task.TaskPath }
  $xml = [string](Export-ScheduledTask -TaskName $TaskName -TaskPath $taskPath -ErrorAction Stop)
  [xml]$document = $xml
  $namespace = [System.Xml.XmlNamespaceManager]::new($document.NameTable)
  $namespace.AddNamespace("task", $document.DocumentElement.NamespaceURI)
  $enabledNode = $document.SelectSingleNode("/task:Task/task:Settings/task:Enabled", $namespace)
  return [pscustomobject]@{
    Existed = $true
    TaskName = $TaskName
    TaskPath = $taskPath
    Xml = $xml
    WasEnabled = -not $enabledNode -or $enabledNode.InnerText -ne "false"
    WasRunning = [string]$task.State -eq "Running"
  }
}

function Get-DisabledScheduledTaskXml {
  param([string]$Xml)

  [xml]$document = $Xml
  $namespace = [System.Xml.XmlNamespaceManager]::new($document.NameTable)
  $namespace.AddNamespace("task", $document.DocumentElement.NamespaceURI)
  $settingsNode = $document.SelectSingleNode("/task:Task/task:Settings", $namespace)
  $enabledNode = $document.SelectSingleNode("/task:Task/task:Settings/task:Enabled", $namespace)
  if (-not $enabledNode -and $settingsNode) {
    $enabledNode = $document.CreateElement("Enabled", $document.DocumentElement.NamespaceURI)
    $settingsNode.AppendChild($enabledNode) | Out-Null
  }
  if ($enabledNode) { $enabledNode.InnerText = "false" }
  return $document.OuterXml
}

function Suspend-OvernightTaskForUpdate {
  param([object]$Snapshot)

  if (-not $Snapshot.Existed) { return }
  Disable-ScheduledTask -TaskName $Snapshot.TaskName -TaskPath $Snapshot.TaskPath -ErrorAction Stop | Out-Null
  if ($Snapshot.WasRunning) {
    Stop-ScheduledTask -TaskName $Snapshot.TaskName -TaskPath $Snapshot.TaskPath -ErrorAction Stop
  }
}

function Get-InstalledOvernightProcesses {
  param([string]$InstallRoot)

  $normalizedRoot = [System.IO.Path]::GetFullPath($InstallRoot).TrimEnd("\", "/").Replace("/", "\")
  $markers = @(
    "$normalizedRoot\Run-AwardPingOvernightSourceQuality.ps1",
    "$normalizedRoot\app\scripts\run-overnight-source-quality-pass.mjs"
  )
  return @(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object {
    if ($_.ProcessId -eq $PID -or [string]::IsNullOrWhiteSpace([string]$_.CommandLine)) {
      return $false
    }
    $commandLine = ([string]$_.CommandLine).Replace("/", "\")
    foreach ($marker in $markers) {
      if ($commandLine.IndexOf($marker, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
        return $true
      }
    }
    return $false
  })
}

function Wait-ForInstalledOvernightProcessesToStop {
  param(
    [string]$InstallRoot,
    [int]$GraceSeconds = 30
  )

  $deadline = (Get-Date).AddSeconds($GraceSeconds)
  do {
    $processes = @(Get-InstalledOvernightProcesses -InstallRoot $InstallRoot)
    if ($processes.Count -eq 0) { return }
    Start-Sleep -Milliseconds 500
  } while ((Get-Date) -lt $deadline)

  foreach ($process in @(Get-InstalledOvernightProcesses -InstallRoot $InstallRoot)) {
    Stop-Process -Id $process.ProcessId -Force -ErrorAction Stop
  }
  Start-Sleep -Milliseconds 500
  $remaining = @(Get-InstalledOvernightProcesses -InstallRoot $InstallRoot)
  if ($remaining.Count -gt 0) {
    throw "AwardPing overnight processes are still using the published bundle: $($remaining.ProcessId -join ', ')"
  }
}

function New-OvernightBundleSnapshot {
  param(
    [object[]]$Entries,
    [string]$SnapshotDirectory
  )

  if (Test-Path -LiteralPath $SnapshotDirectory) {
    throw "Refusing to replace an existing overnight rollback snapshot: $SnapshotDirectory"
  }
  New-Item -ItemType Directory -Path $SnapshotDirectory -ErrorAction Stop | Out-Null
  $snapshotEntries = @()
  for ($index = 0; $index -lt $Entries.Count; $index += 1) {
    $entry = $Entries[$index]
    $snapshotPath = Join-Path $SnapshotDirectory ("{0:D2}-{1}" -f $index, [System.IO.Path]::GetFileName($entry.DestinationPath))
    $existed = Test-Path -LiteralPath $entry.DestinationPath -PathType Leaf
    $hash = $null
    if ($existed) {
      Copy-Item -LiteralPath $entry.DestinationPath -Destination $snapshotPath -Force -ErrorAction Stop
      $hash = (Get-FileHash -LiteralPath $entry.DestinationPath -Algorithm SHA256 -ErrorAction Stop).Hash
      if ((Get-FileHash -LiteralPath $snapshotPath -Algorithm SHA256 -ErrorAction Stop).Hash -ne $hash) {
        throw "Overnight rollback snapshot hash mismatch: $($entry.DestinationPath)"
      }
    }
    $snapshotEntries += [pscustomobject]@{
      DestinationPath = $entry.DestinationPath
      SnapshotPath = $snapshotPath
      Existed = $existed
      Hash = $hash
    }
  }
  return [pscustomobject]@{ Directory = $SnapshotDirectory; Entries = $snapshotEntries }
}

function Remove-OvernightBundleTargets {
  param([object[]]$Entries)

  foreach ($entry in $Entries) {
    if (Test-Path -LiteralPath $entry.DestinationPath) {
      Remove-Item -LiteralPath $entry.DestinationPath -Force -ErrorAction Stop
    }
  }
}

function Restore-OvernightBundleSnapshot {
  param(
    [object]$Snapshot,
    [string]$Token
  )

  if (-not $Snapshot -or -not (Test-Path -LiteralPath $Snapshot.Directory -PathType Container)) {
    throw "The overnight bundle rollback snapshot is unavailable."
  }
  foreach ($entry in @($Snapshot.Entries)) {
    if ($entry.Existed) {
      if (-not (Test-Path -LiteralPath $entry.SnapshotPath -PathType Leaf)) {
        throw "Overnight rollback file is missing: $($entry.SnapshotPath)"
      }
      if ((Get-FileHash -LiteralPath $entry.SnapshotPath -Algorithm SHA256 -ErrorAction Stop).Hash -ne $entry.Hash) {
        throw "Overnight rollback file hash mismatch: $($entry.SnapshotPath)"
      }
    }
  }

  foreach ($entry in @($Snapshot.Entries)) {
    $publishPath = "$($entry.DestinationPath).rollback-$Token"
    $replaceBackupPath = "$($entry.DestinationPath).pre-rollback-$Token"
    try {
      if ($entry.Existed) {
        Copy-Item -LiteralPath $entry.SnapshotPath -Destination $publishPath -Force -ErrorAction Stop
        if (Test-Path -LiteralPath $entry.DestinationPath) {
          Remove-Item -LiteralPath $replaceBackupPath -Force -ErrorAction SilentlyContinue
          [System.IO.File]::Replace($publishPath, $entry.DestinationPath, $replaceBackupPath, $true)
        } else {
          [System.IO.File]::Move($publishPath, $entry.DestinationPath)
        }
      } elseif (Test-Path -LiteralPath $entry.DestinationPath) {
        Remove-Item -LiteralPath $entry.DestinationPath -Force -ErrorAction Stop
      }
    } finally {
      Remove-Item -LiteralPath $publishPath -Force -ErrorAction SilentlyContinue
      Remove-Item -LiteralPath $replaceBackupPath -Force -ErrorAction SilentlyContinue
    }
  }

  foreach ($entry in @($Snapshot.Entries)) {
    if ($entry.Existed) {
      if (-not (Test-Path -LiteralPath $entry.DestinationPath -PathType Leaf)) {
        throw "Restored overnight bundle file is missing: $($entry.DestinationPath)"
      }
      if ((Get-FileHash -LiteralPath $entry.DestinationPath -Algorithm SHA256 -ErrorAction Stop).Hash -ne $entry.Hash) {
        throw "Restored overnight bundle hash mismatch: $($entry.DestinationPath)"
      }
    } elseif (Test-Path -LiteralPath $entry.DestinationPath) {
      throw "A file created by the failed overnight update is still present: $($entry.DestinationPath)"
    }
  }
}

function Get-OvernightBundleProblems {
  param(
    [object[]]$Entries,
    [bool]$VerifyExpectedHashes
  )

  $problems = @()
  foreach ($entry in $Entries) {
    if (-not (Test-Path -LiteralPath $entry.DestinationPath -PathType Leaf)) {
      $problems += "missing bundle file: $($entry.DestinationPath)"
      continue
    }
    if ((Get-Item -LiteralPath $entry.DestinationPath -ErrorAction Stop).Length -eq 0) {
      $problems += "empty bundle file: $($entry.DestinationPath)"
      continue
    }
    if ($VerifyExpectedHashes -and $entry.ExpectedHash) {
      $actualHash = (Get-FileHash -LiteralPath $entry.DestinationPath -Algorithm SHA256 -ErrorAction Stop).Hash
      if ($actualHash -ne $entry.ExpectedHash) {
        $problems += "bundle hash mismatch: $($entry.DestinationPath)"
      }
    }
  }

  foreach ($entry in @($Entries | Where-Object { $_.Kind -eq "json" })) {
    if (-not (Test-Path -LiteralPath $entry.DestinationPath -PathType Leaf)) { continue }
    try {
      Get-Content -LiteralPath $entry.DestinationPath -Raw -ErrorAction Stop | ConvertFrom-Json | Out-Null
    } catch {
      $problems += "invalid JSON bundle file: $($entry.DestinationPath)"
    }
  }
  foreach ($entry in @($Entries | Where-Object { $_.Kind -eq "powershell" })) {
    if (-not (Test-Path -LiteralPath $entry.DestinationPath -PathType Leaf)) { continue }
    $tokens = $null
    $parseErrors = $null
    [System.Management.Automation.Language.Parser]::ParseFile(
      $entry.DestinationPath,
      [ref]$tokens,
      [ref]$parseErrors
    ) | Out-Null
    if (@($parseErrors).Count -gt 0) {
      $problems += "invalid PowerShell bundle file: $($entry.DestinationPath) ($($parseErrors[0].Message))"
    }
  }
  foreach ($entry in @($Entries | Where-Object { $_.Kind -eq "module" })) {
    if (-not (Test-Path -LiteralPath $entry.DestinationPath -PathType Leaf)) { continue }
    & node.exe --check $entry.DestinationPath 2>$null
    if ($LASTEXITCODE -ne 0) {
      $problems += "invalid JavaScript bundle file: $($entry.DestinationPath)"
    }
  }
  return $problems
}

function Restore-OvernightTaskAfterFailure {
  param(
    [object]$Snapshot,
    [bool]$TaskRegisteredByTransaction,
    [bool]$RestoreOperationalState,
    [string]$InstallRoot
  )

  if ($Snapshot.Existed) {
    $disabledXml = Get-DisabledScheduledTaskXml -Xml $Snapshot.Xml
    Register-ScheduledTask `
      -TaskName $Snapshot.TaskName `
      -TaskPath $Snapshot.TaskPath `
      -Xml $disabledXml `
      -Force `
      -ErrorAction Stop | Out-Null
    if ($RestoreOperationalState -and $Snapshot.WasEnabled) {
      Enable-ScheduledTask -TaskName $Snapshot.TaskName -TaskPath $Snapshot.TaskPath -ErrorAction Stop | Out-Null
      if ($Snapshot.WasRunning) {
        Start-ScheduledTask -TaskName $Snapshot.TaskName -TaskPath $Snapshot.TaskPath -ErrorAction Stop
      }
    }
    return
  }

  if ($TaskRegisteredByTransaction) {
    $current = @(Get-ScheduledTask -TaskName $Snapshot.TaskName -ErrorAction SilentlyContinue | Where-Object {
      Test-OvernightTaskTargetsInstallRoot -Task $_ -InstallRoot $InstallRoot
    })
    foreach ($task in $current) {
      $taskPath = if ([string]::IsNullOrWhiteSpace([string]$task.TaskPath)) { "\" } else { [string]$task.TaskPath }
      Disable-ScheduledTask -TaskName $task.TaskName -TaskPath $taskPath -ErrorAction SilentlyContinue | Out-Null
      Stop-ScheduledTask -TaskName $task.TaskName -TaskPath $taskPath -ErrorAction SilentlyContinue
      Unregister-ScheduledTask -TaskName $task.TaskName -TaskPath $taskPath -Confirm:$false -ErrorAction Stop
    }
  }
}

function Set-OvernightTaskOperationalState {
  param(
    [string]$TaskName,
    [string]$TaskPath,
    [bool]$Enabled,
    [bool]$Running
  )

  if ($Enabled) {
    Enable-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath -ErrorAction Stop | Out-Null
    if ($Running) {
      Start-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath -ErrorAction Stop
    }
  } else {
    Disable-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath -ErrorAction Stop | Out-Null
    Stop-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath -ErrorAction SilentlyContinue
  }
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
$sourceDecisionMemory = Join-Path $repoRoot "config\award-decision-memory.json"
$targetDecisionMemory = Join-Path $installedConfigDir "award-decision-memory.json"

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

if (-not (Test-Path -LiteralPath $sourceDecisionMemory)) {
  throw "Missing source decision memory: $sourceDecisionMemory"
}

Write-Step "Publishing overnight source-quality bundle transaction"
New-Item -ItemType Directory -Force -Path $InstallRoot | Out-Null
New-Item -ItemType Directory -Force -Path $installedScriptsDir | Out-Null
New-Item -ItemType Directory -Force -Path $installedScriptsLibDir | Out-Null
New-Item -ItemType Directory -Force -Path $installedConfigDir | Out-Null

$bundleToken = "{0}-{1}" -f $PID, [Guid]::NewGuid().ToString("N")
$bundleStageDir = Join-Path $InstallRoot ".overnight-policy-update-$bundleToken"
$bundleRollbackDir = Join-Path $InstallRoot ".overnight-policy-rollback-$bundleToken"
$runNowBatPath = Join-Path $InstallRoot "9-RUN-OVERNIGHT-SOURCE-QUALITY-NOW.bat"
$dryRunArg = if ($DryRun) { " -DryRun" } else { "" }
$runAt = [DateTime]::Parse($At)
$actionArgs = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$targetRunner`" -Hours $Hours -MaxAwards $MaxAwards -MinOpenSources $MinOpenSources -Safety `"$Safety`"$dryRunArg"
$taskSnapshot = $null
$taskSnapshotCaptured = $false
$taskRegisteredByTransaction = $false
$bundleSnapshot = $null
$bundleSnapshotCaptured = $false
$bundleMutationStarted = $false
$transactionCommitted = $false
$rollbackSucceeded = $false
$transactionFailure = $null
$rollbackFailure = $null

try {
  New-Item -ItemType Directory -Path $bundleStageDir -ErrorAction Stop | Out-Null
  $stagedRunner = Join-Path $bundleStageDir "Run-AwardPingOvernightSourceQuality.ps1"
  $stagedWorker = Join-Path $bundleStageDir "run-overnight-source-quality-pass.mjs"
  $stagedPolicyHelper = Join-Path $bundleStageDir "award-monitoring-policy.mjs"
  $stagedPolicyConfig = Join-Path $bundleStageDir "award-monitoring-policy.json"
  $stagedDecisionMemory = Join-Path $bundleStageDir "award-decision-memory.json"
  $stagedRunNowBat = Join-Path $bundleStageDir "9-RUN-OVERNIGHT-SOURCE-QUALITY-NOW.bat"
  Copy-Item -LiteralPath $sourceRunner -Destination $stagedRunner -Force -ErrorAction Stop
  Copy-Item -LiteralPath $sourceWorker -Destination $stagedWorker -Force -ErrorAction Stop
  Copy-Item -LiteralPath $sourcePolicyHelper -Destination $stagedPolicyHelper -Force -ErrorAction Stop
  Copy-Item -LiteralPath $sourcePolicyConfig -Destination $stagedPolicyConfig -Force -ErrorAction Stop
  Copy-Item -LiteralPath $sourceDecisionMemory -Destination $stagedDecisionMemory -Force -ErrorAction Stop
  $runNowBatContent = @"
@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$targetRunner" -Hours $Hours -MaxAwards $MaxAwards -MinOpenSources $MinOpenSources -Safety "$Safety"$dryRunArg
echo.
pause
"@
  Set-Content -LiteralPath $stagedRunNowBat -Value $runNowBatContent -Encoding ASCII -ErrorAction Stop

  $bundleEntries = @(
    [pscustomobject]@{ Kind = "json"; SourcePath = $sourceDecisionMemory; StagedPath = $stagedDecisionMemory; DestinationPath = $targetDecisionMemory },
    [pscustomobject]@{ Kind = "json"; SourcePath = $sourcePolicyConfig; StagedPath = $stagedPolicyConfig; DestinationPath = $targetPolicyConfig },
    [pscustomobject]@{ Kind = "module"; SourcePath = $sourcePolicyHelper; StagedPath = $stagedPolicyHelper; DestinationPath = $targetPolicyHelper },
    [pscustomobject]@{ Kind = "module"; SourcePath = $sourceWorker; StagedPath = $stagedWorker; DestinationPath = $targetWorker },
    [pscustomobject]@{ Kind = "powershell"; SourcePath = $sourceRunner; StagedPath = $stagedRunner; DestinationPath = $targetRunner },
    [pscustomobject]@{ Kind = "batch"; SourcePath = $stagedRunNowBat; StagedPath = $stagedRunNowBat; DestinationPath = $runNowBatPath }
  )
  foreach ($entry in $bundleEntries) {
    $entry | Add-Member -NotePropertyName ExpectedHash -NotePropertyValue (
      (Get-FileHash -LiteralPath $entry.StagedPath -Algorithm SHA256 -ErrorAction Stop).Hash
    )
  }
  $stagedValidationEntries = @($bundleEntries | ForEach-Object {
    [pscustomobject]@{
      Kind = $_.Kind
      DestinationPath = $_.StagedPath
      ExpectedHash = $_.ExpectedHash
    }
  })
  $stageProblems = @(Get-OvernightBundleProblems -Entries $stagedValidationEntries -VerifyExpectedHashes $true)
  if ($stageProblems.Count -gt 0) {
    throw "The staged overnight bundle is invalid: $($stageProblems -join ' | ')"
  }

  $taskSnapshot = Get-OvernightTaskSnapshot -TaskName $TaskName -InstallRoot $InstallRoot
  $taskSnapshotCaptured = $true
  $bundleSnapshot = New-OvernightBundleSnapshot -Entries $bundleEntries -SnapshotDirectory $bundleRollbackDir
  $bundleSnapshotCaptured = $true
  Suspend-OvernightTaskForUpdate -Snapshot $taskSnapshot

  # Remove both normal entry points before stopping a prior run. Once they are
  # absent, neither Task Scheduler nor the installed manual shortcut can launch
  # a partially published bundle.
  $bundleMutationStarted = $true
  foreach ($entryPath in @($targetRunner, $runNowBatPath)) {
    if (Test-Path -LiteralPath $entryPath) {
      Remove-Item -LiteralPath $entryPath -Force -ErrorAction Stop
    }
  }
  Wait-ForInstalledOvernightProcessesToStop -InstallRoot $InstallRoot
  Remove-OvernightBundleTargets -Entries $bundleEntries

  # Dependencies become visible first. Entry points become visible only after
  # the complete dependency set is present.
  foreach ($entry in $bundleEntries) {
    Publish-StagedFileAtomically `
      -StagedPath $entry.StagedPath `
      -DestinationPath $entry.DestinationPath `
      -Token $bundleToken
  }
  $installedProblems = @(Get-OvernightBundleProblems -Entries $bundleEntries -VerifyExpectedHashes $true)
  if ($installedProblems.Count -gt 0) {
    throw "The published overnight bundle failed validation: $($installedProblems -join ' | ')"
  }

  if ($SkipTaskRegistration) {
    if ($taskSnapshot.Existed) {
      Set-OvernightTaskOperationalState `
        -TaskName $taskSnapshot.TaskName `
        -TaskPath $taskSnapshot.TaskPath `
        -Enabled $taskSnapshot.WasEnabled `
        -Running ($taskSnapshot.WasEnabled -and $taskSnapshot.WasRunning)
    }
    Write-Host "Skipped scheduled task registration."
  } else {
    if (-not $taskSnapshot.Existed) {
      $lateCollision = @(Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue)
      if ($lateCollision.Count -gt 0) {
        throw "The scheduled task name '$TaskName' was claimed while the bundle update was in progress."
      }
    }
    $action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $actionArgs
    $trigger = New-ScheduledTaskTrigger -Daily -At $runAt
    $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 13)
    $settings.DisallowStartIfOnBatteries = $false
    $settings.StopIfGoingOnBatteries = $false
    $settings.Hidden = $true
    $settings.Enabled = $false
    Register-ScheduledTask `
      -TaskName $TaskName `
      -TaskPath "\" `
      -Action $action `
      -Trigger $trigger `
      -Settings $settings `
      -Description "Runs the AwardPing overnight source-quality cleanup pass beside the visual snapshot runner." `
      -Force `
      -ErrorAction Stop | Out-Null
    $taskRegisteredByTransaction = $true
    $enableUpdatedTask = if ($taskSnapshot.Existed) { $taskSnapshot.WasEnabled } else { $true }
    Set-OvernightTaskOperationalState `
      -TaskName $TaskName `
      -TaskPath "\" `
      -Enabled $enableUpdatedTask `
      -Running ($enableUpdatedTask -and $taskSnapshot.WasRunning)
    Write-Host "Scheduled task created: $TaskName daily at $($runAt.ToShortTimeString())"
    Write-Host "This runs alongside the existing 6 PM visual snapshot shard tasks."
  }

  $transactionCommitted = $true
} catch {
  $transactionFailure = $_
} finally {
  if ($transactionFailure -and $taskSnapshotCaptured) {
    $rollbackErrors = @()
    try {
      $currentTasks = @(Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue | Where-Object {
        Test-OvernightTaskTargetsInstallRoot -Task $_ -InstallRoot $InstallRoot
      })
      foreach ($task in $currentTasks) {
        $taskPath = if ([string]::IsNullOrWhiteSpace([string]$task.TaskPath)) { "\" } else { [string]$task.TaskPath }
        Disable-ScheduledTask -TaskName $task.TaskName -TaskPath $taskPath -ErrorAction Stop | Out-Null
        Stop-ScheduledTask -TaskName $task.TaskName -TaskPath $taskPath -ErrorAction SilentlyContinue
      }
      if ($bundleSnapshotCaptured) {
        $bundleMutationStarted = $true
        foreach ($entryPath in @($targetRunner, $runNowBatPath)) {
          if (Test-Path -LiteralPath $entryPath) {
            Remove-Item -LiteralPath $entryPath -Force -ErrorAction Stop
          }
        }
      }
      Wait-ForInstalledOvernightProcessesToStop -InstallRoot $InstallRoot
    } catch {
      $rollbackErrors += "quiesce failed transaction: $($_.Exception.Message)"
    }

    $bundleRestored = -not $bundleMutationStarted
    if ($bundleMutationStarted -and $bundleSnapshotCaptured -and $rollbackErrors.Count -eq 0) {
      try {
        Restore-OvernightBundleSnapshot -Snapshot $bundleSnapshot -Token $bundleToken
        $bundleRestored = $true
      } catch {
        $rollbackErrors += "restore prior bundle: $($_.Exception.Message)"
      }
    } elseif ($bundleMutationStarted -and -not $bundleSnapshotCaptured) {
      $rollbackErrors += "overnight bundle rollback snapshot was not captured"
    }

    $restoredBundleProblems = @()
    if ($bundleRestored) {
      try {
        $restoredBundleProblems = @(Get-OvernightBundleProblems -Entries $bundleEntries -VerifyExpectedHashes $false)
      } catch {
        $restoredBundleProblems += "validate restored bundle: $($_.Exception.Message)"
      }
    }
    $restoreOperationalState = `
      $bundleRestored -and `
      $restoredBundleProblems.Count -eq 0 -and `
      $rollbackErrors.Count -eq 0
    if ($restoredBundleProblems.Count -gt 0) {
      $rollbackErrors += $restoredBundleProblems
    }
    try {
      Restore-OvernightTaskAfterFailure `
        -Snapshot $taskSnapshot `
        -TaskRegisteredByTransaction $taskRegisteredByTransaction `
        -RestoreOperationalState $restoreOperationalState `
        -InstallRoot $InstallRoot
    } catch {
      $rollbackErrors += "restore prior task: $($_.Exception.Message)"
    }

    $rollbackSucceeded = $rollbackErrors.Count -eq 0
    if (-not $rollbackSucceeded) {
      try {
        $currentTasks = @(Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue | Where-Object {
          Test-OvernightTaskTargetsInstallRoot -Task $_ -InstallRoot $InstallRoot
        })
        foreach ($task in $currentTasks) {
          $taskPath = if ([string]::IsNullOrWhiteSpace([string]$task.TaskPath)) { "\" } else { [string]$task.TaskPath }
          Disable-ScheduledTask -TaskName $task.TaskName -TaskPath $taskPath -ErrorAction SilentlyContinue | Out-Null
          Stop-ScheduledTask -TaskName $task.TaskName -TaskPath $taskPath -ErrorAction SilentlyContinue
        }
      } catch {
        $rollbackErrors += "final task disable: $($_.Exception.Message)"
      }
      $rollbackFailure = "Overnight bundle rollback was incomplete: $($rollbackErrors -join ' | ')"
    }
  }

  if (Test-Path -LiteralPath $bundleStageDir) {
    Remove-Item -LiteralPath $bundleStageDir -Recurse -Force -ErrorAction SilentlyContinue
  }
  if (
    $bundleSnapshotCaptured -and
    ($transactionCommitted -or $rollbackSucceeded) -and
    (Test-Path -LiteralPath $bundleRollbackDir)
  ) {
    Remove-Item -LiteralPath $bundleRollbackDir -Recurse -Force -ErrorAction SilentlyContinue
  }
}

if ($transactionFailure) {
  if ($rollbackFailure) {
    throw "Overnight bundle update failed: $($transactionFailure.Exception.Message). $rollbackFailure"
  }
  throw $transactionFailure
}

Write-Host "Installed wrapper: $targetRunner"
Write-Host "Installed worker: $targetWorker"
Write-Host "Installed policy helper: $targetPolicyHelper"
Write-Host "Installed policy config: $targetPolicyConfig"
Write-Host "Installed decision memory: $targetDecisionMemory"
Write-Host "Created: $runNowBatPath"
if ($DryRun) {
  Write-Host "Mode: dry run. Reinstall without -DryRun when you want it to apply changes."
} else {
  Write-Host "Mode: apply changes."
}
Write-Host "Logs will be written to: $(Join-Path $InstallRoot "logs")"
