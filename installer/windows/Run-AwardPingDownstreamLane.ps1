param(
  [string]$InstallRoot = "",
  [Parameter(Mandatory = $true)]
  [ValidateSet(
    "new_page_review",
    "changed_page_review",
    "feedback_promotion",
    "suppression",
    "reconciliation",
    "page_audit",
    "manual_quarantine",
    "nightly_report"
  )]
  [string]$Lane,
  [ValidateRange(2, 120)]
  [int]$TimeoutMinutes = 10
)

$ErrorActionPreference = "Stop"

function Resolve-InstallRoot {
  param([string]$RequestedRoot)

  if (-not [string]::IsNullOrWhiteSpace($RequestedRoot)) {
    return [System.IO.Path]::GetFullPath($RequestedRoot)
  }

  $scriptDirectory = Split-Path -Parent $PSCommandPath
  if (Test-Path -LiteralPath (Join-Path $scriptDirectory "app")) {
    return $scriptDirectory
  }

  return (Join-Path $env:LOCALAPPDATA "AwardPingWorker")
}

$InstallRoot = Resolve-InstallRoot -RequestedRoot $InstallRoot
$AppDir = Join-Path $InstallRoot "app"
$LogDir = Join-Path $InstallRoot "logs"
$LockPath = Join-Path $InstallRoot "downstream-lane-$Lane.lock"
$SummaryLog = Join-Path $LogDir "awardping-downstream-$Lane.log"
$LaneScript = Join-Path $AppDir "scripts\run-downstream-lane.mjs"

