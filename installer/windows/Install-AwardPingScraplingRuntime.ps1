[CmdletBinding()]
param(
  [string]$InstallRoot,
  [string]$SourceRoot,
  [string]$PythonExecutable
)

# Dot-sourcing defines helpers only. This installer does not change tasks, app files,
# environment files, browsers, or the active worker's runtime selection.
function Resolve-APSLocalPath {
  param([string]$Path, [switch]$Directory, [switch]$MustExist)
  if ([string]::IsNullOrWhiteSpace($Path) -or $Path -notmatch '^[A-Za-z]:[\\/]' -or
      $Path -match '[\x00-\x1f<>"|?*]' -or $Path.Substring(2).Contains(':')) {
    throw 'An explicit absolute local Windows path is required.'
  }
  $normalized = $Path.Replace('/', '\')
  foreach ($part in $normalized.Substring(3).Split('\')) {
    if ($part -eq '') { continue }
    if ($part -in @('.', '..') -or $part -match '[. ]$' -or
        $part -match '^(?i:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)') {
      throw 'Unsafe path component.'
    }
  }
  $full = [IO.Path]::GetFullPath($normalized).TrimEnd('\')
  if ($full.Length -eq 2) { $full += '\' }
  # Inspect each existing component before following it. Reject directory junctions
  # and file symlinks, including Windows Store execution aliases.
  $cursor = [IO.Path]::GetPathRoot($full)
  if (-not (Test-Path -LiteralPath $cursor -PathType Container)) { throw 'Local drive is unavailable.' }
  $parts = $full.Substring($cursor.Length).Split('\')
  foreach ($part in $parts) {
    if ($part -eq '') { continue }
    $cursor = Join-Path $cursor $part
    # Get-Item also identifies dangling reparse entries for which Test-Path can
    # return false. Only genuine not-found errors are acceptable for new paths.
    $item = $null
    try { $item = Get-Item -LiteralPath $cursor -Force -ErrorAction Stop }
    catch [System.Management.Automation.ItemNotFoundException] { }
    if ($null -ne $item) {
      if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'Reparse points are not allowed in runtime paths.'
      }
    }
  }
  if ($MustExist -and -not (Test-Path -LiteralPath $full)) { throw 'Required path does not exist.' }
  if (Test-Path -LiteralPath $full) {
    $item = Get-Item -LiteralPath $full -Force -ErrorAction Stop
    if ($Directory -and -not $item.PSIsContainer) { throw 'Expected a directory.' }
    if (-not $Directory -and $item.PSIsContainer) { throw 'Expected a file.' }
  }
  return $full
}

function Assert-APSInstallRoot {
  param([string]$Path)
  $full = Resolve-APSLocalPath -Path $Path -Directory -MustExist
  $broad = @([IO.Path]::GetPathRoot($full), $env:USERPROFILE, $env:LOCALAPPDATA,
    $env:APPDATA, $env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:WINDIR, $env:ProgramData)
  foreach ($entry in $broad) {
    if ($entry -and $full.TrimEnd('\').Equals($entry.TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)) {
      throw 'InstallRoot must be a dedicated application directory, not a broad system or profile directory.'
    }
  }
  return $full
}

function Get-APSSha256 {
  param([string]$Path)
  $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
  $sha = [Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
  finally { $sha.Dispose(); $stream.Dispose() }
}

function Get-APSRequirements {
  param([string]$Path)
  $full = Resolve-APSLocalPath -Path $Path -MustExist
  if ((Get-Item -LiteralPath $full).Length -gt 65536) { throw 'Requirements file is too large.' }
  $bytes = [IO.File]::ReadAllBytes($full)
  $utf8 = New-Object Text.UTF8Encoding($false, $true)
  $content = $utf8.GetString($bytes).TrimStart([char]0xfeff)
  $pins = [ordered]@{}
  foreach ($line in ($content -split '\r?\n')) {
    $line = $line.Trim()
    if (-not $line -or $line.StartsWith('#')) { continue }
    if ($line -notmatch '^([A-Za-z0-9][A-Za-z0-9_.-]*)(?:\[[A-Za-z0-9_,.-]+\])?==([0-9][A-Za-z0-9.!+_-]*)$') {
      throw 'Every requirement must be an exact package==version pin; options, markers and URLs are rejected.'
    }
    $name = ($Matches[1].ToLowerInvariant() -replace '[-_.]+', '-')
    if ($pins.Contains($name)) { throw 'Duplicate package pin.' }
    $pins[$name] = $Matches[2]
  }
  if (-not $pins.Contains('scrapling') -or $pins.Count -lt 1) { throw 'Scrapling must be pinned.' }
  $sha = [Security.Cryptography.SHA256]::Create()
  try { $hash = ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant() }
  finally { $sha.Dispose() }
  return [pscustomobject]@{ Path = $full; Bytes = $bytes; Sha256 = $hash; Pins = $pins }
}

function ConvertTo-APSNativeArgument {
  param([AllowEmptyString()][string]$Value)
  # Windows CommandLineToArgvW quoting, including trailing backslashes.
  $quoted = [regex]::Replace($Value, '(\\*)"', '$1$1\"')
  $quoted = [regex]::Replace($quoted, '(\\+)$', '$1$1')
  return '"' + $quoted + '"'
}

function Invoke-APSProcess {
  param([string]$Executable, [string[]]$Arguments, [string]$Phase, [int]$TimeoutSeconds = 120)
  $exe = Resolve-APSLocalPath -Path $Executable -MustExist
  $info = New-Object Diagnostics.ProcessStartInfo
  $info.FileName = $exe
  $info.Arguments = (($Arguments | ForEach-Object { ConvertTo-APSNativeArgument $_ }) -join ' ')
  $info.UseShellExecute = $false
  $info.CreateNoWindow = $true
  $info.RedirectStandardOutput = $true
  $info.RedirectStandardError = $true
  # Do not pass Python/Pip configuration or credentials into package operations.
  foreach ($key in @($info.EnvironmentVariables.Keys)) {
    if ($key -match '^(?i:PYTHON|PIP_)') { $info.EnvironmentVariables.Remove($key) }
  }
  $info.EnvironmentVariables['PIP_CONFIG_FILE'] = 'NUL'
  $info.EnvironmentVariables['PYTHONDONTWRITEBYTECODE'] = '1'
  $info.EnvironmentVariables['PYTHONNOUSERSITE'] = '1'
  $process = New-Object Diagnostics.Process
  $process.StartInfo = $info
  try {
    if (-not $process.Start()) { throw "$Phase could not start." }
    $stdout = $process.StandardOutput.ReadToEndAsync()
    $stderr = $process.StandardError.ReadToEndAsync()
    if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
      # Terminate only the exact child tree created above, never a name/global match.
      $killInfo = New-Object Diagnostics.ProcessStartInfo
      $killInfo.FileName = Join-Path $env:WINDIR 'System32\taskkill.exe'
      $killInfo.Arguments = '/PID ' + $process.Id + ' /T /F'
      $killInfo.UseShellExecute = $false
      $killInfo.CreateNoWindow = $true
      $killInfo.RedirectStandardOutput = $true
      $killInfo.RedirectStandardError = $true
      $killer = [Diagnostics.Process]::Start($killInfo)
      try {
        $killOut = $killer.StandardOutput.ReadToEndAsync()
        $killErr = $killer.StandardError.ReadToEndAsync()
        if (-not $killer.WaitForExit(10000)) { $killer.Kill() }
      } finally { $killer.Dispose() }
      if (-not $process.WaitForExit(10000)) { throw "$Phase timed out; child shutdown could not be confirmed." }
      throw "$Phase timed out; its child process tree was stopped."
    }
    $output = $stdout.GetAwaiter().GetResult()
    $errorOutput = $stderr.GetAwaiter().GetResult()
    if ($process.ExitCode -ne 0) { throw "$Phase failed (exit $($process.ExitCode)); no runtime was activated." }
    if ($output.Length -gt 4194304 -or $errorOutput.Length -gt 4194304) { throw "$Phase output exceeded the limit." }
    return $output
  } finally { $process.Dispose() }
}

function Get-APSPythonInfo {
  param([string]$Executable)
  $code = 'import json,sys; print(json.dumps({"executable":sys.executable,"version":list(sys.version_info[:3]),"prefix":sys.prefix,"base_prefix":sys.base_prefix}))'
  $result = (Invoke-APSProcess -Executable $Executable -Arguments @('-I', '-B', '-c', $code) -Phase 'Python verification' -TimeoutSeconds 15) | ConvertFrom-Json
  if ($result.version.Count -ne 3 -or $result.version[0] -ne 3 -or $result.version[1] -lt 10) {
    throw 'Python 3.10 or later (major version 3) is required.'
  }
  $resolved = Resolve-APSLocalPath -Path $result.executable -MustExist
  if (-not $resolved.Equals($Executable, [StringComparison]::OrdinalIgnoreCase)) { throw 'Python executable identity did not match.' }
  return $result
}

function Find-APSPython {
  param([string]$Executable)
  if ($Executable) {
    $full = Resolve-APSLocalPath -Path $Executable -MustExist
    $info = Get-APSPythonInfo -Executable $full
    if ($info.prefix -ne $info.base_prefix) { throw 'Supply a base Python installation, not another virtual environment.' }
    return [pscustomobject]@{ Path = $full; Info = $info }
  }
  # Only inspect real PATH executables. Store aliases/reparse points are rejected
  # before execution; nothing installs Python or opens a sign-in/store prompt.
  foreach ($name in @('python.exe', 'python3.exe')) {
    foreach ($command in @(Get-Command $name -CommandType Application -All -ErrorAction SilentlyContinue)) {
      try {
        $full = Resolve-APSLocalPath -Path $command.Source -MustExist
        $info = Get-APSPythonInfo -Executable $full
        if ($info.prefix -eq $info.base_prefix) { return [pscustomobject]@{ Path = $full; Info = $info } }
      } catch { continue }
    }
  }
  throw 'No supported base Python was found. Supply -PythonExecutable with its absolute path.'
}

function Get-APSRuntimeInventory {
  param([string]$Root)
  $full = Resolve-APSLocalPath -Path $Root -Directory -MustExist
  $queue = New-Object 'Collections.Generic.Stack[string]'
  $queue.Push($full)
  $entries = New-Object 'Collections.Generic.List[object]'
  while ($queue.Count -gt 0) {
    foreach ($item in @(Get-ChildItem -LiteralPath $queue.Pop() -Force -ErrorAction Stop)) {
      if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Runtime contains a reparse point.' }
      if ($item.PSIsContainer) { $queue.Push($item.FullName); continue }
      $relative = $item.FullName.Substring($full.Length + 1).Replace('\', '/')
      if ($relative -eq 'runtime-receipt.json') { continue }
      # Python creates bytecode during ordinary captures. It is a generated cache,
      # not a source/package integrity claim; the complete source/native files are hashed.
      if ($relative -match '(^|/)__pycache__/[^/]+\.py[co]$') { continue }
      if ($entries.Count -ge 100000) { throw 'Runtime file inventory exceeded the limit.' }
      $entries.Add([pscustomobject]@{ path = $relative; bytes = $item.Length; sha256 = Get-APSSha256 $item.FullName })
    }
  }
  return @($entries | Sort-Object -Property path)
}

function Assert-APSFileInventory {
  param([object[]]$Expected, [object[]]$Actual)
  if (-not $Expected -or $Expected.Count -ne $Actual.Count) { throw 'Runtime integrity inventory differs.' }
  $expectedSorted = @($Expected | Sort-Object -Property path)
  $actualSorted = @($Actual | Sort-Object -Property path)
  for ($index = 0; $index -lt $expectedSorted.Count; $index++) {
    $a = $expectedSorted[$index]; $b = $actualSorted[$index]
    if ($a.path -cne $b.path -or $a.bytes -ne $b.bytes -or $a.sha256 -cne $b.sha256 -or $a.sha256 -notmatch '^[0-9a-f]{64}$') {
      throw 'Runtime integrity verification failed; existing files were preserved.'
    }
  }
}

function Get-APSBaseInventory {
  param([string]$Executable, [object]$Info)
  $prefix = Resolve-APSLocalPath -Path $Info.base_prefix -Directory -MustExist
  $paths = @($Executable)
  # A Windows venv depends on its base interpreter/DLLs. Record these dependencies
  # rather than claiming the venv is a standalone Python distribution.
  foreach ($name in @('python3.dll', ('python' + $Info.version[0] + $Info.version[1] + '.dll'))) {
    $path = Join-Path $prefix $name
    if (Test-Path -LiteralPath $path) { $paths += Resolve-APSLocalPath -Path $path -MustExist }
  }
  return @($paths | Sort-Object -Unique | ForEach-Object {
    [pscustomobject]@{ path = $_; bytes = (Get-Item -LiteralPath $_).Length; sha256 = Get-APSSha256 $_ }
  })
}

function Test-APSRuntimePython {
  param([string]$RuntimeRoot, [object]$Requirements)
  $python = Resolve-APSLocalPath -Path (Join-Path $RuntimeRoot 'Scripts\python.exe') -MustExist
  $info = Get-APSPythonInfo -Executable $python
  if (-not $info.prefix.Equals($RuntimeRoot, [StringComparison]::OrdinalIgnoreCase) -or $info.prefix -eq $info.base_prefix) {
    throw 'Python is not isolated in the requested runtime.'
  }
  $config = Get-Content -LiteralPath (Join-Path $RuntimeRoot 'pyvenv.cfg') -Raw -ErrorAction Stop
  if ($config -notmatch '(?im)^include-system-site-packages\s*=\s*false\s*$') { throw 'System site packages must be disabled.' }
  $null = Invoke-APSProcess -Executable $python -Arguments @('-I', '-B', '-m', 'pip', '--isolated', '--disable-pip-version-check', '--no-input', 'check') -Phase 'Dependency check' -TimeoutSeconds 120
  $code = 'import importlib.metadata as m,json; print(json.dumps({d.metadata["Name"].lower().replace("_","-").replace(".","-"):d.version for d in m.distributions()}))'
  $versions = (Invoke-APSProcess -Executable $python -Arguments @('-I', '-B', '-c', $code) -Phase 'Package version verification' -TimeoutSeconds 30) | ConvertFrom-Json
  foreach ($name in $Requirements.Pins.Keys) {
    $property = $versions.PSObject.Properties[$name]
    if ($null -eq $property -or $property.Value -cne $Requirements.Pins[$name]) { throw "Pinned package version mismatch: $name." }
  }
  foreach ($property in $versions.PSObject.Properties) {
    if (-not $Requirements.Pins.Contains($property.Name) -and $property.Name -notin @('pip', 'setuptools', 'wheel')) {
      throw 'Unexpected package in isolated runtime.'
    }
  }
  # Package metadata alone cannot detect native DLL failures (including Windows
  # path-length limits). Import the actual collection stack without making a request.
  $importCode = 'from scrapling import Selector; from scrapling.fetchers import DynamicFetcher; import lxml.etree, curl_cffi; from playwright.sync_api import sync_playwright'
  try {
    $null = Invoke-APSProcess -Executable $python -Arguments @('-I', '-B', '-c', $importCode) -Phase 'Scrapling native import verification' -TimeoutSeconds 30
  } catch {
    throw 'Scrapling native import verification failed; no runtime was activated. Check native dependencies and Windows path length; preserve this runtime and use a shorter dedicated installation root if needed.'
  }
  return [pscustomobject]@{ Python = $python; Info = $info; Versions = $versions }
}

function Install-AwardPingScraplingRuntime {
  [CmdletBinding()]
  param([string]$InstallRoot, [string]$SourceRoot, [string]$PythonExecutable)
  $ErrorActionPreference = 'Stop'
  if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'This installer requires Windows.' }
  $install = Assert-APSInstallRoot -Path $InstallRoot
  if (-not $SourceRoot) { $SourceRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..')) }
  $source = Resolve-APSLocalPath -Path $SourceRoot -Directory -MustExist
  $requirements = Get-APSRequirements -Path (Join-Path $source 'scripts\scrapling\requirements.txt')
  $runtimeParent = Resolve-APSLocalPath -Path (Join-Path $install 'runtime') -Directory
  if (-not (Test-Path -LiteralPath $runtimeParent)) { $null = New-Item -ItemType Directory -Path $runtimeParent -ErrorAction Stop }
  $runtime = Resolve-APSLocalPath -Path (Join-Path $runtimeParent ('scrapling-' + $requirements.Sha256)) -Directory
  if (-not $runtime.StartsWith($runtimeParent + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Runtime escaped its installation directory.' }
  $receiptPath = Join-Path $runtime 'runtime-receipt.json'
  $lockPath = Join-Path $runtimeParent ('.scrapling-' + $requirements.Sha256 + '.install.lock')
  $null = Resolve-APSLocalPath -Path $lockPath
  $lock = $null
  try {
    # CreateNew prevents concurrent installers and refuses stale locks; no lock takeover.
    $lock = [IO.File]::Open($lockPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    $reused = Test-Path -LiteralPath $runtime
    if ($reused) {
      $null = Resolve-APSLocalPath -Path $receiptPath -MustExist
      if ((Get-Item -LiteralPath $receiptPath).Length -gt 33554432) { throw 'Runtime receipt exceeds the limit.' }
      $receipt = Get-Content -LiteralPath $receiptPath -Raw | ConvertFrom-Json
      if ($receipt.schema -cne 'awardping.scrapling-runtime.v1' -or $receipt.requirements_sha256 -cne $requirements.Sha256 -or
          $receipt.runtime_root -cne $runtime -or $receipt.python_executable -cne (Join-Path $runtime 'Scripts\python.exe')) {
        throw 'Existing runtime receipt does not match this request.'
      }
      Assert-APSFileInventory -Expected $receipt.files -Actual @(Get-APSRuntimeInventory -Root $runtime)
      if ($receipt.base_files.Count -lt 1 -or $receipt.base_files.Count -gt 3) { throw 'Invalid base interpreter inventory.' }
      $baseActual = @($receipt.base_files | ForEach-Object {
        $path = Resolve-APSLocalPath -Path $_.path -MustExist
        [pscustomobject]@{ path = $path; bytes = (Get-Item -LiteralPath $path).Length; sha256 = Get-APSSha256 $path }
      })
      Assert-APSFileInventory -Expected $receipt.base_files -Actual $baseActual
      if ($PythonExecutable) {
        $requested = Resolve-APSLocalPath -Path $PythonExecutable -MustExist
        if (-not $requested.Equals($receipt.base_python_executable, [StringComparison]::OrdinalIgnoreCase)) { throw 'Existing runtime uses a different base Python.' }
      }
    } else {
      $base = Find-APSPython -Executable $PythonExecutable
      $baseFiles = @(Get-APSBaseInventory -Executable $base.Path -Info $base.Info)
      $null = New-Item -ItemType Directory -Path $runtime -ErrorAction Stop
      $null = Invoke-APSProcess -Executable $base.Path -Arguments @('-I', '-B', '-m', 'venv', '--copies', $runtime) -Phase 'Virtual environment creation' -TimeoutSeconds 180
      $copiedRequirements = Join-Path $runtime 'requirements.txt'
      $file = [IO.File]::Open($copiedRequirements, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
      try { $file.Write($requirements.Bytes, 0, $requirements.Bytes.Length) } finally { $file.Dispose() }
      $python = Resolve-APSLocalPath -Path (Join-Path $runtime 'Scripts\python.exe') -MustExist
      $null = Invoke-APSProcess -Executable $python -Arguments @('-I', '-B', '-m', 'pip', '--isolated', '--disable-pip-version-check', '--no-input',
        'install', '--no-deps', '--only-binary=:all:', '--no-cache-dir', '--no-compile', '--index-url', 'https://pypi.org/simple', '-r', $copiedRequirements) -Phase 'Pinned dependency installation' -TimeoutSeconds 900
    }
    if ((Get-APSSha256 $requirements.Path) -cne $requirements.Sha256 -or
        (Get-APSSha256 (Join-Path $runtime 'requirements.txt')) -cne $requirements.Sha256) { throw 'Requirements changed during installation.' }
    $verified = Test-APSRuntimePython -RuntimeRoot $runtime -Requirements $requirements
    if ($reused) {
      if (($verified.Info.version -join '.') -cne $receipt.python_version) { throw 'Runtime Python version changed.' }
      Assert-APSFileInventory -Expected $receipt.files -Actual @(Get-APSRuntimeInventory -Root $runtime)
    } else {
      Assert-APSFileInventory -Expected $baseFiles -Actual @(Get-APSBaseInventory -Executable $base.Path -Info $base.Info)
      $receipt = [ordered]@{
        schema = 'awardping.scrapling-runtime.v1'; created_at_utc = [DateTime]::UtcNow.ToString('o')
        runtime_root = $runtime; requirements_sha256 = $requirements.Sha256
        python_executable = $verified.Python; python_version = ($verified.Info.version -join '.')
        base_python_executable = $base.Path; base_files = $baseFiles
        packages = $verified.Versions; files = @(Get-APSRuntimeInventory -Root $runtime)
        excluded_generated_files = @('**/__pycache__/*.pyc', '**/__pycache__/*.pyo')
      }
      $receiptBytes = (New-Object Text.UTF8Encoding($false)).GetBytes(($receipt | ConvertTo-Json -Depth 8))
      $file = [IO.File]::Open($receiptPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
      try { $file.Write($receiptBytes, 0, $receiptBytes.Length) } finally { $file.Dispose() }
    }
    return [pscustomobject]@{
      PythonExecutable = $verified.Python; RuntimeRoot = $runtime
      RequirementsSha256 = $requirements.Sha256; PythonSha256 = (Get-APSSha256 $verified.Python)
      ReceiptPath = $receiptPath; ReceiptSha256 = (Get-APSSha256 $receiptPath); Reused = [bool]$reused
    }
  } finally {
    if ($null -ne $lock) {
      $lock.Dispose()
      $null = Resolve-APSLocalPath -Path $lockPath -MustExist
      Remove-Item -LiteralPath $lockPath -ErrorAction Stop
    }
  }
}

if ($MyInvocation.InvocationName -ne '.') {
  Install-AwardPingScraplingRuntime -InstallRoot $InstallRoot -SourceRoot $SourceRoot -PythonExecutable $PythonExecutable
}
