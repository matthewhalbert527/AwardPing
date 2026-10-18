# Loaded by the worker installer. Defining these functions performs no installation.
# Forward the caller's same-named variables: dot-sourcing a parameterized script
# without arguments would reset the main installer's InstallRoot parameter.
. (Join-Path $PSScriptRoot 'Install-AwardPingScraplingRuntime.ps1') -InstallRoot $InstallRoot -SourceRoot $SourceRoot -PythonExecutable $PythonExecutable

function Get-AwardPingScraplingRuntimeRelativePaths {
  return @(
    'scripts\lib\scrapling-worker.mjs', 'scripts\lib\scrapling-capture.mjs',
    'scripts\lib\scrapling-review-diff.mjs', 'scripts\lib\scrapling-runtime-binding.mjs',
    'scripts\lib\pdf-text-coverage.mjs',
    'scripts\lib\rendered-html-capture.mjs', 'scripts\lib\rendered-html-comparison.mjs',
    'scripts\lib\structured-html-content.mjs', 'scripts\lib\capture-stability.mjs',
    'scripts\lib\capture-resource-limits.mjs', 'scripts\lib\public-network-safety.mjs',
    'scripts\scrapling\collector.py', 'scripts\scrapling\visible-document.js', 'scripts\scrapling\html_document.py',
    'scripts\scrapling\requirements.txt'
  )
}

function Assert-AwardPingScraplingOptIn {
  param([bool]$Enabled, [string]$ManifestPath, [string]$ManifestSha256, [string]$PythonExecutable, [hashtable]$ExistingEnv = @{})
  if (-not $Enabled) {
    if ($ManifestPath -or $ManifestSha256 -or $PythonExecutable -or
        $ExistingEnv['AWARDPING_SCRAPLING_MANIFEST'] -or $ExistingEnv['AWARDPING_SCRAPLING_PYTHON']) {
      throw 'Scrapling configuration requires explicit -EnableScrapling and an exact reviewed manifest/hash. No collector configuration was changed.'
    }
    return
  }
  if (-not $ManifestPath -or $ManifestSha256 -cnotmatch '^[0-9a-f]{64}$') {
    throw 'Enabling Scrapling requires -ScraplingManifestPath and its reviewed lowercase SHA-256 in -ScraplingManifestSha256.'
  }
}