function Test-DownstreamLogPathWithinDirectory {
  param([string]$Path)

  if ([string]::IsNullOrWhiteSpace($Path)) {
    return $false
  }

  try {
    $normalizedLogDir = [System.IO.Path]::GetFullPath($LogDir).TrimEnd("\", "/")
    $normalizedPath = [System.IO.Path]::GetFullPath($Path)
    $directoryPrefix = "$normalizedLogDir$([System.IO.Path]::DirectorySeparatorChar)"
    return $normalizedPath.StartsWith(
      $directoryPrefix,
      [System.StringComparison]::OrdinalIgnoreCase
    )
  } catch {
    return $false
  }
}

function Remove-DownstreamLogFile {
  param([string]$Path)

  if (-not (Test-DownstreamLogPathWithinDirectory -Path $Path)) {
    throw "Refusing to remove a downstream log outside the verified log directory: $Path"
  }
  if (Test-Path -LiteralPath $Path -PathType Container) {
    throw "Refusing to remove a directory during downstream log retention: $Path"
  }
  if (Test-Path -LiteralPath $Path -PathType Leaf) {
    Remove-Item -LiteralPath $Path -Force -ErrorAction Stop
  }
}

function Invoke-DownstreamLogRetention {
  param(
    [ValidateRange(1, 10000)]
    [int]$MaxRunLogFiles = 2000,
    [ValidateRange(1, 365)]
    [int]$MaxRunLogAgeDays = 14,
    [ValidateRange(1, 1000)]
    [int]$MaxTemporaryLogFiles = 64,
    [ValidateRange(1, 168)]
    [int]$MaxTemporaryLogAgeHours = 24
  )

  New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
  $lanePattern = "(?:new_page_review|changed_page_review|feedback_promotion|suppression|reconciliation|page_audit|manual_quarantine|nightly_report)"
  $runLogPattern = "^awardping-downstream-$lanePattern-\d{8}-\d{6}-\d{3}-\d+\.log$"
  $temporaryLogPattern = "^awardping-downstream-$lanePattern-\d{8}-\d{6}-\d{3}-\d+\.(?:stdout|stderr)\.tmp$"
  $now = [DateTime]::UtcNow

  $runLogs = @(Get-ChildItem -LiteralPath $LogDir -File -ErrorAction Stop | Where-Object {
    $_.Name -match $runLogPattern
  })
  foreach ($file in @($runLogs | Where-Object {
    $_.LastWriteTimeUtc -lt $now.AddDays(-$MaxRunLogAgeDays)
  })) {
    Remove-DownstreamLogFile -Path $file.FullName
  }

  $runLogs = @(Get-ChildItem -LiteralPath $LogDir -File -ErrorAction Stop | Where-Object {
    $_.Name -match $runLogPattern
  } | Sort-Object LastWriteTimeUtc, FullName -Descending)
  foreach ($file in @($runLogs | Select-Object -Skip $MaxRunLogFiles)) {
    Remove-DownstreamLogFile -Path $file.FullName
  }

  $temporaryLogs = @(Get-ChildItem -LiteralPath $LogDir -File -ErrorAction Stop | Where-Object {
    $_.Name -match $temporaryLogPattern
  })
  foreach ($file in @($temporaryLogs | Where-Object {
    $_.LastWriteTimeUtc -lt $now.AddHours(-$MaxTemporaryLogAgeHours)
  })) {
    Remove-DownstreamLogFile -Path $file.FullName
  }

  $temporaryLogs = @(Get-ChildItem -LiteralPath $LogDir -File -ErrorAction Stop | Where-Object {
    $_.Name -match $temporaryLogPattern
  } | Sort-Object LastWriteTimeUtc, FullName -Descending)
  foreach ($file in @($temporaryLogs | Select-Object -Skip $MaxTemporaryLogFiles)) {
    Remove-DownstreamLogFile -Path $file.FullName
  }
}

function Rotate-DownstreamLaneSummaryLog {
  param(
    [ValidateRange(1024, 104857600)]
    [long]$MaxBytes = 5MB
  )

  if (-not (Test-Path -LiteralPath $SummaryLog -PathType Leaf)) {
    return
  }
  if ((Get-Item -LiteralPath $SummaryLog -ErrorAction Stop).Length -lt $MaxBytes) {
    return
  }

  $previousSummaryLog = "$SummaryLog.previous.log"
  if (
    -not (Test-DownstreamLogPathWithinDirectory -Path $SummaryLog) -or
    -not (Test-DownstreamLogPathWithinDirectory -Path $previousSummaryLog)
  ) {
    throw "Refusing to rotate a downstream summary outside the verified log directory."
  }
  Remove-DownstreamLogFile -Path $previousSummaryLog
  Move-Item `
    -LiteralPath $SummaryLog `
    -Destination $previousSummaryLog `
    -ErrorAction Stop
}

function Write-LaneLog {
  param([string]$Message)

  New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
  Rotate-DownstreamLaneSummaryLog
  $boundedMessage = [string]$Message
  if ($boundedMessage.Length -gt 4096) {
    $boundedMessage = $boundedMessage.Substring(0, 4096) + " [truncated]"
  }
  Add-Content `
    -LiteralPath $SummaryLog `
    -Value ("{0} {1}" -f (Get-Date -Format "o"), $boundedMessage) `
    -Encoding UTF8
}

function Write-LaneLogBestEffort {
  param([string]$Message)

  # Failure-path logging must never replace the result it reports: a
  # summary log that cannot be written (rotation failure, share denial, a
  # full disk) is swallowed here so the intended exit code still propagates
  # and lock release is never skipped.
  try {
    Write-LaneLog $Message
  } catch {
  }
}

function Get-LaneRootException {
  param($ErrorRecord)

  # A .NET method or constructor failure reaches a bare `catch` wrapped in a
  # MethodInvocationException whose HResult is the wrapper's own, not the
  # Win32 code; the real exception is the innermost one. Typed catches
  # already receive the unwrapped exception (verified on Windows PowerShell
  # 5.1 and PowerShell 7), so this is only needed on the bare-catch paths.
  $exception = $ErrorRecord.Exception
  while (
    $exception -and
    $exception.InnerException -and
    (
      $exception -is [System.Management.Automation.MethodInvocationException] -or
      $exception -is [System.Management.Automation.RuntimeException]
    )
  ) {
    $exception = $exception.InnerException
  }
  return $exception
}

function Get-LaneNativeErrorCode {
  param($Exception)

  if (-not $Exception) {
    return -1
  }
  return ($Exception.HResult -band 0xFFFF)
}

function Write-LaneLockUnavailable {
  param(
    [string]$Stage,
    $Exception,
    [string]$Type = "",
    [string]$Message = ""
  )

  # Every lock state this launch cannot verify is reported as
  # lock_unavailable with the stage it failed at and the native error code
  # or exception type, so a persistent problem (a foreign holder, a
  # directory at the path, a lock that never releases) shows up as a
  # non-zero task result and a named cause, never as a quiet skip.
  if ([string]::IsNullOrWhiteSpace($Type)) {
    $Type = if ($Exception) { $Exception.GetType().FullName } else { "unknown" }
  }
  if ([string]::IsNullOrWhiteSpace($Message) -and $Exception) {
    $Message = [string]$Exception.Message
  }
  Write-LaneLogBestEffort "lock_unavailable lane=$Lane stage=$Stage native_error=$(Get-LaneNativeErrorCode $Exception) type=$Type lock=$LockPath message=$Message"
}

function Read-LaneLockContentFromHandle {
  param(
    [System.IO.FileStream]$Stream,
    [int]$Offset = 0,
    [int]$MaxBytes = 4096
  )

  # Read through the SAME handle that holds the byte lock, never through a
  # fresh pathname open, and read to verified end of file: a genuine record
  # is a few hundred bytes, so the loop stops only at EOF or once MaxBytes + 1
  # bytes have arrived. Anything longer than MaxBytes is not a record this
  # launch may reason about and is refused outright - a prefix of a longer
  # file is never classified, complete-looking or not. Decoding is strict
  # ASCII: the retired writer encoded its record with ASCII.GetBytes (every
  # non-ASCII character became '?') and this launch writes ASCII too, so a
  # byte above 127 belongs to neither protocol and is refused rather than
  # silently mapped to '?'.
  $Stream.Seek($Offset, [System.IO.SeekOrigin]::Begin) | Out-Null
  $buffer = New-Object byte[] ($MaxBytes + 1)
  $total = 0
  while ($total -lt $buffer.Length) {
    $read = $Stream.Read($buffer, $total, $buffer.Length - $total)
    if ($read -le 0) {
      break
    }
    $total += $read
  }
  if ($total -gt $MaxBytes) {
    throw [System.IO.InvalidDataException]::new("The lock file holds more than $MaxBytes bytes past offset $Offset; a longer file is never classified from a prefix.")
  }
  $strictAscii = [System.Text.Encoding]::GetEncoding(20127, [System.Text.EncoderFallback]::ExceptionFallback, [System.Text.DecoderFallback]::ExceptionFallback)
  return $strictAscii.GetString($buffer, 0, $total)
}

function Get-LaneProcessLiveness {
  param([int]$ProcessId)

  # Tri-state on purpose. Only the specific "no process with this id" error
  # is a confirmed dead process; every other failure (access denial, a
  # provider or argument failure, anything unexpected) is unverifiable, so
  # a lookup failure can never launder a possibly live legacy owner into a
  # reclaimable record.
  try {
    $null = Get-Process -Id $ProcessId -ErrorAction Stop
    return "alive"
  } catch [Microsoft.PowerShell.Commands.ProcessCommandException] {
    if ([string]$_.FullyQualifiedErrorId -like "NoProcessFoundForGivenId,*") {
      return "dead"
    }
    return "unverifiable"
  } catch {
    return "unverifiable"
  }
}

function Get-LaneCanonicalPowerShellPath {
  # The Windows PowerShell 5.1 image the retired scheduled task ran under,
  # derived from the trusted Windows system directory - never from PATH and
  # never from anything the inspected process reports about itself.
  return [System.IO.Path]::GetFullPath((Join-Path ([System.Environment]::SystemDirectory) "WindowsPowerShell\v1.0\powershell.exe"))
}

function ConvertTo-LaneDateTimeOffset {
  param($Value)

  # Normalizes a creation time read from CIM (or supplied to a test seam)
  # into a DateTimeOffset, or $null when it is missing, blank, of an
  # unexpected type, or unparseable. A DateTime keeps its own kind (Utc maps
  # to +00:00; Local and Unspecified take the local offset, which is how the
  # CIM converter reports Win32_Process.CreationDate on this machine). Only
  # a string is ever parsed; numbers, booleans and other objects are never
  # stringified into a date (1.5 would otherwise parse as one).
  if ($null -eq $Value) {
    return $null
  }
  try {
    if ($Value -is [DateTimeOffset]) {
      return $Value
    }
    if ($Value -is [DateTime]) {
      return [DateTimeOffset]::new($Value)
    }
    if ($Value -isnot [string]) {
      return $null
    }
    $text = $Value
    if ([string]::IsNullOrWhiteSpace($text)) {
      return $null
    }
    $parsed = [DateTimeOffset]::MinValue
    $styles = [System.Globalization.DateTimeStyles]::RoundtripKind -bor [System.Globalization.DateTimeStyles]::AssumeLocal
    if ([DateTimeOffset]::TryParse($text, [System.Globalization.CultureInfo]::InvariantCulture, $styles, [ref]$parsed)) {
      return $parsed
    }
    return $null
  } catch {
    return $null
  }
}

function Get-LaneProcessIdentity {
  param([int]$ProcessId)

  # Consulted only after Get-LaneProcessLiveness answered "alive". Reads the
  # command line, the executable path AND the creation time from the SAME
  # Win32_Process row and returns them together, or $null whenever the
  # identity cannot be read in full: a query failure, no row, more than one
  # row, a row for a different ProcessId, a blank command line or executable
  # path, or a missing, blank or unparseable creation time. The caller
  # treats $null as unverifiable, never as an absent owner.
  try {
    $rows = @(Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction Stop)
  } catch {
    return $null
  }
  if ($rows.Count -ne 1) {
    return $null
  }
  $row = $rows[0]
  if (-not $row -or [int64]$row.ProcessId -ne [int64]$ProcessId) {
    return $null
  }
  $commandLine = [string]$row.CommandLine
  $executablePath = [string]$row.ExecutablePath
  if ([string]::IsNullOrWhiteSpace($commandLine) -or [string]::IsNullOrWhiteSpace($executablePath)) {
    return $null
  }
  $creationDate = ConvertTo-LaneDateTimeOffset -Value $row.CreationDate
  if ($null -eq $creationDate) {
    return $null
  }
  return @{
    CommandLine = $commandLine
    ExecutablePath = $executablePath
    CreationDate = $creationDate
  }
}

function Get-LaneNormalizedPath {
  param(
    [AllowNull()]
    [AllowEmptyString()]
    [string]$Path
  )

  # An absolute Windows path (drive-rooted or UNC), normalized by the
  # runtime and stripped of trailing separators; $null for anything else.
  if ([string]::IsNullOrWhiteSpace($Path)) {
    return $null
  }
  if ($Path -notmatch "^(?:[A-Za-z]:[\\/]|\\\\)") {
    return $null
  }
  try {
    return [System.IO.Path]::GetFullPath($Path).TrimEnd("\", "/")
  } catch {
    return $null
  }
}

function Get-LaneCommandLineTokens {
  param(
    [AllowNull()]
    [AllowEmptyString()]
    [string]$CommandLine
  )

  # Splits a Windows command line the way the retired wrapper's own host
  # (Windows PowerShell 5.1, .NET Framework argument parsing) did:
  # whitespace separates arguments, double quotes group, 2n backslashes
  # before a quote yield n backslashes and a delimiter, 2n+1 yield n
  # backslashes and a literal quote, backslashes elsewhere are literal, and
  # a doubled quote INSIDE a quoted region yields one literal quote and
  # leaves the region. PowerShell 7 instead stays inside the region after a
  # doubled quote, so the two hosts diverge whenever text follows one -
  # which is exactly why the grammar below never accepts any doubled-quote
  # spelling at all. Returns Tokens (parsed values), Spellings (each
  # token's raw text), Simple (per token: bare text, or exactly one pair of
  # quotes with no quote inside - the only two spellings the installer's
  # task action can produce) and Valid ($false when the line ends inside an
  # unmatched quote).
  $tokens = New-Object System.Collections.Generic.List[string]
  $spellings = New-Object System.Collections.Generic.List[string]
  $simple = New-Object System.Collections.Generic.List[bool]
  $valid = $true
  if (-not [string]::IsNullOrEmpty($CommandLine)) {
    $current = New-Object System.Text.StringBuilder
    $inQuotes = $false
    $hasToken = $false
    $tokenStart = 0
    $index = 0
    $length = $CommandLine.Length
    while ($index -lt $length) {
      $char = $CommandLine[$index]
      $isSpace = ($char -eq [char]32 -or $char -eq [char]9)
      if (-not $hasToken -and -not $isSpace) {
        $tokenStart = $index
      }
      if ($char -eq [char]92) {
        $slashCount = 0
        while ($index -lt $length -and $CommandLine[$index] -eq [char]92) {
          $slashCount += 1
          $index += 1
        }
        if ($index -lt $length -and $CommandLine[$index] -eq [char]34) {
          [void]$current.Append(([string][char]92) * [int][Math]::Floor($slashCount / 2))
          if ($slashCount % 2 -eq 1) {
            [void]$current.Append([char]34)
            $index += 1
          }
        } else {
          [void]$current.Append(([string][char]92) * $slashCount)
        }
        $hasToken = $true
        continue
      }
      if ($char -eq [char]34) {
        $hasToken = $true
        if ($inQuotes -and ($index + 1) -lt $length -and $CommandLine[$index + 1] -eq [char]34) {
          [void]$current.Append([char]34)
          $inQuotes = $false
          $index += 2
          continue
        }
        $inQuotes = -not $inQuotes
        $index += 1
        continue
      }
      if (-not $inQuotes -and $isSpace) {
        if ($hasToken) {
          $spelling = $CommandLine.Substring($tokenStart, $index - $tokenStart)
          [void]$tokens.Add($current.ToString())
          [void]$spellings.Add($spelling)
          [void]$simple.Add(($spelling -match '^[^\s"]+$') -or ($spelling -match '^"[^"]*"$'))
          [void]$current.Clear()
          $hasToken = $false
        }
        $index += 1
        continue
      }
      [void]$current.Append($char)
      $hasToken = $true
      $index += 1
    }
    if ($inQuotes) {
      $valid = $false
    }
    if ($hasToken) {
      $spelling = $CommandLine.Substring($tokenStart, $length - $tokenStart)
      [void]$tokens.Add($current.ToString())
      [void]$spellings.Add($spelling)
      [void]$simple.Add(($spelling -match '^[^\s"]+$') -or ($spelling -match '^"[^"]*"$'))
    }
  }
  return [pscustomobject]@{
    Valid = $valid
    Tokens = $tokens.ToArray()
    Spellings = $spellings.ToArray()
    Simple = $simple.ToArray()
  }
}

function Split-LaneCommandLine {
  param(
    [AllowNull()]
    [AllowEmptyString()]
    [string]$CommandLine
  )

  # Token values only, and nothing at all for a line that ends inside an
  # unmatched quote. Emitted element by element; callers collect with @()
  # so zero, one or many tokens all arrive as a plain string array.
  $parsed = Get-LaneCommandLineTokens -CommandLine $CommandLine
  if (-not $parsed.Valid) {
    return
  }
  return $parsed.Tokens
}

function Get-LegacyLaneRecord {
  param(
    [AllowNull()]
    [AllowEmptyString()]
    [string]$Content,
    [string]$LaneKey,
    [string]$ExpectedLogDir
  )

  # Parses the content that was in the lock file before this launch took
  # the byte lock. The retired wrapper wrote exactly
  #   pid=<PID> lane=<Lane> started=<Get-Date -Format o> log=<absolute run log>
  # with the PID in its canonical decimal spelling (never leading zeros),
  # the lane as one of the eight exact lowercase keys, and the run log at
  # <LogDir>\awardping-downstream-<Lane>-<yyyyMMdd>-<HHmmss>-<fff>-<PID>.log,
  # no sentinel and no trailing newline - the whole record encoded with
  # ASCII.GetBytes, so a log directory under a non-ASCII root was persisted
  # with each non-ASCII character replaced by '?'. Returns Kind "none" (not a
  # legacy record at all: empty, sentinel-prefixed, no "pid=" anchor,
  # unusable PID), "pid" (anchored at pid= but not the complete retired
  # shape for THIS lane and log directory), or "complete" with the record's
  # PID and its strictly parsed Started time.
  $exactLaneKeys = @(
    "new_page_review",
    "changed_page_review",
    "feedback_promotion",
    "suppression",
    "reconciliation",
    "page_audit",
    "manual_quarantine",
    "nightly_report"
  )
  if ([string]::IsNullOrEmpty($Content)) {
    return @{ Kind = "none"; ProcessId = 0 }
  }
  if ($Content[0] -eq [char]0) {
    return @{ Kind = "none"; ProcessId = 0 }
  }
  $pidMatch = [regex]::Match($Content, "^pid=(\d+)\b")
  if (-not $pidMatch.Success) {
    return @{ Kind = "none"; ProcessId = 0 }
  }
  $recordPid = 0
  if (-not [int]::TryParse($pidMatch.Groups[1].Value, [ref]$recordPid) -or $recordPid -le 0) {
    return @{ Kind = "none"; ProcessId = 0 }
  }
  $partial = @{ Kind = "pid"; ProcessId = $recordPid }
  if (-not ($exactLaneKeys -ccontains $LaneKey)) {
    return $partial
  }
  $complete = [regex]::Match($Content, "^pid=(\d+) lane=(\S+) started=(\S+) log=([^\r\n]+)\z")
  if (-not $complete.Success) {
    return $partial
  }
  # The retired writer emitted $PID itself: the field must be the canonical
  # invariant decimal spelling of the parsed value, so pid=0004244 is never
  # complete.
  if (-not [string]::Equals($complete.Groups[1].Value, $recordPid.ToString([System.Globalization.CultureInfo]::InvariantCulture), [System.StringComparison]::Ordinal)) {
    return $partial
  }
  if (-not [string]::Equals($complete.Groups[2].Value, $LaneKey, [System.StringComparison]::Ordinal)) {
    return $partial
  }
  $startedText = $complete.Groups[3].Value
  $started = [DateTimeOffset]::MinValue
  $roundTrips = [DateTimeOffset]::TryParseExact(
    $startedText,
    "o",
    [System.Globalization.CultureInfo]::InvariantCulture,
    [System.Globalization.DateTimeStyles]::RoundtripKind,
    [ref]$started
  )
  if (-not $roundTrips -or $started.ToString("o", [System.Globalization.CultureInfo]::InvariantCulture) -ne $startedText) {
    return $partial
  }
  # The stored log path is split as text at its last backslash (Join-Path
  # is what the retired writer used) and its directory must equal the exact
  # ASCII projection of the normalized expected log directory - for an
  # all-ASCII directory that projection is the directory itself. The stored
  # text is never normalized or otherwise interpreted, and it binds nothing
  # by itself: the live process's command line still has to carry the true
  # Unicode script and root paths.
  $logValue = $complete.Groups[4].Value
  $separator = $logValue.LastIndexOf([char]92)
  if ($separator -le 0 -or $separator -ge ($logValue.Length - 1)) {
    return $partial
  }
  $logDirectory = $logValue.Substring(0, $separator)
  $logName = $logValue.Substring($separator + 1)
  $expectedDirectory = Get-LaneNormalizedPath -Path $ExpectedLogDir
  if (-not $expectedDirectory) {
    return $partial
  }
  $expectedProjection = [System.Text.Encoding]::ASCII.GetString([System.Text.Encoding]::ASCII.GetBytes($expectedDirectory))
  if (-not [string]::Equals($logDirectory, $expectedProjection, [System.StringComparison]::OrdinalIgnoreCase)) {
    return $partial
  }
  $expectedName = "^awardping-downstream-" + [regex]::Escape($LaneKey) + "-\d{8}-\d{6}-\d{3}-" + $recordPid + "\.log$"
  if (-not [regex]::IsMatch($logName, $expectedName)) {
    return $partial
  }
  return @{ Kind = "complete"; ProcessId = $recordPid; Started = $started }
}

function Test-LegacyLaneInvocation {
  param(
    [AllowNull()]
    [AllowEmptyString()]
    [string]$CommandLine,
    [string]$ExpectedScriptPath,
    [string]$ExpectedInstallRoot,
    [string]$LaneKey,
    [string]$CanonicalHostPath
  )

  # True only for the one provable retired scheduled-task grammar (installer
  # history e57db14 through 3a4c118 and the current registration): exactly
  # 14 tokens, in this order,
  #   <powershell.exe | the canonical Windows PowerShell image path>
  #   -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass
  #   -File <ExpectedScriptPath> -InstallRoot <ExpectedInstallRoot>
  #   -Lane <LaneKey> -TimeoutMinutes <that lane's configured timeout>
  # Raw spellings are checked positionally: every switch, every fixed
  # value, the lane and the timeout must be the exact bare historical
  # spelling and case. Only the host, the script path and the install root
  # may be spelled bare or as one pair of plain quotes - the two forms the
  # hidden launcher produces - and those three compare as normalized,
  # case-insensitive paths. The host is either the bare name powershell.exe
  # or the separately verified canonical image path, never an arbitrary
  # local or UNC path that merely ends in powershell.exe and never pwsh.
  # Abbreviations, omitted, reordered, quoted or duplicated switches, extra
  # arguments, manual shorthand, an unsupported lane and any other timeout
  # all reject; a live PID whose command line misses this grammar stays
  # unverifiable, never reclaimable.
  $configuredTimeouts = @{
    new_page_review = "10"
    changed_page_review = "10"
    feedback_promotion = "6"
    suppression = "6"
    reconciliation = "6"
    page_audit = "6"
    manual_quarantine = "4"
    nightly_report = "4"
  }
  # A PowerShell hashtable compares keys case-insensitively, so the lane
  # key is first held to the exact lowercase spellings the retired tasks
  # emitted; MANUAL_QUARANTINE never resolves a timeout.
  $exactLaneKeys = @(
    "new_page_review",
    "changed_page_review",
    "feedback_promotion",
    "suppression",
    "reconciliation",
    "page_audit",
    "manual_quarantine",
    "nightly_report"
  )
  if ([string]::IsNullOrEmpty($LaneKey) -or -not ($exactLaneKeys -ccontains $LaneKey) -or -not $configuredTimeouts.ContainsKey($LaneKey)) {
    return $false
  }
  $expectedScript = Get-LaneNormalizedPath -Path $ExpectedScriptPath
  $expectedRoot = Get-LaneNormalizedPath -Path $ExpectedInstallRoot
  $canonicalHost = Get-LaneNormalizedPath -Path $CanonicalHostPath
  if (-not $expectedScript -or -not $expectedRoot -or -not $canonicalHost) {
    return $false
  }
  $parsed = Get-LaneCommandLineTokens -CommandLine $CommandLine
  if (-not $parsed.Valid) {
    return $false
  }
  $tokens = @($parsed.Tokens)
  $spellings = @($parsed.Spellings)
  $simple = @($parsed.Simple)
  if ($tokens.Count -ne 14) {
    return $false
  }
  $fixedSpellings = @(
    @(1, "-NoProfile"),
    @(2, "-WindowStyle"),
    @(3, "Hidden"),
    @(4, "-ExecutionPolicy"),
    @(5, "Bypass"),
    @(6, "-File"),
    @(8, "-InstallRoot"),
    @(10, "-Lane"),
    @(11, $LaneKey),
    @(12, "-TimeoutMinutes"),
    @(13, $configuredTimeouts[$LaneKey])
  )
  foreach ($fixed in $fixedSpellings) {
    if (-not [string]::Equals($spellings[$fixed[0]], $fixed[1], [System.StringComparison]::Ordinal)) {
      return $false
    }
  }
  foreach ($position in @(0, 7, 9)) {
    if (-not $simple[$position]) {
      return $false
    }
  }
  $hostValue = $tokens[0]
  if (-not [string]::Equals($hostValue, "powershell.exe", [System.StringComparison]::OrdinalIgnoreCase)) {
    $hostPath = Get-LaneNormalizedPath -Path $hostValue
    if (-not $hostPath -or -not [string]::Equals($hostPath, $canonicalHost, [System.StringComparison]::OrdinalIgnoreCase)) {
      return $false
    }
  }
  $scriptPath = Get-LaneNormalizedPath -Path $tokens[7]
  if (-not $scriptPath -or -not [string]::Equals($scriptPath, $expectedScript, [System.StringComparison]::OrdinalIgnoreCase)) {
    return $false
  }
  $rootPath = Get-LaneNormalizedPath -Path $tokens[9]
  if (-not $rootPath -or -not [string]::Equals($rootPath, $expectedRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    return $false
  }
  return $true
}

function Get-LegacyLaneLockOwnerState {
  param(
    [AllowNull()]
    [AllowEmptyString()]
    [string]$Content,
    [string]$LaneKey,
    [int]$CurrentProcessId,
    [string]$ExpectedScriptPath,
    [string]$ExpectedInstallRoot,
    [string]$ExpectedLogDir,
    [string]$CanonicalHostPath,
    [scriptblock]$GetProcessLiveness = { param([int]$ProcessId) Get-LaneProcessLiveness -ProcessId $ProcessId },
    [scriptblock]$GetProcessIdentity = { param([int]$ProcessId) Get-LaneProcessIdentity -ProcessId $ProcessId }
  )

  # Classifies the content that was ALREADY in the lock file when this
  # launch took the byte lock. A live legacy instance of the retired
  # CreateNew wrapper holds no handle and cannot contend for byte 0, so it
  # is visible only through its complete record and a live process that was
  # created no later than the record it wrote, runs the canonical Windows
  # PowerShell image, and carries the exact retired invocation. Returns:
  #   reclaimable            - no legacy record at all, a record naming this
  #                            launch's own PID, or a record whose PID is a
  #                            CONFIRMED dead process
  #   legacy_live            - a complete record for this lane whose PID is
  #                            alive, was created no later than the record
  #                            (within the fixed allowance), runs the
  #                            canonical Windows PowerShell image, and
  #                            carries the exact retired invocation of this
  #                            script, root and lane
  #   unverifiable:<reason>  - anything else that names a process which is
  #                            not confirmed dead: a liveness lookup failure,
  #                            an incomplete or foreign record naming a live
  #                            process, an unreadable identity row, an
  #                            executable other than the canonical image, a
  #                            process created after the record (a reused
  #                            PID), or a command line that is not the
  #                            retired invocation. The caller fails closed.
  # A live process is never reclaimed under a pid-bearing record; only a
  # confirmed dead one is. PID 0 and negative values can never be the
  # retired wrapper's $PID and are treated as no record.
  #
  # Incarnation allowance: a genuine writer exists before it writes its
  # record, so its creation time can never follow the record's started time
  # by more than clock resolution. WMI reports creation time at millisecond
  # resolution and Get-Date at 100-nanosecond resolution, both from the same
  # machine clock; 5 seconds is a deliberately conservative fixed allowance
  # for that, and nothing more. A process created later than that is a
  # reused PID, never the writer.
  $incarnationAllowanceSeconds = 5
  $record = Get-LegacyLaneRecord -Content $Content -LaneKey $LaneKey -ExpectedLogDir $ExpectedLogDir
  if ($record.Kind -eq "none") {
    return "reclaimable"
  }
  if ($record.ProcessId -eq $CurrentProcessId) {
    return "reclaimable"
  }
  $liveness = [string](& $GetProcessLiveness $record.ProcessId)
  if ($liveness -eq "dead") {
    return "reclaimable"
  }
  if ($liveness -ne "alive") {
    return "unverifiable:liveness_lookup_failed"
  }
  if ($record.Kind -ne "complete") {
    return "unverifiable:incomplete_record_names_live_process"
  }
  $identity = & $GetProcessIdentity $record.ProcessId
  if (
    -not $identity -or
    [string]::IsNullOrWhiteSpace([string]$identity.CommandLine) -or
    [string]::IsNullOrWhiteSpace([string]$identity.ExecutablePath) -or
    -not ($identity.CreationDate -is [DateTimeOffset])
  ) {
    return "unverifiable:identity_unreadable"
  }
  $canonicalHost = Get-LaneNormalizedPath -Path $CanonicalHostPath
  $executablePath = Get-LaneNormalizedPath -Path ([string]$identity.ExecutablePath)
  if (-not $canonicalHost -or -not $executablePath -or -not [string]::Equals($executablePath, $canonicalHost, [System.StringComparison]::OrdinalIgnoreCase)) {
    return "unverifiable:executable_mismatch"
  }
  if (-not ($record.Started -is [DateTimeOffset])) {
    return "unverifiable:incomplete_record_names_live_process"
  }
  if (($identity.CreationDate - $record.Started).TotalSeconds -gt $incarnationAllowanceSeconds) {
    return "unverifiable:process_newer_than_record"
  }
  $invocationMatches = Test-LegacyLaneInvocation `
    -CommandLine ([string]$identity.CommandLine) `
    -ExpectedScriptPath $ExpectedScriptPath `
    -ExpectedInstallRoot $ExpectedInstallRoot `
    -LaneKey $LaneKey `
    -CanonicalHostPath $canonicalHost
  if ($invocationMatches) {
    return "legacy_live"
  }
  return "unverifiable:command_line_mismatch"
}

function Append-OutputFile {
  param(
    [string]$Path,
    [string]$RunLog,
    [string]$Stream
  )

  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    return
  }

  foreach ($line in @(Get-Content -LiteralPath $Path -ErrorAction SilentlyContinue)) {
    $text = [string]$line
    Write-Host $text
    Add-Content -LiteralPath $RunLog -Value ("{0} {1}" -f $Stream, $text) -Encoding UTF8
  }
}

if (-not (Test-Path -LiteralPath $LaneScript -PathType Leaf)) {
  throw "Missing downstream lane runner: $LaneScript"
}

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
try {
  Invoke-DownstreamLogRetention
} catch {
  Write-Warning "Downstream log retention could not complete safely: $($_.Exception.Message)"
}
$nodePath = (Get-Command node.exe -ErrorAction Stop).Source
$stamp = "{0}-{1}" -f (Get-Date -Format "yyyyMMdd-HHmmss-fff"), $PID
$runLog = Join-Path $LogDir "awardping-downstream-$Lane-$stamp.log"
$stdoutPath = Join-Path $LogDir "awardping-downstream-$Lane-$stamp.stdout.tmp"
$stderrPath = Join-Path $LogDir "awardping-downstream-$Lane-$stamp.stderr.tmp"
$timeBudgetMs = [Math]::Max(60000, ($TimeoutMinutes * 60 * 1000) - 60000)
$exitCode = 1
$process = $null

# ---------------------------------------------------------------------------
# Lane lock: a persistent advisory file whose byte 0 is the ownership
# primitive. The file is opened non-exclusively (OpenOrCreate, ReadWrite,
# FileShare.ReadWrite) so every cooperating launch can always open it, and
# exactly one handle can hold Lock(0, 1) at a time. That handle - and the
# byte lock on it - lives from acquisition through the metadata write, the
# run-log initialization, the child launch, wait and output handling, and
# every piece of work cleanup, and is released only in the final finally.
#
# The lock path is never removed, renamed or replaced by this launch, and
# FileShare.Delete is deliberately absent: while an owner is alive no other
# actor can delete or replace the path (sharing violation), and after
# release the file simply stays, so pathname identity never has to be
# re-proven and a stale file from a crash is reclaimed by the next Lock,
# never by deleting it. Byte 0 is a NUL sentinel that no legacy writer ever
# produced; versioned ASCII metadata starts at offset 1 and is diagnostic
# only - it can never justify skipping or claiming.
#
# Any state this launch cannot verify is a hard, visible failure: an open
# failure (a missing directory, a foreign holder with an incompatible share
# mode, a directory at the path, an access denial), any Lock failure -
# including native error 33, because a byte-0 holder cannot be proven to be
# AwardPing from content alone - an oversized lock file, or a legacy record
# that cannot be resolved to a confirmed dead process or to a live process
# running the canonical Windows PowerShell image with the exact retired
# invocation, all log lock_unavailable and exit non-zero. The single lock-related exit 0 is a
# verified live legacy owner from the retired CreateNew wrapper during the
# rollout transition.
# ---------------------------------------------------------------------------
$lockContent = "protocol=2 pid=$PID lane=$Lane started=$(Get-Date -Format o) log=$runLog"
$lockStream = $null
try {
  $lockStream = [System.IO.FileStream]::new(
    $LockPath,
    [System.IO.FileMode]::OpenOrCreate,
    [System.IO.FileAccess]::ReadWrite,
    [System.IO.FileShare]::ReadWrite
  )
} catch [System.IO.IOException] {
  # DirectoryNotFoundException is an IOException and lands here too, with
  # its own native code and type in the diagnostic.
  Write-LaneLockUnavailable -Stage "open" -Exception $_.Exception
  exit 1
} catch {
  Write-LaneLockUnavailable -Stage "open" -Exception (Get-LaneRootException $_)
  exit 1
}

$lockAcquired = $false
$unlockFailure = $null
$disposeFailure = $null
try {
  try {
    $lockStream.Lock(0, 1)
    $lockAcquired = $true
  } catch [System.IO.IOException] {
    # Native error 33 means someone physically holds byte 0 right now, but
    # the recorded metadata is not bound to that holder's identity, so no
    # collision is ever classified as a benign "already running": the
    # launch fails closed and the task result names the cause.
    Write-LaneLockUnavailable -Stage "lock" -Exception $_.Exception
  } catch {
    Write-LaneLockUnavailable -Stage "lock" -Exception (Get-LaneRootException $_)
  }

  if ($lockAcquired) {
    # Rollout transition: read whatever the file held BEFORE this launch
    # overwrites it, through the owning handle. Only a complete retired
    # record naming a live process whose command line is the exact retired
    # invocation of this script, root and lane is skipped; a confirmed dead
    # process is reclaimed in place; everything else fails closed. There is
    # no pathname read/decide/delete preflight anywhere.
    $legacyState = "reclaimable"
    $legacyFailureLogged = $false
    try {
      $existingContent = Read-LaneLockContentFromHandle -Stream $lockStream -Offset 0
      $legacyState = Get-LegacyLaneLockOwnerState `
        -Content $existingContent `
        -LaneKey $Lane `
        -CurrentProcessId $PID `
        -ExpectedScriptPath $PSCommandPath `
        -ExpectedInstallRoot $InstallRoot `
        -ExpectedLogDir $LogDir `
        -CanonicalHostPath (Get-LaneCanonicalPowerShellPath)
    } catch {
      $legacyState = "unverifiable:classification_failed"
      $legacyFailureLogged = $true
      Write-LaneLockUnavailable -Stage "legacy" -Exception (Get-LaneRootException $_)
    }

    if ($legacyState -eq "legacy_live") {
      Write-LaneLogBestEffort "already_running_legacy lane=$Lane lock=$LockPath no_restart=true"
      $exitCode = 0
    } elseif ($legacyState -ne "reclaimable") {
      if (-not $legacyFailureLogged) {
        Write-LaneLockUnavailable -Stage "legacy" -Exception $null -Type "UnverifiableLegacyOwner" -Message "the pre-existing legacy record could not be resolved to a confirmed dead process or a verified live retired wrapper ($legacyState)"
      }
      $exitCode = 1
    } else {
      try {
        # The lock is acquired and the prior content is reclaimable: this
        # launch now exclusively owns the lane. A failure writing its own
        # metadata or initializing its run log is this launch's own
        # failure, handled by the same catch as a lane failure below.
        $lockStream.SetLength(0)
        $sentinelAndContent = [byte[]]@(0) + [System.Text.Encoding]::ASCII.GetBytes($lockContent)
        $lockStream.Write($sentinelAndContent, 0, $sentinelAndContent.Length)
        $lockStream.Flush()

        Set-Content `
          -LiteralPath $runLog `
          -Value "DOWNSTREAM_LANE_START pid=$PID lane=$Lane started=$(Get-Date -Format o) timeout_minutes=$TimeoutMinutes time_budget_ms=$timeBudgetMs" `
          -Encoding UTF8

        $process = Start-Process `
          -FilePath $nodePath `
          -ArgumentList @(
            "`"$LaneScript`"",
            "--env=.env.worker.local",
            "--lane=$Lane",
            "--time-budget-ms=$timeBudgetMs"
          ) `
          -WorkingDirectory $AppDir `
          -RedirectStandardOutput $stdoutPath `
          -RedirectStandardError $stderrPath `
          -WindowStyle Hidden `
          -PassThru

        # PowerShell can lose access to ExitCode after an asynchronously-started
        # process closes unless its native handle was materialized while it was
        # alive. Hold the handle so Task Scheduler receives the real lane result.
        $processHandle = $process.Handle

        $completed = $process.WaitForExit($TimeoutMinutes * 60 * 1000)
        if (-not $completed) {
          Add-Content -LiteralPath $runLog -Value "DOWNSTREAM_LANE_TIMEOUT lane=$Lane pid=$($process.Id)" -Encoding UTF8
          $taskkill = Get-Command taskkill.exe -ErrorAction SilentlyContinue
          if ($taskkill) {
            & $taskkill.Source /PID $process.Id /T /F 2>&1 | ForEach-Object {
              Add-Content -LiteralPath $runLog -Value ("TASKKILL {0}" -f [string]$_) -Encoding UTF8
            }
          } else {
            Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
          }
          if (-not $process.WaitForExit(10000)) {
            Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
            $process.WaitForExit(5000) | Out-Null
          }
          $exitCode = 124
        } else {
          $process.WaitForExit()
          $process.Refresh()
          $exitCode = [int]$process.ExitCode
        }

        Append-OutputFile -Path $stdoutPath -RunLog $runLog -Stream "STDOUT"
        Append-OutputFile -Path $stderrPath -RunLog $runLog -Stream "STDERR"
        Add-Content `
          -LiteralPath $runLog `
          -Value "DOWNSTREAM_LANE_EXIT lane=$Lane exit_code=$exitCode finished=$(Get-Date -Format o)" `
          -Encoding UTF8
        Write-LaneLog "finished lane=$Lane exit_code=$exitCode run_log=$runLog"
      } catch {
        $primaryFailure = $_
        if ($process -and -not $process.HasExited) {
          $taskkill = Get-Command taskkill.exe -ErrorAction SilentlyContinue
          if ($taskkill) {
            & $taskkill.Source /PID $process.Id /T /F 2>&1 | ForEach-Object {
              Add-Content -LiteralPath $runLog -Value ("TASKKILL {0}" -f [string]$_) -Encoding UTF8
            }
          }
          Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
        }
        try {
          Add-Content `
            -LiteralPath $runLog `
            -Value "DOWNSTREAM_LANE_FAILED lane=$Lane message=$($primaryFailure.Exception.Message) finished=$(Get-Date -Format o)" `
            -Encoding UTF8
        } catch {
        }
        Write-LaneLogBestEffort "failed lane=$Lane message=$($primaryFailure.Exception.Message) run_log=$runLog"
        $exitCode = 1
      } finally {
        # Work cleanup still runs under the lane lock; the lock file itself
        # is deliberately not among the removed paths.
        Remove-Item -LiteralPath $stdoutPath -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $stderrPath -Force -ErrorAction SilentlyContinue
        try {
          Invoke-DownstreamLogRetention
        } catch {
          Write-Warning "Downstream log retention could not complete safely: $($_.Exception.Message)"
        }
      }
    }
  }
} finally {
  # Releasing the byte lock and releasing the handle are two independent
  # obligations, each attempted regardless of the other and neither allowed
  # to throw out of this finally (which would replace whatever failure is
  # already in flight). The lock file stays in place: no pathname-based
  # removal follows, so a replacement that appears after release can never
  # be touched by this launch.
  if ($lockStream) {
    if ($lockAcquired) {
      try { $lockStream.Unlock(0, 1) } catch { $unlockFailure = $_ }
    }
    try { $lockStream.Dispose() } catch { $disposeFailure = $_ }
  }
}

if ($unlockFailure -or $disposeFailure) {
  # A primary lane result always outranks a release failure; but a run that
  # would otherwise report success must not, because a byte lock that never
  # released or a handle that never closed is a real failure of this launch.
  $unlockMessage = if ($unlockFailure) { [string]$unlockFailure.Exception.Message } else { "" }
  $disposeMessage = if ($disposeFailure) { [string]$disposeFailure.Exception.Message } else { "" }
  Write-LaneLogBestEffort "lock_release_failed lane=$Lane lock=$LockPath exit_code=$exitCode unlock_error=$unlockMessage dispose_error=$disposeMessage"
  if ($exitCode -eq 0) {
    $exitCode = 1
  }
}

exit $exitCode
