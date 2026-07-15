param(
  [string]$InstallRoot = "$env:LOCALAPPDATA\AwardPingWorker",
  [string]$SupabaseUrl = "https://zploenljxkqzyxcmbyec.supabase.co",
  [int]$SuppressionSweepLimit = 10000,
  [int]$SuppressionSweepBatchSize = 500,
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

function Test-AwardPingTaskTargetsInstallRoot {
  param(
    [object]$Task,
    [string]$InstallRoot
  )

  if (-not $Task -or [string]$Task.TaskName -notlike "AwardPing*") {
    return $false
  }

  $normalizedRoot = [System.IO.Path]::GetFullPath($InstallRoot).TrimEnd("\", "/").Replace("/", "\")
  $rootPrefix = "$normalizedRoot\"
  foreach ($action in @($Task.Actions)) {
    $command = ("{0} {1}" -f [string]$action.Execute, [string]$action.Arguments).Replace("/", "\")
    if ($command.IndexOf($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
      return $true
    }
  }

  return $false
}

function Get-AwardPingManagedTaskNames {
  return @(
    "AwardPing Visual Snapshot Worker Shard 1",
    "AwardPing Visual Snapshot Worker Shard 2",
    "AwardPing Visual Snapshot Worker Shard 3",
    "AwardPing Baseline Facts Watchdog",
    "AwardPing Downstream Queue Pipeline",
    "AwardPing Startup Supervisor"
  )
}

function Get-AwardPingTaskSnapshotKey {
  param(
    [string]$TaskName,
    [string]$TaskPath
  )

  $normalizedTaskPath = if ([string]::IsNullOrWhiteSpace($TaskPath)) { "\" } else { $TaskPath }
  return ("{0}|{1}" -f $normalizedTaskPath.Trim().ToLowerInvariant(), $TaskName.Trim().ToLowerInvariant())
}

function Assert-AwardPingManagedTaskRegistrationScope {
  param([string]$InstallRoot)

  foreach ($taskName in (Get-AwardPingManagedTaskNames)) {
    $collisions = @(Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue)
    foreach ($task in $collisions) {
      $taskPath = if ([string]::IsNullOrWhiteSpace([string]$task.TaskPath)) { "\" } else { [string]$task.TaskPath }
      if ($taskPath -ne "\") {
        throw "Refusing to overwrite scheduled task '$taskPath$taskName'. AwardPing managed tasks must use the root Task Scheduler path. Move or remove that custom-path task explicitly first."
      }
      if (-not (Test-AwardPingTaskTargetsInstallRoot -Task $task -InstallRoot $InstallRoot)) {
        throw "Refusing to overwrite scheduled task '$taskPath$taskName' because it does not target this install root: $InstallRoot"
      }
    }
  }

  $startupDirectory = [Environment]::GetFolderPath("Startup")
  if (-not [string]::IsNullOrWhiteSpace($startupDirectory)) {
    $startupLauncher = Join-Path $startupDirectory "AwardPing Startup Supervisor.vbs"
    if (Test-Path -LiteralPath $startupLauncher) {
      $normalizedRoot = [System.IO.Path]::GetFullPath($InstallRoot).TrimEnd("\", "/").Replace("/", "\")
      $launcherContent = (Get-Content -LiteralPath $startupLauncher -Raw -ErrorAction Stop).Replace("/", "\")
      if ($launcherContent.IndexOf("$normalizedRoot\", [System.StringComparison]::OrdinalIgnoreCase) -lt 0) {
        throw "Refusing to overwrite startup launcher '$startupLauncher' because it does not target this install root: $InstallRoot"
      }
    }
  }
}

function Suspend-AwardPingStartupLauncherForUpdate {
  param(
    [string]$InstallRoot,
    [string]$UpdateToken
  )

  $startupDirectory = [Environment]::GetFolderPath("Startup")
  if ([string]::IsNullOrWhiteSpace($startupDirectory)) {
    return [pscustomobject]@{ WasPresent = $false; OriginalPath = $null; DisabledPath = $null }
  }

  $originalPath = Join-Path $startupDirectory "AwardPing Startup Supervisor.vbs"
  if (-not (Test-Path -LiteralPath $originalPath)) {
    return [pscustomobject]@{ WasPresent = $false; OriginalPath = $originalPath; DisabledPath = $null }
  }

  $disabledPath = "$originalPath.awardping-update-$UpdateToken.disabled"
  if (Test-Path -LiteralPath $disabledPath) {
    throw "Refusing to replace an existing disabled startup-launcher snapshot: $disabledPath"
  }
  Move-Item -LiteralPath $originalPath -Destination $disabledPath -ErrorAction Stop
  return [pscustomobject]@{
    WasPresent = $true
    OriginalPath = $originalPath
    DisabledPath = $disabledPath
  }
}

function Complete-AwardPingStartupLauncherUpdate {
  param(
    [object]$Snapshot,
    [bool]$UpdateCommitted,
    [bool]$StartupTaskInstalled,
    [bool]$RestoreOperationalState
  )

  if (-not $Snapshot -or -not $Snapshot.WasPresent) {
    return
  }
  if (-not (Test-Path -LiteralPath $Snapshot.DisabledPath)) {
    throw "Startup-launcher snapshot is missing: $($Snapshot.DisabledPath)"
  }

  if ($UpdateCommitted -and $StartupTaskInstalled) {
    Remove-Item -LiteralPath $Snapshot.DisabledPath -Force -ErrorAction Stop
    return
  }
  if (-not $UpdateCommitted -and -not $RestoreOperationalState) {
    Write-Host "Kept the Startup-folder launcher disabled because the installed runtime did not validate: $($Snapshot.DisabledPath)" -ForegroundColor Yellow
    return
  }
  if (Test-Path -LiteralPath $Snapshot.OriginalPath) {
    throw "Refusing to overwrite a startup launcher created while the update was in progress: $($Snapshot.OriginalPath)"
  }
  Move-Item -LiteralPath $Snapshot.DisabledPath -Destination $Snapshot.OriginalPath -ErrorAction Stop
}

function Get-AwardPingTaskSnapshotsForUpdate {
  param([string]$InstallRoot)

  $tasks = @(Get-ScheduledTask -ErrorAction Stop | Where-Object {
    [string]$_.TaskName -like "AwardPing*" -and
    (Test-AwardPingTaskTargetsInstallRoot -Task $_ -InstallRoot $InstallRoot)
  })
  $snapshots = @()
  foreach ($task in $tasks) {
    $taskPath = if ([string]::IsNullOrWhiteSpace([string]$task.TaskPath)) { "\" } else { [string]$task.TaskPath }
    $taskXml = [string](Export-ScheduledTask -TaskName $task.TaskName -TaskPath $taskPath -ErrorAction Stop)
    [xml]$taskDocument = $taskXml
    $taskNamespace = [System.Xml.XmlNamespaceManager]::new($taskDocument.NameTable)
    $taskNamespace.AddNamespace("task", $taskDocument.DocumentElement.NamespaceURI)
    $enabledNode = $taskDocument.SelectSingleNode("/task:Task/task:Settings/task:Enabled", $taskNamespace)
    $wasEnabled = -not $enabledNode -or $enabledNode.InnerText -ne "false"
    $snapshots += [pscustomobject]@{
      TaskName = [string]$task.TaskName
      TaskPath = $taskPath
      Xml = $taskXml
      WasEnabled = $wasEnabled
      WasRunning = [string]$task.State -eq "Running"
      ExistedBeforeUpdate = $true
      RestoreAfterUpdate = [string]$task.TaskName -notin @(
        "AwardPing Local Source Worker",
        "AwardPing Local Worker Auto Update",
        "AwardPing Visual Snapshot Worker"
      )
    }
  }

  return $snapshots
}

function Get-AwardPingTaskSnapshotsForFinalization {
  param(
    [object[]]$InitialSnapshots,
    [string]$InstallRoot
  )

  $snapshots = @($InitialSnapshots)
  $initialKeys = @{}
  foreach ($snapshot in $InitialSnapshots) {
    $key = Get-AwardPingTaskSnapshotKey -TaskName $snapshot.TaskName -TaskPath $snapshot.TaskPath
    $initialKeys[$key] = $true
  }

  $managedTaskNames = @(Get-AwardPingManagedTaskNames)
  $currentTasks = @(Get-ScheduledTask -ErrorAction Stop | Where-Object {
    [string]$_.TaskName -in $managedTaskNames -and
    (Test-AwardPingTaskTargetsInstallRoot -Task $_ -InstallRoot $InstallRoot)
  })
  foreach ($task in $currentTasks) {
    $taskPath = if ([string]::IsNullOrWhiteSpace([string]$task.TaskPath)) { "\" } else { [string]$task.TaskPath }
    $key = Get-AwardPingTaskSnapshotKey -TaskName $task.TaskName -TaskPath $taskPath
    if ($initialKeys.ContainsKey($key)) {
      continue
    }

    $taskXml = [string](Export-ScheduledTask -TaskName $task.TaskName -TaskPath $taskPath -ErrorAction Stop)
    $snapshots += [pscustomobject]@{
      TaskName = [string]$task.TaskName
      TaskPath = $taskPath
      Xml = $taskXml
      WasEnabled = $true
      WasRunning = $false
      ExistedBeforeUpdate = $false
      RestoreAfterUpdate = $true
    }
  }

  return $snapshots
}

function Get-InstalledAwardPingWorkerProcesses {
  param([string]$InstallRoot)

  $normalizedRoot = [System.IO.Path]::GetFullPath($InstallRoot).TrimEnd("\", "/").Replace("/", "\")
  $markers = @(
    "$normalizedRoot\Run-AwardPing",
    "$normalizedRoot\Watch-AwardPing",
    "$normalizedRoot\Start-AwardPingOnBoot",
    "$normalizedRoot\app\scripts\"
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

function Wait-ForAwardPingWorkerProcessesToStop {
  param(
    [string]$InstallRoot,
    [int]$GraceSeconds = 30
  )

  $deadline = (Get-Date).AddSeconds($GraceSeconds)
  do {
    $processes = @(Get-InstalledAwardPingWorkerProcesses -InstallRoot $InstallRoot)
    if ($processes.Count -eq 0) {
      return
    }
    Start-Sleep -Milliseconds 500
  } while ((Get-Date) -lt $deadline)

  $processes = @(Get-InstalledAwardPingWorkerProcesses -InstallRoot $InstallRoot)
  if ($processes.Count -gt 0) {
    Write-Host "Stopping AwardPing worker processes that did not exit after scheduled tasks were stopped: $($processes.ProcessId -join ', ')" -ForegroundColor Yellow
    foreach ($process in $processes) {
      Stop-Process -Id $process.ProcessId -Force -ErrorAction Stop
    }
  }

  Start-Sleep -Milliseconds 500
  $remaining = @(Get-InstalledAwardPingWorkerProcesses -InstallRoot $InstallRoot)
  if ($remaining.Count -gt 0) {
    throw "AwardPing worker processes are still using the installed app: $($remaining.ProcessId -join ', ')"
  }
}

function Suspend-AwardPingTasksForUpdate {
  param(
    [object[]]$Snapshots,
    [string]$InstallRoot
  )

  Write-Step "Pausing installed AwardPing tasks for a safe update"
  foreach ($snapshot in $Snapshots) {
    Disable-ScheduledTask -TaskName $snapshot.TaskName -TaskPath $snapshot.TaskPath -ErrorAction Stop | Out-Null
  }
  foreach ($snapshot in $Snapshots | Where-Object { $_.WasRunning }) {
    Stop-ScheduledTask -TaskName $snapshot.TaskName -TaskPath $snapshot.TaskPath -ErrorAction SilentlyContinue
  }

  Wait-ForAwardPingWorkerProcessesToStop -InstallRoot $InstallRoot
  Write-Host "Paused $($Snapshots.Count) installed AwardPing scheduled task(s) and confirmed that no installed worker process is using the app."
}

function Disable-AwardPingTasksForInstallRoot {
  param([string]$InstallRoot)

  $tasks = @(Get-ScheduledTask -ErrorAction Stop | Where-Object {
    [string]$_.TaskName -like "AwardPing*" -and
    (Test-AwardPingTaskTargetsInstallRoot -Task $_ -InstallRoot $InstallRoot)
  })
  $errors = @()
  foreach ($task in $tasks) {
    $taskPath = if ([string]::IsNullOrWhiteSpace([string]$task.TaskPath)) { "\" } else { [string]$task.TaskPath }
    try {
      Disable-ScheduledTask -TaskName $task.TaskName -TaskPath $taskPath -ErrorAction Stop | Out-Null
    } catch {
      $errors += "disable $taskPath$($task.TaskName): $($_.Exception.Message)"
    }
  }
  foreach ($task in $tasks | Where-Object { [string]$_.State -eq "Running" }) {
    $taskPath = if ([string]::IsNullOrWhiteSpace([string]$task.TaskPath)) { "\" } else { [string]$task.TaskPath }
    try {
      Stop-ScheduledTask -TaskName $task.TaskName -TaskPath $taskPath -ErrorAction Stop
    } catch {
      $errors += "stop $taskPath$($task.TaskName): $($_.Exception.Message)"
    }
  }

  $notDisabled = @(Get-ScheduledTask -ErrorAction Stop | Where-Object {
    [string]$_.TaskName -like "AwardPing*" -and
    (Test-AwardPingTaskTargetsInstallRoot -Task $_ -InstallRoot $InstallRoot) -and
    [string]$_.State -ne "Disabled"
  })
  if ($notDisabled.Count -gt 0) {
    $errors += "tasks remain enabled: $($notDisabled.TaskName -join ', ')"
  }
  if ($errors.Count -gt 0) {
    throw "Could not quiesce every AwardPing task for this install root: $($errors -join ' | ')"
  }
}

function Remove-NewAwardPingTasksAfterFailedUpdate {
  param(
    [object[]]$InitialSnapshots,
    [string]$InstallRoot
  )

  $initialKeys = @{}
  foreach ($snapshot in $InitialSnapshots) {
    $key = Get-AwardPingTaskSnapshotKey -TaskName $snapshot.TaskName -TaskPath $snapshot.TaskPath
    $initialKeys[$key] = $true
  }

  $managedTaskNames = @(Get-AwardPingManagedTaskNames)
  $currentTasks = @(Get-ScheduledTask -ErrorAction Stop | Where-Object {
    [string]$_.TaskName -in $managedTaskNames -and
    (Test-AwardPingTaskTargetsInstallRoot -Task $_ -InstallRoot $InstallRoot)
  })
  foreach ($task in $currentTasks) {
    $taskPath = if ([string]::IsNullOrWhiteSpace([string]$task.TaskPath)) { "\" } else { [string]$task.TaskPath }
    $key = Get-AwardPingTaskSnapshotKey -TaskName $task.TaskName -TaskPath $taskPath
    if ($initialKeys.ContainsKey($key)) {
      continue
    }

    Disable-ScheduledTask -TaskName $task.TaskName -TaskPath $taskPath -ErrorAction SilentlyContinue | Out-Null
    Stop-ScheduledTask -TaskName $task.TaskName -TaskPath $taskPath -ErrorAction SilentlyContinue
    Unregister-ScheduledTask `
      -TaskName $task.TaskName `
      -TaskPath $taskPath `
      -Confirm:$false `
      -ErrorAction Stop
  }
}

function Get-AwardPingRootedActionPaths {
  param(
    [object[]]$Snapshots,
    [string]$InstallRoot
  )

  $normalizedRoot = [System.IO.Path]::GetFullPath($InstallRoot).TrimEnd("\", "/").Replace("/", "\")
  $paths = @{}
  foreach ($snapshot in $Snapshots) {
    try {
      [xml]$document = $snapshot.Xml
      $namespace = [System.Xml.XmlNamespaceManager]::new($document.NameTable)
      $namespace.AddNamespace("task", $document.DocumentElement.NamespaceURI)
      $nodes = @($document.SelectNodes("/task:Task/task:Actions/task:Exec/task:Command | /task:Task/task:Actions/task:Exec/task:Arguments", $namespace))
      foreach ($node in $nodes) {
        $matches = [regex]::Matches([string]$node.InnerText, '"([^"]+)"|''([^'']+)''|([A-Za-z]:\\[^\s"]+)')
        foreach ($match in $matches) {
          $candidate = @($match.Groups[1].Value, $match.Groups[2].Value, $match.Groups[3].Value) |
            Where-Object { -not [string]::IsNullOrWhiteSpace($_) } |
            Select-Object -First 1
          if ([string]::IsNullOrWhiteSpace($candidate)) {
            continue
          }
          $candidate = $candidate.Trim().TrimEnd(",", ";")
          if (
            $candidate.Equals($normalizedRoot, [System.StringComparison]::OrdinalIgnoreCase) -or
            $candidate.StartsWith("$normalizedRoot\", [System.StringComparison]::OrdinalIgnoreCase)
          ) {
            $paths[$candidate.ToLowerInvariant()] = $candidate
          }
        }
      }
    } catch {
      $paths["invalid-task-xml-$($snapshot.TaskPath)$($snapshot.TaskName)"] = $null
    }
  }

  return @($paths.Values)
}

function Get-AwardPingInstalledRuntimeProblems {
  param(
    [string]$InstallRoot,
    [string]$AppDir,
    [object[]]$TaskSnapshots,
    [bool]$RequireManagedRuntime,
    [string]$InstallerSourceDirectory = "",
    [string]$AppSourceRoot = ""
  )

  $problems = @()
  $requiredPaths = @(
    (Join-Path $AppDir ".env.worker.local"),
    (Join-Path $AppDir "package.json")
  )
  $startupDirectory = [Environment]::GetFolderPath("Startup")
  if (-not [string]::IsNullOrWhiteSpace($startupDirectory)) {
    $normalizedRoot = [System.IO.Path]::GetFullPath($InstallRoot).TrimEnd("\", "/").Replace("/", "\")
    $startupLaunchers = @(Get-ChildItem `
      -LiteralPath $startupDirectory `
      -Filter "AwardPing Startup Supervisor.vbs*" `
      -File `
      -ErrorAction SilentlyContinue)
    foreach ($startupLauncher in $startupLaunchers) {
      $launcherContent = (Get-Content -LiteralPath $startupLauncher.FullName -Raw -ErrorAction Stop).Replace("/", "\")
      if ($launcherContent.IndexOf("$normalizedRoot\", [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
        $requiredPaths += $startupLauncher.FullName
        $requiredPaths += (Join-Path $InstallRoot "Start-AwardPingOnBoot.ps1")
      }
    }
  }
  if ($RequireManagedRuntime) {
    $requiredPaths += @(
      (Join-Path $InstallRoot "Run-AwardPingVisualSnapshots.ps1"),
      (Join-Path $InstallRoot "Watch-AwardPingBaselineFacts.ps1"),
      (Join-Path $InstallRoot "Run-AwardPingBaselineFacts.ps1"),
      (Join-Path $InstallRoot "Run-AwardPingDownstreamQueues.ps1"),
      (Join-Path $InstallRoot "Start-AwardPingOnBoot.ps1"),
      (Join-Path $AppDir "scripts\capture-visual-snapshots.mjs"),
      (Join-Path $AppDir "scripts\lib\visual-capture-run-report.mjs"),
      (Join-Path $AppDir "scripts\report-visual-nightly.mjs"),
      (Join-Path $AppDir "scripts\backfill-baseline-facts.mjs"),
      (Join-Path $AppDir "scripts\process-visual-review-batch.mjs"),
      (Join-Path $AppDir "scripts\cleanup-change-event-noise.mjs"),
      (Join-Path $AppDir "scripts\reconcile-impacted-award-pages.mjs"),
      (Join-Path $AppDir "scripts\process-page-audit-batch.mjs"),
      (Join-Path $AppDir "config\award-monitoring-policy.json"),
      (Join-Path $AppDir "config\award-decision-memory.json")
    )
  }
  $requiredPaths += @(Get-AwardPingRootedActionPaths -Snapshots $TaskSnapshots -InstallRoot $InstallRoot)

  foreach ($path in @($requiredPaths | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -Unique)) {
    if (-not (Test-Path -LiteralPath $path)) {
      $problems += "missing action/runtime path: $path"
      continue
    }
    $item = Get-Item -LiteralPath $path -ErrorAction Stop
    if (-not $item.PSIsContainer -and $item.Length -eq 0) {
      $problems += "empty action/runtime file: $path"
      continue
    }
    if (-not $item.PSIsContainer -and $item.Extension -ieq ".ps1") {
      $tokens = $null
      $parseErrors = $null
      [System.Management.Automation.Language.Parser]::ParseFile(
        $item.FullName,
        [ref]$tokens,
        [ref]$parseErrors
      ) | Out-Null
      if (@($parseErrors).Count -gt 0) {
        $problems += "invalid PowerShell action script: $path ($($parseErrors[0].Message))"
      }
    }
  }

  foreach ($dependency in @(Get-MissingWorkerRuntimeDependencies -AppDir $AppDir)) {
    $problems += "missing worker runtime dependency: $dependency"
  }

  if ($RequireManagedRuntime) {
    $hashPairs = @()
    if (-not [string]::IsNullOrWhiteSpace($InstallerSourceDirectory)) {
      foreach ($fileName in @(
        "Watch-AwardPingBaselineFacts.ps1",
        "Run-AwardPingBaselineFacts.ps1",
        "Run-AwardPingDownstreamQueues.ps1",
        "Start-AwardPingOnBoot.ps1"
      )) {
        $hashPairs += [pscustomobject]@{
          Source = Join-Path $InstallerSourceDirectory $fileName
          Target = Join-Path $InstallRoot $fileName
        }
      }
    }
    if (-not [string]::IsNullOrWhiteSpace($AppSourceRoot)) {
      foreach ($relativePath in @(
        "scripts\capture-visual-snapshots.mjs",
        "scripts\lib\visual-capture-run-report.mjs",
        "scripts\report-visual-nightly.mjs",
        "scripts\backfill-baseline-facts.mjs",
        "scripts\process-visual-review-batch.mjs",
        "scripts\cleanup-change-event-noise.mjs",
        "scripts\reconcile-impacted-award-pages.mjs",
        "scripts\process-page-audit-batch.mjs",
        "config\award-monitoring-policy.json",
        "config\award-decision-memory.json"
      )) {
        $hashPairs += [pscustomobject]@{
          Source = Join-Path $AppSourceRoot $relativePath
          Target = Join-Path $AppDir $relativePath
        }
      }
    }
    foreach ($pair in $hashPairs) {
      if (-not (Test-Path -LiteralPath $pair.Source) -or -not (Test-Path -LiteralPath $pair.Target)) {
        $problems += "cannot verify installed runtime hash: $($pair.Source) -> $($pair.Target)"
        continue
      }
      $sourceHash = (Get-FileHash -LiteralPath $pair.Source -Algorithm SHA256 -ErrorAction Stop).Hash
      $targetHash = (Get-FileHash -LiteralPath $pair.Target -Algorithm SHA256 -ErrorAction Stop).Hash
      if ($sourceHash -ne $targetHash) {
        $problems += "installed runtime hash mismatch: $($pair.Target)"
      }
    }
  }

  return $problems
}

function Get-AwardPingTaskRestoreXml {
  param(
    [object]$Snapshot,
    [int]$SuppressionSweepLimit,
    [int]$SuppressionSweepBatchSize,
    [bool]$ApplyTaskDefinitionUpdates
  )

  [xml]$snapshotDocument = $Snapshot.Xml
  if ($ApplyTaskDefinitionUpdates) {
    [xml]$document = Export-ScheduledTask `
      -TaskName $Snapshot.TaskName `
      -TaskPath $Snapshot.TaskPath `
      -ErrorAction Stop
  } else {
    [xml]$document = $Snapshot.Xml
  }
  $namespace = [System.Xml.XmlNamespaceManager]::new($document.NameTable)
  $namespace.AddNamespace("task", $document.DocumentElement.NamespaceURI)

  if ($ApplyTaskDefinitionUpdates) {
    $snapshotNamespace = [System.Xml.XmlNamespaceManager]::new($snapshotDocument.NameTable)
    $snapshotNamespace.AddNamespace("task", $snapshotDocument.DocumentElement.NamespaceURI)
    foreach ($xpath in @("/task:Task/task:Principals", "/task:Task/task:Triggers")) {
      $snapshotNode = $snapshotDocument.SelectSingleNode($xpath, $snapshotNamespace)
      $currentNode = $document.SelectSingleNode($xpath, $namespace)
      if (-not $snapshotNode -or -not $currentNode) {
        continue
      }

      $replacement = $document.ImportNode($snapshotNode, $true)
      $currentNode.ParentNode.ReplaceChild($replacement, $currentNode) | Out-Null
    }
  }

  $settingsNode = $document.SelectSingleNode("/task:Task/task:Settings", $namespace)
  $enabledNode = $document.SelectSingleNode("/task:Task/task:Settings/task:Enabled", $namespace)
  if (-not $enabledNode -and $settingsNode) {
    $enabledNode = $document.CreateElement("Enabled", $document.DocumentElement.NamespaceURI)
    $settingsNode.AppendChild($enabledNode) | Out-Null
  }
  if ($enabledNode) { $enabledNode.InnerText = "false" }

  if ($ApplyTaskDefinitionUpdates -and $Snapshot.TaskName -eq "AwardPing Downstream Queue Pipeline") {
    $argumentsNode = $document.SelectSingleNode("/task:Task/task:Actions/task:Exec/task:Arguments", $namespace)
    if ($argumentsNode -and $argumentsNode.InnerText -match "(?i)-SuppressionSweepLimit\s+\S+") {
      $argumentsNode.InnerText = [regex]::Replace(
        $argumentsNode.InnerText,
        "(?i)(-SuppressionSweepLimit\s+)\S+",
        "`${1}$SuppressionSweepLimit"
      )
    } elseif ($argumentsNode) {
      $argumentsNode.InnerText = $argumentsNode.InnerText.TrimEnd() + " -SuppressionSweepLimit $SuppressionSweepLimit"
    }
    if ($argumentsNode -and $argumentsNode.InnerText -match "(?i)-SuppressionSweepBatchSize\s+\S+") {
      $argumentsNode.InnerText = [regex]::Replace(
        $argumentsNode.InnerText,
        "(?i)(-SuppressionSweepBatchSize\s+)\S+",
        "`${1}$SuppressionSweepBatchSize"
      )
    } elseif ($argumentsNode) {
      $argumentsNode.InnerText = $argumentsNode.InnerText.TrimEnd() + " -SuppressionSweepBatchSize $SuppressionSweepBatchSize"
    }
    $descriptionNode = $document.SelectSingleNode("/task:Task/task:RegistrationInfo/task:Description", $namespace)
    if ($descriptionNode) {
      $descriptionNode.InnerText = "Polls/submits Gemini Batch visual reviews, reapplies current suppression policy, reconciles pending public award facts, processes flagged page audits, and finalizes the 6 PM capture report."
    }
  }

  return $document.OuterXml
}

function Restore-AwardPingTasksAfterUpdate {
  param(
    [object[]]$Snapshots,
    [int]$SuppressionSweepLimit,
    [int]$SuppressionSweepBatchSize,
    [bool]$ApplyTaskDefinitionUpdates,
    [bool]$RestoreOperationalState,
    [bool]$RestoreRetiredTasks = $false
  )

  $restoreSnapshots = @(
    if ($RestoreRetiredTasks) {
      $Snapshots
    } else {
      $Snapshots | Where-Object { $_.RestoreAfterUpdate }
    }
  )
  if (-not $restoreSnapshots.Count) {
    return
  }

  Write-Step "Restoring installed AwardPing task definitions"
  $errors = @()
  foreach ($snapshot in $restoreSnapshots) {
    try {
      $xml = Get-AwardPingTaskRestoreXml `
        -Snapshot $snapshot `
        -SuppressionSweepLimit $SuppressionSweepLimit `
        -SuppressionSweepBatchSize $SuppressionSweepBatchSize `
        -ApplyTaskDefinitionUpdates $ApplyTaskDefinitionUpdates
      Register-ScheduledTask `
        -TaskName $snapshot.TaskName `
        -TaskPath $snapshot.TaskPath `
        -Xml $xml `
        -Force `
        -ErrorAction Stop | Out-Null
    } catch {
      $errors += "$($snapshot.TaskPath)$($snapshot.TaskName): $($_.Exception.Message)"
    }
  }

  if ($errors.Count -gt 0) {
    foreach ($snapshot in $restoreSnapshots) {
      Disable-ScheduledTask -TaskName $snapshot.TaskName -TaskPath $snapshot.TaskPath -ErrorAction SilentlyContinue | Out-Null
      Stop-ScheduledTask -TaskName $snapshot.TaskName -TaskPath $snapshot.TaskPath -ErrorAction SilentlyContinue
    }
    throw "Could not completely restore AwardPing scheduled task definitions: $($errors -join ' | ')"
  }

  foreach ($snapshot in $restoreSnapshots) {
    try {
      if ($RestoreOperationalState -and $snapshot.WasEnabled) {
        Enable-ScheduledTask -TaskName $snapshot.TaskName -TaskPath $snapshot.TaskPath -ErrorAction Stop | Out-Null
      } else {
        Disable-ScheduledTask -TaskName $snapshot.TaskName -TaskPath $snapshot.TaskPath -ErrorAction Stop | Out-Null
      }
    } catch {
      $errors += "$($snapshot.TaskPath)$($snapshot.TaskName) state: $($_.Exception.Message)"
    }
  }

  if ($errors.Count -gt 0) {
    foreach ($snapshot in $restoreSnapshots) {
      Disable-ScheduledTask -TaskName $snapshot.TaskName -TaskPath $snapshot.TaskPath -ErrorAction SilentlyContinue | Out-Null
      Stop-ScheduledTask -TaskName $snapshot.TaskName -TaskPath $snapshot.TaskPath -ErrorAction SilentlyContinue
    }
    throw "Could not completely restore AwardPing scheduled task states: $($errors -join ' | ')"
  }

  foreach ($snapshot in $restoreSnapshots | Where-Object { $RestoreOperationalState -and $_.WasRunning -and $_.WasEnabled }) {
    try {
      Start-ScheduledTask -TaskName $snapshot.TaskName -TaskPath $snapshot.TaskPath -ErrorAction Stop
    } catch {
      $errors += "$($snapshot.TaskPath)$($snapshot.TaskName) resume: $($_.Exception.Message)"
    }
  }

  if ($errors.Count -gt 0) {
    foreach ($snapshot in $restoreSnapshots) {
      Disable-ScheduledTask -TaskName $snapshot.TaskName -TaskPath $snapshot.TaskPath -ErrorAction SilentlyContinue | Out-Null
      Stop-ScheduledTask -TaskName $snapshot.TaskName -TaskPath $snapshot.TaskPath -ErrorAction SilentlyContinue
    }
    throw "Could not completely resume AwardPing scheduled tasks: $($errors -join ' | ')"
  }

  if ($RestoreOperationalState) {
    Write-Host "Restored $($restoreSnapshots.Count) AwardPing task schedule(s), principals, enabled states, and prior running states."
  } else {
    Write-Host "Restored $($restoreSnapshots.Count) AwardPing task definition(s) in a disabled state because no complete runnable app is available." -ForegroundColor Yellow
  }
}

function Invoke-AwardPingTaskSetRollback {
  param(
    [object[]]$InitialSnapshots,
    [string]$InstallRoot,
    [int]$SuppressionSweepLimit,
    [int]$SuppressionSweepBatchSize,
    [bool]$RestoreOperationalState
  )

  $errors = @()
  try {
    Disable-AwardPingTasksForInstallRoot -InstallRoot $InstallRoot
  } catch {
    $errors += "disable current task set: $($_.Exception.Message)"
  }
  try {
    Remove-NewAwardPingTasksAfterFailedUpdate `
      -InitialSnapshots $InitialSnapshots `
      -InstallRoot $InstallRoot
  } catch {
    $errors += "remove newly created tasks: $($_.Exception.Message)"
  }
  try {
    Restore-AwardPingTasksAfterUpdate `
      -Snapshots $InitialSnapshots `
      -SuppressionSweepLimit $SuppressionSweepLimit `
      -SuppressionSweepBatchSize $SuppressionSweepBatchSize `
      -ApplyTaskDefinitionUpdates $false `
      -RestoreOperationalState $RestoreOperationalState `
      -RestoreRetiredTasks $true
  } catch {
    $errors += "restore original task set: $($_.Exception.Message)"
  }

  if ($errors.Count -gt 0) {
    try {
      Disable-AwardPingTasksForInstallRoot -InstallRoot $InstallRoot
    } catch {
      $errors += "final disable: $($_.Exception.Message)"
    }
    throw "Could not roll back the AwardPing scheduled task set: $($errors -join ' | ')"
  }
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

function Copy-AwardPingMutableAppState {
  param(
    [string]$CurrentAppDir,
    [string]$StagingAppDir
  )

  Copy-Item `
    -LiteralPath (Join-Path $CurrentAppDir ".env.worker.local") `
    -Destination (Join-Path $StagingAppDir ".env.worker.local") `
    -Force `
    -ErrorAction Stop

  foreach ($directoryName in @(
    "reports",
    "tmp",
    "AwardPingVisualSnapshots",
    "visual-snapshots",
    "visual-snapshot-archive"
  )) {
    $currentPath = Join-Path $CurrentAppDir $directoryName
    if (-not (Test-Path -LiteralPath $currentPath)) {
      continue
    }

    Copy-Item `
      -LiteralPath $currentPath `
      -Destination (Join-Path $StagingAppDir $directoryName) `
      -Recurse `
      -Force `
      -ErrorAction Stop
  }
}

function Switch-ToStagedAwardPingApp {
  param(
    [string]$CurrentAppDir,
    [string]$StagingAppDir,
    [string]$BackupAppDir
  )

  if (-not (Test-Path -LiteralPath $StagingAppDir)) {
    throw "Staged AwardPing app is missing: $StagingAppDir"
  }
  if (Test-Path -LiteralPath $BackupAppDir) {
    throw "AwardPing rollback path already exists: $BackupAppDir"
  }

  Move-Item -LiteralPath $CurrentAppDir -Destination $BackupAppDir -ErrorAction Stop
  try {
    Move-Item -LiteralPath $StagingAppDir -Destination $CurrentAppDir -ErrorAction Stop
  } catch {
    if ((-not (Test-Path -LiteralPath $CurrentAppDir)) -and (Test-Path -LiteralPath $BackupAppDir)) {
      Move-Item -LiteralPath $BackupAppDir -Destination $CurrentAppDir -ErrorAction Stop
    }
    throw
  }
}

function Get-AwardPingManagedRootRuntimeNames {
  return @(
    "Uninstall-AwardPingWorker.ps1",
    "Run-AwardPingVisualSnapshots.ps1",
    "Watch-AwardPingBaselineFacts.ps1",
    "Run-AwardPingBaselineFacts.ps1",
    "Run-AwardPingDownstreamQueues.ps1",
    "Start-AwardPingOnBoot.ps1",
    "Show-AwardPingVisualStatus.ps1",
    "Show-AwardPingGeminiUsage.ps1",
    "3-RUN-VISUAL-SNAPSHOT-CHECK-NOW.bat",
    "4-SHOW-GEMINI-USAGE.bat",
    "5-RUN-VISUAL-BASELINE-REFRESH-NOW.bat",
    "6-SHOW-VISUAL-SNAPSHOT-STATUS.bat",
    "7-RUN-PDF-BASELINE-REFRESH-NOW.bat",
    "8-COMPLETE-MISSING-VISUAL-BASELINES-NOW.bat",
    "OPEN-LOGS.bat",
    "README-INSTALLED-RUNNER.txt"
  )
}

function New-AwardPingRootRuntimeSnapshot {
  param(
    [string]$InstallRoot,
    [string]$SnapshotDirectory
  )

  if (Test-Path -LiteralPath $SnapshotDirectory) {
    throw "Refusing to replace an existing root-runtime rollback snapshot: $SnapshotDirectory"
  }
  New-Item -ItemType Directory -Path $SnapshotDirectory -ErrorAction Stop | Out-Null

  $entries = @()
  foreach ($name in (Get-AwardPingManagedRootRuntimeNames)) {
    $sourcePath = Join-Path $InstallRoot $name
    $snapshotPath = Join-Path $SnapshotDirectory $name
    $existed = Test-Path -LiteralPath $sourcePath -PathType Leaf
    $hash = $null
    if ($existed) {
      Copy-Item -LiteralPath $sourcePath -Destination $snapshotPath -Force -ErrorAction Stop
      $hash = (Get-FileHash -LiteralPath $sourcePath -Algorithm SHA256 -ErrorAction Stop).Hash
      $snapshotHash = (Get-FileHash -LiteralPath $snapshotPath -Algorithm SHA256 -ErrorAction Stop).Hash
      if ($snapshotHash -ne $hash) {
        throw "Root-runtime rollback snapshot hash mismatch: $sourcePath"
      }
    }
    $entries += [pscustomobject]@{
      Name = $name
      Existed = $existed
      Hash = $hash
      SnapshotPath = $snapshotPath
    }
  }

  $manifestPath = Join-Path $SnapshotDirectory "manifest.json"
  $entries |
    Select-Object Name, Existed, Hash |
    ConvertTo-Json -Depth 4 |
    Set-Content -LiteralPath $manifestPath -Encoding UTF8 -ErrorAction Stop

  return [pscustomobject]@{
    Directory = $SnapshotDirectory
    Entries = $entries
    ManifestPath = $manifestPath
  }
}

function Restore-AwardPingRootRuntimeSnapshot {
  param(
    [string]$InstallRoot,
    [object]$Snapshot,
    [string]$Token
  )

  if (-not $Snapshot -or -not (Test-Path -LiteralPath $Snapshot.Directory -PathType Container)) {
    throw "The root-runtime rollback snapshot is unavailable."
  }

  # Validate the complete rollback source before changing any installed file.
  foreach ($entry in @($Snapshot.Entries)) {
    if (-not $entry.Existed) {
      continue
    }
    if (-not (Test-Path -LiteralPath $entry.SnapshotPath -PathType Leaf)) {
      throw "Root-runtime rollback file is missing: $($entry.SnapshotPath)"
    }
    $snapshotHash = (Get-FileHash -LiteralPath $entry.SnapshotPath -Algorithm SHA256 -ErrorAction Stop).Hash
    if ($snapshotHash -ne $entry.Hash) {
      throw "Root-runtime rollback file hash mismatch: $($entry.SnapshotPath)"
    }
  }

  foreach ($entry in @($Snapshot.Entries)) {
    $destinationPath = Join-Path $InstallRoot $entry.Name
    $publishPath = "$destinationPath.rollback-$Token"
    $replaceBackupPath = "$destinationPath.pre-rollback-$Token"
    try {
      if ($entry.Existed) {
        Copy-Item -LiteralPath $entry.SnapshotPath -Destination $publishPath -Force -ErrorAction Stop
        if (Test-Path -LiteralPath $destinationPath) {
          Remove-Item -LiteralPath $replaceBackupPath -Force -ErrorAction SilentlyContinue
          [System.IO.File]::Replace($publishPath, $destinationPath, $replaceBackupPath, $true)
        } else {
          [System.IO.File]::Move($publishPath, $destinationPath)
        }
      } elseif (Test-Path -LiteralPath $destinationPath) {
        Remove-Item -LiteralPath $destinationPath -Force -ErrorAction Stop
      }
    } finally {
      Remove-Item -LiteralPath $publishPath -Force -ErrorAction SilentlyContinue
      Remove-Item -LiteralPath $replaceBackupPath -Force -ErrorAction SilentlyContinue
    }
  }

  foreach ($entry in @($Snapshot.Entries)) {
    $destinationPath = Join-Path $InstallRoot $entry.Name
    if ($entry.Existed) {
      if (-not (Test-Path -LiteralPath $destinationPath -PathType Leaf)) {
        throw "Restored root-runtime file is missing: $destinationPath"
      }
      $restoredHash = (Get-FileHash -LiteralPath $destinationPath -Algorithm SHA256 -ErrorAction Stop).Hash
      if ($restoredHash -ne $entry.Hash) {
        throw "Restored root-runtime file hash mismatch: $destinationPath"
      }
    } elseif (Test-Path -LiteralPath $destinationPath) {
      throw "A root-runtime file created by the failed update is still present: $destinationPath"
    }
  }
}

function Restore-AwardPingAppAfterFailedUpdate {
  param(
    [string]$CurrentAppDir,
    [string]$BackupAppDir,
    [string]$FailedAppDir
  )

  if (-not (Test-Path -LiteralPath $BackupAppDir -PathType Container)) {
    throw "The prior complete AwardPing app is unavailable: $BackupAppDir"
  }
  if (Test-Path -LiteralPath $FailedAppDir) {
    throw "Refusing to overwrite a failed-app recovery path: $FailedAppDir"
  }

  $currentMoved = $false
  if (Test-Path -LiteralPath $CurrentAppDir) {
    Move-Item -LiteralPath $CurrentAppDir -Destination $FailedAppDir -ErrorAction Stop
    $currentMoved = $true
  }
  try {
    Move-Item -LiteralPath $BackupAppDir -Destination $CurrentAppDir -ErrorAction Stop
  } catch {
    if (
      $currentMoved -and
      (-not (Test-Path -LiteralPath $CurrentAppDir)) -and
      (Test-Path -LiteralPath $FailedAppDir)
    ) {
      Move-Item -LiteralPath $FailedAppDir -Destination $CurrentAppDir -ErrorAction Stop
    }
    throw
  }

  if (-not (Test-Path -LiteralPath (Join-Path $CurrentAppDir ".env.worker.local") -PathType Leaf)) {
    throw "The restored AwardPing app is missing .env.worker.local: $CurrentAppDir"
  }
  if (-not (Test-Path -LiteralPath (Join-Path $CurrentAppDir "package.json") -PathType Leaf)) {
    throw "The restored AwardPing app is missing package.json: $CurrentAppDir"
  }

  if ($currentMoved -and (Test-Path -LiteralPath $FailedAppDir)) {
    Remove-DirectoryWithRetry -Path $FailedAppDir
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
AWARDPING_VISUAL_GEMINI_MODEL=gemini-2.5-flash-lite
AWARDPING_GEMINI_API_DAILY_COST_CAP_USD=15
AWARDPING_VISUAL_WEB_CONCURRENCY=4
AWARDPING_EXTRACT_BASELINE_INFO=false
AWARDPING_R2_OPERATION_RETRIES=5
AWARDPING_R2_REPAIR_MISSING_SNAPSHOTS=true

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
    "AWARDPING_VISUAL_GEMINI_MODEL" = "gemini-2.5-flash-lite"
  }
  $missingDefaults = [ordered]@{
    "AWARDPING_GEMINI_API_DAILY_COST_CAP_USD" = "15"
    "AWARDPING_VISUAL_WEB_CONCURRENCY" = "4"
    "AWARDPING_EXTRACT_BASELINE_INFO" = "false"
    "AWARDPING_R2_OPERATION_RETRIES" = "5"
    "AWARDPING_R2_REPAIR_MISSING_SNAPSHOTS" = "true"
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
  "AwardPing Visual Snapshot Worker Shard 1",
  "AwardPing Visual Snapshot Worker Shard 2",
  "AwardPing Visual Snapshot Worker Shard 3",
  "AwardPing Overnight Source Quality Pass",
  "AwardPing Baseline Completion Watchdog",
  "AwardPing Baseline Facts Watchdog",
  "AwardPing Downstream Queue Pipeline",
  "AwardPing Startup Supervisor"
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
  [int]`$WebConcurrency = 4,
  [int]`$MaxRestarts = 3,
  [int]`$CompleteMissingBatchLimit = 250,
  [int]`$ShardCount = 1,
  [int]`$ShardIndex = 0,
  [ValidateSet("scheduled", "maintenance", "manual")]
  [string]`$RunTrigger = "manual"
)

`$ErrorActionPreference = "Stop"
`$InstallRoot = Split-Path -Parent `$MyInvocation.MyCommand.Path
`$AppDir = Join-Path `$InstallRoot "app"
`$LogDir = Join-Path `$InstallRoot "logs"
if (`$ShardCount -lt 1) { throw "ShardCount must be at least 1." }
if (`$ShardIndex -lt 0 -or `$ShardIndex -ge `$ShardCount) { throw "ShardIndex must be between 0 and `$(`$ShardCount - 1)." }
`$ShardLabel = if (`$ShardCount -gt 1) { "shard-`$(`$ShardIndex + 1)-of-`$ShardCount" } else { "single" }
`$LockName = if (`$ShardCount -gt 1) { "visual-worker-`$ShardLabel.lock" } else { "visual-worker.lock" }
`$LockPath = Join-Path `$InstallRoot `$LockName
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
`$logPrefix = if (`$ShardCount -gt 1) { "`$logPrefix-`$ShardLabel" } else { `$logPrefix }
`$logPath = Join-Path `$LogDir "`$logPrefix-`$stamp.log"

`$nodePath = (Get-Command node.exe -ErrorAction Stop).Source
`$workerScript = Join-Path `$AppDir "scripts\capture-visual-snapshots.mjs"
if (-not (Test-Path -LiteralPath `$workerScript)) {
  throw "Missing AwardPing visual snapshot worker script: `$workerScript"
}

`$workerArgs = @(
  `$workerScript,
  "--env",
  ".env.worker.local",
  "--limit",
  [string]`$Limit,
  "--domain-delay-ms",
  [string]`$DomainDelayMs,
  "--web-concurrency",
  [string]`$WebConcurrency,
  "--shard-count",
  [string]`$ShardCount,
  "--shard-index",
  [string]`$ShardIndex,
  "--run-trigger",
  `$RunTrigger,
  "--extract-baseline-info=false"
)
if (`$All) { `$workerArgs += "--all=true" }
if (`$BaselineRefresh) { `$workerArgs += "--baseline-refresh=true" }
if (`$PdfOnly) { `$workerArgs += "--pdf-only=true" }
if (`$WebOnly) { `$workerArgs += "--web-only=true" }
if (`$CompleteMissingBaselines) {
  `$workerArgs += "--complete-missing-baselines=true"
  `$workerArgs += "--skip-existing-baseline=true"
  `$workerArgs += "--baseline-refresh=true"
  `$workerArgs += "--extract-baseline-info=false"
  `$workerArgs += "--complete-missing-batch-limit"
  `$workerArgs += [string]`$CompleteMissingBatchLimit
}
if (`$SkipExistingBaseline) { `$workerArgs += "--skip-existing-baseline=true" }

if (`$CompleteMissingBaselines) {
  Write-Host "Running AwardPing missing visual baseline completion (`$ShardLabel). Log: `$logPath"
} elseif (`$BaselineRefresh) {
  Write-Host "Running AwardPing visual baseline refresh (`$ShardLabel). Log: `$logPath"
} else {
  Write-Host "Running AwardPing visual snapshot worker (`$ShardLabel). Log: `$logPath"
}
Set-Content -Path `$LockPath -Value "pid=`$PID started=`$(Get-Date -Format o) mode=`$mode shard_count=`$ShardCount shard_index=`$ShardIndex log=`$logPath" -Encoding ASCII
`$exitCode = 1
Set-Content -Path `$logPath -Value "VISUAL_WORKER_START pid=`$PID mode=`$mode trigger=`$RunTrigger shard_count=`$ShardCount shard_index=`$ShardIndex started=`$(Get-Date -Format o) limit=`$Limit all=`$All baseline_refresh=`$BaselineRefresh complete_missing_baselines=`$CompleteMissingBaselines complete_missing_batch_limit=`$CompleteMissingBatchLimit" -Encoding UTF8
try {
  `$attempt = 0
  do {
    `$attempt += 1
    if (`$attempt -gt 1) {
      `$waitSeconds = [Math]::Min(60, 10 * `$attempt)
      Add-Content -Path `$logPath -Value "VISUAL_WORKER_RESTART attempt=`$attempt max_restarts=`$MaxRestarts wait_seconds=`$waitSeconds started=`$(Get-Date -Format o)" -Encoding UTF8
      Start-Sleep -Seconds `$waitSeconds
    }

    `$previousErrorActionPreference = `$ErrorActionPreference
    `$ErrorActionPreference = "Continue"
    try {
      & `$nodePath @workerArgs 2>&1 | ForEach-Object {
        `$line = [string]`$_
        Write-Host `$line
        Add-Content -Path `$logPath -Value `$line -Encoding UTF8
      }
    } finally {
      `$ErrorActionPreference = `$previousErrorActionPreference
    }
    `$exitCode = `$LASTEXITCODE
    Add-Content -Path `$logPath -Value "VISUAL_WORKER_EXIT attempt=`$attempt exit_code=`$exitCode finished=`$(Get-Date -Format o)" -Encoding UTF8
  } while (`$exitCode -ne 0 -and `$attempt -le `$MaxRestarts)
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
`$NightlyReportPath = Join-Path `$ReportDir "visual-nightly-report-latest.json"

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
`$nightlyReport = Read-JsonIfExists -Path `$NightlyReportPath

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

if (`$nightlyReport) {
  Write-Host ""
  Write-Host "Latest 6 PM capture report"
  Write-Host "Monitoring date: `$(`$nightlyReport.monitoring_date)"
  Write-Host "Operational status: `$(`$nightlyReport.status)"
  Write-Host "Shards complete: `$(`$nightlyReport.completed_shards) / `$(`$nightlyReport.expected_shards)"
  if (@(`$nightlyReport.missing_shards).Count -gt 0) {
    Write-Host "Missing shards: `$(@(`$nightlyReport.missing_shards) -join ', ')"
  }
  Write-Host "Sources loaded: `$(`$nightlyReport.totals.loaded_sources)"
  Write-Host "Pages captured: `$(`$nightlyReport.totals.pages_captured)"
  Write-Host "Source failures: `$(`$nightlyReport.totals.source_failures)"
  Write-Host "Failures / loaded sources: `$(`$nightlyReport.totals.failure_rate_percent)%"
  foreach (`$failureGroup in @(`$nightlyReport.failure_groups)) {
    Write-Host ""
    Write-Host "`$(`$failureGroup.count) x `$(`$failureGroup.label) [`$(`$failureGroup.retry_mode)]"
    Write-Host "Solution: `$(`$failureGroup.solution)"
  }
  Write-Host "Nightly report: `$NightlyReportPath"
}

Write-Host ""
foreach (`$shardNumber in 1..3) {
  `$taskName = "AwardPing Visual Snapshot Worker Shard `$shardNumber"
  `$taskInfo = Get-ScheduledTaskInfo -TaskName `$taskName -ErrorAction SilentlyContinue
  if (`$taskInfo) {
    Write-Host "`$taskName next=`$(`$taskInfo.NextRunTime) last=`$(`$taskInfo.LastRunTime) result=`$(`$taskInfo.LastTaskResult)"
  }
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
  Push-Location -LiteralPath $AppDir
  try {
    $nodeModules = Join-Path $AppDir "node_modules"
    for ($attempt = 1; $attempt -le 2; $attempt += 1) {
      Remove-DirectoryWithRetry -Path $nodeModules
      & npm ci --omit=dev
      $missingDependencies = Get-MissingWorkerRuntimeDependencies -AppDir $AppDir
      if ($LASTEXITCODE -eq 0 -and $missingDependencies.Count -eq 0) {
        return
      }

      if ($LASTEXITCODE -eq 0) {
        Write-Host "npm completed but required worker modules are missing: $($missingDependencies -join ', ')" -ForegroundColor Yellow
      }

      if ($attempt -lt 2) {
        Write-Host "npm install failed; retrying after a clean dependency removal." -ForegroundColor Yellow
      }
    }
  } finally {
    Pop-Location
  }

  throw "npm install failed."
}

function Get-MissingWorkerRuntimeDependencies {
  param([string]$AppDir)

  $requiredPackages = @(
    "@aws-sdk\client-s3",
    "@aws-sdk\s3-request-presigner",
    "@supabase\supabase-js",
    "playwright-core",
    "undici"
  )
  return @($requiredPackages | Where-Object {
    -not (Test-Path -LiteralPath (Join-Path $AppDir "node_modules\$_\package.json"))
  })
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
  foreach ($taskName in @(
    "AwardPing Local Source Worker",
    "AwardPing Local Worker Auto Update",
    "AwardPing Visual Snapshot Worker"
  )) {
    $tasks = @(Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue | Where-Object {
      Test-AwardPingTaskTargetsInstallRoot -Task $_ -InstallRoot $InstallRoot
    })
    if ($tasks.Count -gt 0) {
      foreach ($task in $tasks) {
        $taskPath = if ([string]::IsNullOrWhiteSpace([string]$task.TaskPath)) { "\" } else { [string]$task.TaskPath }
        Stop-ScheduledTask -TaskName $task.TaskName -TaskPath $taskPath -ErrorAction SilentlyContinue
        Unregister-ScheduledTask -TaskName $task.TaskName -TaskPath $taskPath -Confirm:$false -ErrorAction Stop
        Write-Host "Removed legacy scheduled task: $taskPath$($task.TaskName)"
      }
    } else {
      Write-Host "Legacy scheduled task is not present for this install: $taskName"
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
  param(
    [string]$InstallRoot,
    [bool]$RegisterDisabled
  )

  Write-Step "Creating AwardPing visual snapshot shard tasks"
  $visualRunScript = Join-Path $InstallRoot "Run-AwardPingVisualSnapshots.ps1"

  for ($shardIndex = 0; $shardIndex -lt 3; $shardIndex += 1) {
    $taskName = "AwardPing Visual Snapshot Worker Shard $($shardIndex + 1)"
    $action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$visualRunScript`" -All -Limit 50000 -WebConcurrency 3 -ShardCount 3 -ShardIndex $shardIndex -RunTrigger scheduled"
    $trigger = New-ScheduledTaskTrigger -Daily -At 6pm
    $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 23)
    $settings.DisallowStartIfOnBatteries = $false
    $settings.StopIfGoingOnBatteries = $false
    $settings.Hidden = $true
    if ($RegisterDisabled) { $settings.Enabled = $false }
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Description "Captures visual AwardPing source-page snapshots daily from this PC. Domain shard $($shardIndex + 1) of 3." -Force | Out-Null
    Write-Host "Scheduled task created: $taskName daily at 6:00 PM"
  }
}

function Register-BaselineFactsWatchdog {
  param(
    [string]$InstallRoot,
    [bool]$RegisterDisabled
  )

  Write-Step "Creating AwardPing baseline facts watchdog"
  $watchdogScript = Join-Path $PSScriptRoot "Watch-AwardPingBaselineFacts.ps1"
  if (-not (Test-Path -LiteralPath $watchdogScript)) {
    Write-Host "Baseline facts watchdog script is missing; skipping its task." -ForegroundColor Yellow
    return
  }

  $watchdogInstallArguments = @(
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $watchdogScript,
    "-InstallRoot", $InstallRoot,
    "-Install",
    "-Model", "gemini-2.5-flash-lite",
    "-BatchMode", "batch",
    "-BatchMaxRequests", "25",
    "-BatchParallelJobs", "4",
    "-IntervalMinutes", "60",
    "-DirectCatchupThreshold", "0",
    "-CostCapUsd", "10"
  )
  if ($RegisterDisabled) { $watchdogInstallArguments += "-InstallDisabled" }
  & powershell.exe @watchdogInstallArguments
  if ($LASTEXITCODE -ne 0) {
    throw "Could not install AwardPing baseline facts watchdog task."
  }

  Write-Host "Scheduled task created: AwardPing Baseline Facts Watchdog"
}

function Register-DownstreamQueuePipeline {
  param(
    [string]$InstallRoot,
    [int]$SuppressionSweepLimit,
    [int]$SuppressionSweepBatchSize,
    [bool]$RegisterDisabled
  )

  Write-Step "Creating AwardPing downstream queue pipeline"
  $pipelineScript = Join-Path $PSScriptRoot "Run-AwardPingDownstreamQueues.ps1"
  if (-not (Test-Path -LiteralPath $pipelineScript)) {
    Write-Host "Downstream queue pipeline script is missing; skipping its task." -ForegroundColor Yellow
    return
  }

  $pipelineInstallArguments = @(
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $pipelineScript,
    "-InstallRoot", $InstallRoot,
    "-Install",
    "-IntervalMinutes", "60",
    "-VisualReviewLimit", "250",
    "-VisualReviewBatchSize", "25",
    "-SuppressionSweepLimit", [string]$SuppressionSweepLimit,
    "-SuppressionSweepBatchSize", [string]$SuppressionSweepBatchSize,
    "-ReconciliationLimit", "250",
    "-PageAuditLimit", "250",
    "-PageAuditBatchSize", "50"
  )
  if ($RegisterDisabled) { $pipelineInstallArguments += "-InstallDisabled" }
  & powershell.exe @pipelineInstallArguments
  if ($LASTEXITCODE -ne 0) {
    throw "Could not install AwardPing downstream queue pipeline task."
  }

  Write-Host "Scheduled task created: AwardPing Downstream Queue Pipeline"
}

function Register-StartupSupervisorTask {
  param(
    [string]$InstallRoot,
    [bool]$RegisterDisabled
  )

  Write-Step "Creating AwardPing startup supervisor task"
  $sourceScript = Join-Path $PSScriptRoot "Start-AwardPingOnBoot.ps1"
  if (-not (Test-Path -LiteralPath $sourceScript)) {
    Write-Host "Startup supervisor script is missing; skipping startup supervisor task." -ForegroundColor Yellow
    return
  }

  $startupInstallArguments = @(
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $sourceScript,
    "-InstallRoot", $InstallRoot,
    "-Install"
  )
  if ($RegisterDisabled) { $startupInstallArguments += "-InstallDisabled" }
  & powershell.exe @startupInstallArguments
  if ($LASTEXITCODE -ne 0) {
    throw "Could not install AwardPing startup supervisor task."
  }

  $registeredTasks = @(Get-ScheduledTask -TaskName "AwardPing Startup Supervisor" -ErrorAction SilentlyContinue | Where-Object {
    Test-AwardPingTaskTargetsInstallRoot -Task $_ -InstallRoot $InstallRoot
  })
  if ($RegisterDisabled -and $registeredTasks.Count -eq 0) {
    $script:StartupSupervisorFallbackDeferred = $true
    Write-Host "Startup-folder fallback will be refreshed after the task update commits."
  } else {
    Write-Host "Scheduled task created: AwardPing Startup Supervisor at Windows sign-in"
  }
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
Assert-AwardPingManagedTaskRegistrationScope -InstallRoot $InstallRoot
$taskSnapshots = @()
$finalizationSnapshots = @()
$installFailure = $null
$restoreFailure = $null
$stagingCleanupFailure = $null
$appUpdateCommitted = $false
$taskUpdateCommitted = $false
$rollbackOperationalState = $true
$taskSnapshotCaptured = $false
$rootRuntimeSnapshotCaptured = $false
$runtimeRollbackSucceeded = $false
$script:StartupSupervisorFallbackDeferred = $false
$updateToken = "{0}-{1}" -f $PID, [Guid]::NewGuid().ToString("N")
$stagingAppDir = Join-Path $InstallRoot ".app-update-$updateToken"
$backupAppDir = Join-Path $InstallRoot ".app-rollback-$updateToken"
$failedAppDir = Join-Path $InstallRoot ".app-failed-$updateToken"
$rootRuntimeSnapshotDir = Join-Path $InstallRoot ".root-runtime-rollback-$updateToken"
$rootRuntimeSnapshot = $null
$startupLauncherSnapshot = $null

try {
  if ($UpdateOnly) {
    Write-Step "Building complete staged AwardPing app"
    Copy-AppFiles -SourceRoot $sourceRoot -AppDir $stagingAppDir
    Install-Dependencies -AppDir $stagingAppDir

    $taskSnapshots = @(Get-AwardPingTaskSnapshotsForUpdate -InstallRoot $InstallRoot)
    $taskSnapshotCaptured = $true
    Suspend-AwardPingTasksForUpdate -Snapshots $taskSnapshots -InstallRoot $InstallRoot
    $startupLauncherSnapshot = Suspend-AwardPingStartupLauncherForUpdate `
      -InstallRoot $InstallRoot `
      -UpdateToken $updateToken
    $rootRuntimeSnapshot = New-AwardPingRootRuntimeSnapshot `
      -InstallRoot $InstallRoot `
      -SnapshotDirectory $rootRuntimeSnapshotDir
    $rootRuntimeSnapshotCaptured = $true
    Copy-AwardPingMutableAppState -CurrentAppDir $appDir -StagingAppDir $stagingAppDir
    Update-ExistingEnvFileDefaults -Path (Join-Path $stagingAppDir ".env.worker.local")
    Switch-ToStagedAwardPingApp `
      -CurrentAppDir $appDir `
      -StagingAppDir $stagingAppDir `
      -BackupAppDir $backupAppDir
    $appUpdateCommitted = $true
    Write-Host "Update-only mode: switched to a complete app/dependency tree and kept existing keys."
  } else {
    Copy-AppFiles -SourceRoot $sourceRoot -AppDir $appDir
    $supabaseServiceRoleKey = Read-SupabaseServiceRoleKey -SupabaseUrl $SupabaseUrl
    $geminiApiKey = Read-PlainSecret "Paste Gemini API key"
    $runTest = Read-YesNo "Run a one-page visual snapshot test after install?" $true
    Write-Host "Only the daily visual screenshot checker will be scheduled. The legacy hourly source/text worker will be removed."
    Write-EnvFile -Path $envPath -SupabaseUrl $SupabaseUrl -SupabaseServiceRoleKey $supabaseServiceRoleKey -GeminiApiKey $geminiApiKey
    Install-Dependencies -AppDir $appDir
  }

  Write-UninstallScript -InstallRoot $InstallRoot
  Write-LauncherScripts -InstallRoot $InstallRoot
  Register-VisualSnapshotTask -InstallRoot $InstallRoot -RegisterDisabled $UpdateOnly
  Register-BaselineFactsWatchdog -InstallRoot $InstallRoot -RegisterDisabled $UpdateOnly
  Register-DownstreamQueuePipeline `
    -InstallRoot $InstallRoot `
    -SuppressionSweepLimit $SuppressionSweepLimit `
    -SuppressionSweepBatchSize $SuppressionSweepBatchSize `
    -RegisterDisabled $UpdateOnly
  Register-StartupSupervisorTask -InstallRoot $InstallRoot -RegisterDisabled $UpdateOnly
} catch {
  $installFailure = $_
} finally {
  if ($UpdateOnly) {
    if (-not $installFailure) {
      try {
        $finalizationSnapshots = @(Get-AwardPingTaskSnapshotsForFinalization `
          -InitialSnapshots $taskSnapshots `
          -InstallRoot $InstallRoot)
        $runtimeProblems = @(Get-AwardPingInstalledRuntimeProblems `
          -InstallRoot $InstallRoot `
          -AppDir $appDir `
          -TaskSnapshots $finalizationSnapshots `
          -RequireManagedRuntime $true `
          -InstallerSourceDirectory $PSScriptRoot `
          -AppSourceRoot ([string]$sourceRoot))
        if ($runtimeProblems.Count -gt 0) {
          throw "The installed worker is not complete enough to resume scheduled tasks: $($runtimeProblems -join ' | ')"
        }
        Disable-AwardPingTasksForInstallRoot -InstallRoot $InstallRoot
        Restore-AwardPingTasksAfterUpdate `
          -Snapshots $finalizationSnapshots `
          -SuppressionSweepLimit $SuppressionSweepLimit `
          -SuppressionSweepBatchSize $SuppressionSweepBatchSize `
          -ApplyTaskDefinitionUpdates $true `
          -RestoreOperationalState $true
        $taskUpdateCommitted = $true
      } catch {
        $restoreFailure = $_
      }
    }

    if (($installFailure -or $restoreFailure) -and $taskSnapshotCaptured) {
      $runtimeRollbackErrors = @()
      $runtimeQuiesced = $false
      $updateRuntimeWasPublished = $appUpdateCommitted
      try {
        Disable-AwardPingTasksForInstallRoot -InstallRoot $InstallRoot
        Wait-ForAwardPingWorkerProcessesToStop -InstallRoot $InstallRoot
        $runtimeQuiesced = $true
      } catch {
        $runtimeRollbackErrors += "quiesce failed update: $($_.Exception.Message)"
      }

      if ($appUpdateCommitted -and $runtimeQuiesced) {
        try {
          Restore-AwardPingAppAfterFailedUpdate `
            -CurrentAppDir $appDir `
            -BackupAppDir $backupAppDir `
            -FailedAppDir $failedAppDir
          $appUpdateCommitted = $false
        } catch {
          $runtimeRollbackErrors += "restore prior app: $($_.Exception.Message)"
        }
      }
      if ($appUpdateCommitted -and -not $runtimeQuiesced) {
        $runtimeRollbackErrors += "prior app was not restored because the failed task set could not be safely quiesced"
      }

      if ($rootRuntimeSnapshotCaptured -and $runtimeQuiesced) {
        try {
          Restore-AwardPingRootRuntimeSnapshot `
            -InstallRoot $InstallRoot `
            -Snapshot $rootRuntimeSnapshot `
            -Token $updateToken
        } catch {
          $runtimeRollbackErrors += "restore prior root runtime: $($_.Exception.Message)"
        }
      } elseif ($updateRuntimeWasPublished -and -not $rootRuntimeSnapshotCaptured) {
        $runtimeRollbackErrors += "root-runtime rollback snapshot was not captured"
      }

      $runtimeRollbackSucceeded = $runtimeRollbackErrors.Count -eq 0
      $rollbackProblems = @($runtimeRollbackErrors)
      if ($runtimeRollbackSucceeded) {
        try {
          $rollbackProblems += @(Get-AwardPingInstalledRuntimeProblems `
            -InstallRoot $InstallRoot `
            -AppDir $appDir `
            -TaskSnapshots $taskSnapshots `
            -RequireManagedRuntime $false)
        } catch {
          $rollbackProblems += "validate restored runtime: $($_.Exception.Message)"
        }
      }
      $rollbackOperationalState = $runtimeRollbackSucceeded -and $rollbackProblems.Count -eq 0
      try {
        Invoke-AwardPingTaskSetRollback `
          -InitialSnapshots $taskSnapshots `
          -InstallRoot $InstallRoot `
          -SuppressionSweepLimit $SuppressionSweepLimit `
          -SuppressionSweepBatchSize $SuppressionSweepBatchSize `
          -RestoreOperationalState $rollbackOperationalState
        if (-not $rollbackOperationalState) {
          throw "Original AwardPing tasks were restored in a disabled state because runtime validation failed: $($rollbackProblems -join ' | ')"
        }
      } catch {
        if ($restoreFailure) {
          $priorRestoreMessage = $restoreFailure.Exception.Message
          try {
            throw "$priorRestoreMessage. Task-set rollback also failed: $($_.Exception.Message)"
          } catch {
            $restoreFailure = $_
          }
        } else {
          $restoreFailure = $_
        }
      }
    }

    $startupTaskInstalled = @(
      Get-ScheduledTask -TaskName "AwardPing Startup Supervisor" -ErrorAction SilentlyContinue |
        Where-Object { Test-AwardPingTaskTargetsInstallRoot -Task $_ -InstallRoot $InstallRoot }
    ).Count -gt 0
    try {
      Complete-AwardPingStartupLauncherUpdate `
        -Snapshot $startupLauncherSnapshot `
        -UpdateCommitted $taskUpdateCommitted `
        -StartupTaskInstalled $startupTaskInstalled `
        -RestoreOperationalState ($taskUpdateCommitted -or $rollbackOperationalState)
    } catch {
      if ($taskUpdateCommitted) {
        Write-Host "The task update committed, but the prior Startup-folder launcher could not be finalized: $($_.Exception.Message)" -ForegroundColor Yellow
      } else {
        $startupRestoreMessage = $_.Exception.Message
        $rollbackOperationalState = $false
        try {
          Disable-AwardPingTasksForInstallRoot -InstallRoot $InstallRoot
        } catch {
          $startupRestoreMessage = "$startupRestoreMessage. Final task disable also failed: $($_.Exception.Message)"
        }
        if ($restoreFailure) {
          $priorRestoreMessage = $restoreFailure.Exception.Message
          try {
            throw "$priorRestoreMessage. Startup-launcher restoration also failed: $startupRestoreMessage"
          } catch {
            $restoreFailure = $_
          }
        } else {
          try {
            throw "Startup-launcher restoration failed; all AwardPing tasks were left disabled: $startupRestoreMessage"
          } catch {
            $restoreFailure = $_
          }
        }
      }
    }
  }

  if (Test-Path -LiteralPath $stagingAppDir) {
    try {
      Remove-DirectoryWithRetry -Path $stagingAppDir
    } catch {
      $stagingCleanupFailure = $_
    }
  }
  if (
    $rootRuntimeSnapshotCaptured -and
    ($taskUpdateCommitted -or $runtimeRollbackSucceeded) -and
    (Test-Path -LiteralPath $rootRuntimeSnapshotDir)
  ) {
    try {
      Remove-DirectoryWithRetry -Path $rootRuntimeSnapshotDir
    } catch {
      Write-Host "The root-runtime rollback snapshot could not be removed: $rootRuntimeSnapshotDir ($($_.Exception.Message))" -ForegroundColor Yellow
    }
  }
}

if ($UpdateOnly -and $taskUpdateCommitted -and -not $installFailure -and -not $restoreFailure -and $script:StartupSupervisorFallbackDeferred) {
  try {
    $startupScript = Join-Path $PSScriptRoot "Start-AwardPingOnBoot.ps1"
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $startupScript -InstallRoot $InstallRoot -Install
    if ($LASTEXITCODE -ne 0) {
      throw "Startup supervisor fallback exited with code $LASTEXITCODE."
    }
  } catch {
    Write-Host "The worker update committed, but the startup supervisor fallback could not be refreshed: $($_.Exception.Message)" -ForegroundColor Yellow
  }
}

if (-not $installFailure -and -not $restoreFailure) {
  try {
    Remove-LegacySourceTask -InstallRoot $InstallRoot
  } catch {
    Write-Host "The worker update committed, but legacy-task cleanup was incomplete: $($_.Exception.Message)" -ForegroundColor Yellow
  }
}

if ($UpdateOnly -and $taskUpdateCommitted -and -not $installFailure -and -not $restoreFailure -and (Test-Path -LiteralPath $backupAppDir)) {
  try {
    Remove-DirectoryWithRetry -Path $backupAppDir
  } catch {
    Write-Host "The update succeeded, but the rollback app could not be removed: $backupAppDir ($($_.Exception.Message))" -ForegroundColor Yellow
  }
}
if ($stagingCleanupFailure) {
  Write-Host "A staged update directory could not be removed: $stagingAppDir ($($stagingCleanupFailure.Exception.Message))" -ForegroundColor Yellow
}

if ($installFailure) {
  if ($appUpdateCommitted -and (Test-Path -LiteralPath $backupAppDir)) {
    Write-Host "The failed update remains installed but disabled; the prior complete app is retained at $backupAppDir for recovery." -ForegroundColor Yellow
  }
  if ($restoreFailure) {
    throw "Worker update failed: $($installFailure.Exception.Message). Scheduled-task restoration also failed: $($restoreFailure.Exception.Message)"
  }
  throw $installFailure
}
if ($restoreFailure) {
  throw $restoreFailure
}

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