function Test-AwardPingScraplingManifest {
  param([string]$AppDir, [string]$Path, [string]$ExpectedSha256)
  $manifest = Resolve-APSLocalPath -Path $Path -MustExist
  if ((Get-Item -LiteralPath $manifest).Length -gt 262144 -or
      $ExpectedSha256 -cnotmatch '^[0-9a-f]{64}$' -or (Get-APSSha256 $manifest) -cne $ExpectedSha256) {
    throw 'Scrapling manifest does not match the reviewed file/hash or exceeds its limit.'
  }
  $module = Resolve-APSLocalPath -Path (Join-Path $AppDir 'scripts\lib\scrapling-worker.mjs') -MustExist
  $node = (Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
  $code = 'import {pathToFileURL} from "node:url"; const m=await import(pathToFileURL(process.argv[1]).href); const v=m.loadScraplingSourceManifest(process.argv[2]); console.log(JSON.stringify({schema:v.schema,profile:v.profile,source_count:v.sources.length,award_count:v.award_ids.length}));'
  $summary = (Invoke-APSProcess -Executable $node -Arguments @('--input-type=module', '-e', $code, $module, $manifest) -Phase 'Scrapling manifest verification' -TimeoutSeconds 30) | ConvertFrom-Json
  if ($summary.schema -cne 'awardping.scrapling-source-manifest.v1' -or $summary.profile -cne 'scrapling-evidence-v1' -or
      $summary.award_count -ne 25 -or $summary.source_count -lt 1 -or $summary.source_count -gt 300 -or
      (Get-APSSha256 $manifest) -cne $ExpectedSha256) {
    throw 'Scrapling manifest verification did not confirm the exact reviewed document.'
  }
  return $summary
}

function Initialize-AwardPingScraplingInstallation {
  param([string]$InstallRoot, [string]$AppDir, [string]$ManifestPath, [string]$ManifestSha256, [string]$PythonExecutable)
  $install = Assert-APSInstallRoot -Path $InstallRoot
  $app = Resolve-APSLocalPath -Path $AppDir -Directory -MustExist
  if (-not $app.StartsWith($install + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Staged Scrapling app is outside its installation root.' }
  $null = Test-AwardPingScraplingManifest -AppDir $app -Path $ManifestPath -ExpectedSha256 $ManifestSha256
  $manifestTarget = Join-Path $app '.awardping-scrapling-manifest.json'
  $bindingTarget = Join-Path $app '.awardping-scrapling-runtime.json'
  if ((Test-Path -LiteralPath $manifestTarget) -or (Test-Path -LiteralPath $bindingTarget)) {
    throw 'Scrapling installation metadata already exists in the staged app; it was preserved.'
  }
  $runtime = Install-AwardPingScraplingRuntime -InstallRoot $install -SourceRoot $app -PythonExecutable $PythonExecutable
  $inputStream = [IO.File]::Open((Resolve-APSLocalPath -Path $ManifestPath -MustExist), [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
  try {
    if ($inputStream.Length -gt 262144) { throw 'Scrapling manifest exceeds its limit.' }
    $bytes = New-Object byte[] ([int]$inputStream.Length)
    $offset = 0
    while ($offset -lt $bytes.Length) {
      $read = $inputStream.Read($bytes, $offset, $bytes.Length - $offset)
      if ($read -eq 0) { throw 'Scrapling manifest changed while reading.' }
      $offset += $read
    }
    if ($inputStream.ReadByte() -ne -1) { throw 'Scrapling manifest changed while reading.' }
  } finally { $inputStream.Dispose() }
  $stream = [IO.File]::Open($manifestTarget, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
  try { $stream.Write($bytes, 0, $bytes.Length) } finally { $stream.Dispose() }
  $summary = Test-AwardPingScraplingManifest -AppDir $app -Path $manifestTarget -ExpectedSha256 $ManifestSha256
  $binding = [ordered]@{
    schema = 'awardping.scrapling-installation.v1'
    manifest_sha256 = $ManifestSha256
    source_count = $summary.source_count
    requirements_sha256 = $runtime.RequirementsSha256
    python_executable = $runtime.PythonExecutable
    runtime_root = $runtime.RuntimeRoot
    receipt_path = $runtime.ReceiptPath
    receipt_sha256 = $runtime.ReceiptSha256
  }
  $bytes = (New-Object Text.UTF8Encoding($false)).GetBytes(($binding | ConvertTo-Json -Depth 4))
  $stream = [IO.File]::Open($bindingTarget, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
  try { $stream.Write($bytes, 0, $bytes.Length) } finally { $stream.Dispose() }
  return [pscustomobject]$binding
}

function Set-AwardPingScraplingEnvironment {
  param([string]$Path, [string]$FinalAppDir, [object]$Binding)
  if (-not $Binding) { return }
  $manifest = Join-Path (Resolve-APSLocalPath -Path $FinalAppDir -Directory) '.awardping-scrapling-manifest.json'
  # The worker's dotenv reader accepts raw local paths. Reject line/comment
  # delimiters rather than trying to quote or interpolate an unusual path.
  foreach ($value in @($manifest, [string]$Binding.python_executable)) {
    if ($value -match '[\r\n#"'']') { throw 'Scrapling configuration path cannot be represented safely in the worker environment.' }
  }
  $content = Get-Content -LiteralPath $Path -Raw -ErrorAction Stop
  $content = [regex]::Replace($content, '(?m)^\s*(?:export\s+)?AWARDPING_SCRAPLING_(?:MANIFEST|PYTHON)\s*=.*(?:\r?\n|$)', '')
  $content = $content.TrimEnd() + "`r`nAWARDPING_SCRAPLING_MANIFEST=$manifest`r`nAWARDPING_SCRAPLING_PYTHON=$($Binding.python_executable)`r`n"
  [IO.File]::WriteAllText($Path, $content, (New-Object Text.UTF8Encoding($false)))
}

function Assert-AwardPingScraplingInstalledConfiguration {
  param([string]$InstallRoot, [string]$AppDir, [hashtable]$WorkerEnv)
  $manifestValue = [string]$WorkerEnv['AWARDPING_SCRAPLING_MANIFEST']
  $pythonValue = [string]$WorkerEnv['AWARDPING_SCRAPLING_PYTHON']
  if (-not $manifestValue -and -not $pythonValue) { return }
  if (-not $manifestValue -or -not $pythonValue) { throw 'Scrapling environment is incomplete.' }
  $install = Assert-APSInstallRoot -Path $InstallRoot
  $app = Resolve-APSLocalPath -Path $AppDir -Directory -MustExist
  $manifest = Resolve-APSLocalPath -Path (Join-Path $app '.awardping-scrapling-manifest.json') -MustExist
  if (-not $manifestValue.Equals($manifest, [StringComparison]::OrdinalIgnoreCase)) { throw 'Scrapling manifest must be the exact app-local reviewed file.' }
  $bindingPath = Resolve-APSLocalPath -Path (Join-Path $app '.awardping-scrapling-runtime.json') -MustExist
  if ((Get-Item -LiteralPath $bindingPath).Length -gt 65536) { throw 'Scrapling installation metadata exceeds its limit.' }
  $binding = Get-Content -LiteralPath $bindingPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($binding.schema -cne 'awardping.scrapling-installation.v1' -or
      $binding.requirements_sha256 -cnotmatch '^[0-9a-f]{64}$' -or $binding.receipt_sha256 -cnotmatch '^[0-9a-f]{64}$') {
    throw 'Invalid Scrapling installation metadata.'
  }
  $runtimeRoot = Join-Path (Join-Path $install 'runtime') ('scrapling-' + $binding.requirements_sha256)
  $python = Join-Path $runtimeRoot 'Scripts\python.exe'
  $receipt = Resolve-APSLocalPath -Path (Join-Path $runtimeRoot 'runtime-receipt.json') -MustExist
  if ($binding.runtime_root -cne $runtimeRoot -or $binding.python_executable -cne $python -or
      $pythonValue -cne $python -or $binding.receipt_path -cne $receipt -or
      (Get-APSSha256 $receipt) -cne $binding.receipt_sha256) { throw 'Scrapling runtime binding does not match its installed receipt.' }
  $summary = Test-AwardPingScraplingManifest -AppDir $app -Path $manifest -ExpectedSha256 $binding.manifest_sha256
  if ($summary.source_count -ne $binding.source_count) { throw 'Scrapling manifest source count changed.' }
  # Receipt existence and identity were checked above. This call can only verify
  # the matching retained runtime; it must never create a replacement on resume.
  $requirements = Get-APSRequirements -Path (Join-Path $app 'scripts\scrapling\requirements.txt')
  if ($requirements.Sha256 -cne $binding.requirements_sha256) { throw 'Scrapling requirements differ from the installed runtime.' }
  $verified = Install-AwardPingScraplingRuntime -InstallRoot $install -SourceRoot $app
  if (-not $verified.Reused -or $verified.ReceiptSha256 -cne $binding.receipt_sha256 -or $verified.PythonExecutable -cne $python) {
    throw 'Scrapling runtime reuse verification failed.'
  }
}
