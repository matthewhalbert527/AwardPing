import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const installer = readFileSync(
  resolve(root, "installer", "windows", "Install-AwardPingWorker.ps1"),
  "utf8",
);
const downstreamPath = resolve(
  root,
  "installer",
  "windows",
  "Run-AwardPingDownstreamLane.ps1",
);
const downstream = readFileSync(downstreamPath, "utf8");
const downstreamLaneRunner = readFileSync(
  resolve(root, "scripts", "run-downstream-lane.mjs"),
  "utf8",
);
const startupSupervisorPath = resolve(
  root,
  "installer",
  "windows",
  "Start-AwardPingOnBoot.ps1",
);
const sourceIntakeWorker = readFileSync(
  resolve(root, "scripts", "process-source-intake-requests.mjs"),
  "utf8",
);
const overnightInstaller = readFileSync(
  resolve(
    root,
    "installer",
    "windows",
    "Install-AwardPingOvernightSourceQuality.ps1",
  ),
  "utf8",
);
const baselineCompletionWatchdogPath = resolve(
  root,
  "installer",
  "windows",
  "Watch-AwardPingBaselineCompletion.ps1",
);
const baselineFactsWatchdogPath = resolve(
  root,
  "installer",
  "windows",
  "Watch-AwardPingBaselineFacts.ps1",
);
const baselineCompletionWatchdog = readFileSync(baselineCompletionWatchdogPath, "utf8");
const baselineFactsWatchdog = readFileSync(baselineFactsWatchdogPath, "utf8");
const baselineFactsRunnerPath = resolve(
  root,
  "installer",
  "windows",
  "Run-AwardPingBaselineFacts.ps1",
);
const sourceQualityRunnerPath = resolve(
  root,
  "installer",
  "windows",
  "Run-AwardPingOvernightSourceQuality.ps1",
);
const baselineFactsRunner = readFileSync(baselineFactsRunnerPath, "utf8");
const sourceQualityRunner = readFileSync(sourceQualityRunnerPath, "utf8");
const overnightInstallerPath = resolve(
  root,
  "installer",
  "windows",
  "Install-AwardPingOvernightSourceQuality.ps1",
);
const installerDocs = readFileSync(
  resolve(root, "docs", "local-pc-worker-installer.md"),
  "utf8",
);
const maintenanceRunner = readFileSync(
  resolve(root, "scripts", "run-awardping-maintenance.mjs"),
  "utf8",
);
const captureWorker = readFileSync(
  resolve(root, "scripts", "capture-visual-snapshots.mjs"),
  "utf8",
);
const nightlyReporter = readFileSync(
  resolve(root, "scripts", "report-visual-nightly.mjs"),
  "utf8",
);

function extractPowerShellFunction(source, name, nextName) {
  const start = source.indexOf(`function ${name} {`);
  const end = source.indexOf(`\nfunction ${nextName} {`, start);
  if (start < 0 || end < 0) throw new Error(`Could not extract ${name}`);
  return source.slice(start, end);
}

function runPowerShell(script) {
  return spawnSync("powershell.exe", ["-NoProfile", "-Command", "-"], {
    input: script,
    encoding: "utf8",
  });
}

function runPowerShellCommand(script) {
  return spawnSync("powershell.exe", ["-NoProfile", "-Command", script], {
    encoding: "utf8",
  });
}

describe("Windows worker update safety", () => {
  it("builds a complete staged app before quiescing and switches only after npm succeeds", () => {
    const stagedCopyIndex = installer.indexOf(
      "Copy-AppFiles -SourceRoot $sourceRoot -AppDir $stagingAppDir",
    );
    const stagedDependencyIndex = installer.indexOf(
      "Install-Dependencies -AppDir $stagingAppDir",
      stagedCopyIndex,
    );
    const suspendIndex = installer.indexOf("Suspend-AwardPingTasksForUpdate -Snapshots");
    const mutableStateIndex = installer.indexOf(
      "Copy-AwardPingMutableAppState -CurrentAppDir",
      suspendIndex,
    );
    const switchIndex = installer.indexOf("Switch-ToStagedAwardPingApp", mutableStateIndex);
    const finallyIndex = installer.indexOf("} finally {", switchIndex);
    const restoreIndex = installer.indexOf("Restore-AwardPingTasksAfterUpdate", finallyIndex);

    expect(stagedCopyIndex).toBeGreaterThan(0);
    expect(stagedDependencyIndex).toBeGreaterThan(stagedCopyIndex);
    const finalRevisionCheckIndex = installer.indexOf(
      "Get-AwardPingSourceRevision -SourceRoot $sourceRoot",
      stagedDependencyIndex,
    );
    expect(suspendIndex).toBeGreaterThan(stagedDependencyIndex);
    expect(finalRevisionCheckIndex).toBeGreaterThan(stagedDependencyIndex);
    expect(finalRevisionCheckIndex).toBeLessThan(suspendIndex);
    const freshCopyIndex = installer.indexOf(
      "Copy-AppFiles -SourceRoot $sourceRoot -AppDir $appDir",
      stagedCopyIndex + 1,
    );
    const freshDependencyIndex = installer.indexOf(
      "Install-Dependencies -AppDir $appDir",
      freshCopyIndex,
    );
    const freshRevisionCheckIndex = installer.indexOf(
      "Get-AwardPingSourceRevision -SourceRoot $sourceRoot",
      freshDependencyIndex,
    );
    const launcherWriteIndex = installer.indexOf(
      "Write-UninstallScript -InstallRoot $InstallRoot",
      freshDependencyIndex,
    );
    expect(freshCopyIndex).toBeGreaterThan(stagedCopyIndex);
    expect(freshDependencyIndex).toBeGreaterThan(freshCopyIndex);
    expect(freshRevisionCheckIndex).toBeGreaterThan(freshDependencyIndex);
    expect(freshRevisionCheckIndex).toBeLessThan(launcherWriteIndex);
    expect(mutableStateIndex).toBeGreaterThan(suspendIndex);
    expect(switchIndex).toBeGreaterThan(mutableStateIndex);
    expect(finallyIndex).toBeGreaterThan(switchIndex);
    expect(restoreIndex).toBeGreaterThan(finallyIndex);
    expect(installer).toContain("Move-Item -LiteralPath $CurrentAppDir -Destination $BackupAppDir");
    expect(installer).toContain("Move-Item -LiteralPath $StagingAppDir -Destination $CurrentAppDir");
    expect(installer).toContain("Push-Location -LiteralPath $AppDir");
    expect(installer).toContain("Pop-Location");
  });

  it("hardens a fresh secret file before dependency install or task registration", () => {
    const writeEnv = extractPowerShellFunction(
      installer,
      "Write-EnvFile",
      "Update-ExistingEnvFileDefaults",
    );
    const writeContent = writeEnv.indexOf(
      "Set-Content -Path $Path -Value $content -Encoding UTF8",
    );
    const immediateAcl = writeEnv.indexOf(
      "Set-AwardPingWorkerEnvFileAcl -Path $Path -TaskSnapshots @()",
    );
    expect(writeContent).toBeGreaterThan(0);
    expect(immediateAcl).toBeGreaterThan(writeContent);

    const mainTry = installer.indexOf(
      "\ntry {",
      installer.indexOf("$strictRetirementCommitted = $false"),
    );
    const freshInstallStart = installer.indexOf("  } else {", mainTry);
    const writeCall = installer.indexOf("Write-EnvFile `", freshInstallStart);
    const dependencyInstall = installer.indexOf(
      "Install-Dependencies -AppDir $appDir",
      writeCall,
    );
    const taskRegistration = installer.indexOf(
      "Register-VisualSnapshotTask -InstallRoot",
      writeCall,
    );
    expect(writeCall).toBeGreaterThan(freshInstallStart);
    expect(dependencyInstall).toBeGreaterThan(writeCall);
    expect(taskRegistration).toBeGreaterThan(dependencyInstall);
    expect(installer).toMatch(
      /-Path \$envPath `\r?\n\s+-TaskSnapshots \$finalizationSnapshots/,
    );
  });

  it("restores exact task XML on failure and enforces canonical triggers on success", () => {
    expect(installer).toContain("Export-ScheduledTask");
    expect(installer).toContain("Register-ScheduledTask");
    expect(installer).toContain("WasEnabled");
    expect(installer).toContain("WasRunning");
    expect(installer).toContain("Invoke-AwardPingTaskSetRollback");
    expect(installer).toContain("-RestoreRetiredTasks $true");
    expect(installer).toContain("Remove-NewAwardPingTasksAfterFailedUpdate");
    expect(installer).toContain("Get-AwardPingTaskSnapshotsForFinalization");
    expect(installer).toContain("-and $taskSnapshotCaptured");
    expect(installer).toContain('/task:Task/task:Principals');
    const restoreXml = extractPowerShellFunction(
      installer,
      "Get-AwardPingTaskRestoreXml",
      "Restore-AwardPingTasksAfterUpdate",
    );
    expect(restoreXml).not.toContain('/task:Task/task:Triggers');
    expect(restoreXml).toMatch(/freshly\s*\n\s*# registered canonical triggers/);
    expect(installer).toContain("[xml]$document = $Snapshot.Xml");
    expect(installer).toContain("restored in a disabled state because runtime validation failed");
    expect(installer).toContain("Startup-launcher restoration failed; all AwardPing tasks were left disabled");
    const startupRollbackFailureIndex = installer.indexOf(
      "Startup-launcher restoration failed; all AwardPing tasks were left disabled",
    );
    const startupFailClosedIndex = installer.lastIndexOf(
      "Disable-AwardPingTasksForInstallRoot -InstallRoot $InstallRoot",
      startupRollbackFailureIndex,
    );
    expect(startupFailClosedIndex).toBeGreaterThan(0);
    expect(startupFailClosedIndex).toBeLessThan(startupRollbackFailureIndex);

    const registrationIndex = installer.indexOf("Register-VisualSnapshotTask -InstallRoot");
    const retirementIndex = installer.indexOf(
      "Remove-LegacySourceTask -InstallRoot",
      registrationIndex,
    );
    expect(retirementIndex).toBeGreaterThan(registrationIndex);
  });

  const windowsIt = (name, test, timeout = 20_000) =>
    (process.platform === "win32" ? it : it.skip)(name, test, timeout);

  // Copy-AppFiles is the only place the installer copies the checked-out
  // repository into a staged or installed app tree. The repository-root
  // .claude directory holds local agent configuration and nested worktree
  // copies of the whole repository, so both copy paths (robocopy /XD and the
  // PowerShell fallback) must leave it behind.
  const copyAppFilesFunction = () =>
    extractPowerShellFunction(installer, "Copy-AppFiles", "Copy-AwardPingMutableAppState");

  function quotedNames(text) {
    return [...text.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  }

  function textBetween(text, start, end) {
    const from = text.indexOf(start);
    expect(from, `missing "${start}"`).toBeGreaterThanOrEqual(0);
    const to = text.indexOf(end, from + start.length);
    expect(to, `missing "${end}" after "${start}"`).toBeGreaterThan(from);
    return text.slice(from + start.length, to);
  }

  // The PowerShell fallback begins at its literal-path directory listing. A
  // legal source root or file name may contain [ ] wildcard characters, so
  // the fallback must read and copy through -LiteralPath, never -Path.
  const FALLBACK_LISTING = "Get-ChildItem -LiteralPath $SourceRoot";

  function fallbackStartOf(copyAppFiles) {
    const start = copyAppFiles.indexOf(FALLBACK_LISTING);
    expect(start, `fallback anchor ${FALLBACK_LISTING}`).toBeGreaterThan(0);
    return start;
  }

  it("lists and copies fallback sources through -LiteralPath only", () => {
    const copyAppFiles = copyAppFilesFunction();
    const fallbackSection = copyAppFiles.slice(fallbackStartOf(copyAppFiles));
    expect(fallbackSection).toContain(`${FALLBACK_LISTING} -Force`);
    expect(fallbackSection).toContain("Copy-Item -LiteralPath $_.FullName -Destination $AppDir -Recurse -Force");
    expect(fallbackSection).not.toMatch(/Get-ChildItem\s+-Path\b/);
    expect(fallbackSection).not.toMatch(/Copy-Item\s+-Path\b/);
  });

  it("excludes the repository-root .claude directory from both Copy-AppFiles copy paths", () => {
    const copyAppFiles = copyAppFilesFunction();
    const fallbackStart = fallbackStartOf(copyAppFiles);
    const robocopySection = copyAppFiles.slice(0, fallbackStart);
    const fallbackSection = copyAppFiles.slice(fallbackStart);

    const robocopyExcludedDirectories = quotedNames(
      textBetween(robocopySection, '"/XD",', '"/XF",'),
    );
    const fallbackExcludedDirectories = quotedNames(
      textBetween(fallbackSection, "$_.Name -notin @(", ")"),
    );

    expect(robocopyExcludedDirectories).toContain(".claude");
    expect(fallbackExcludedDirectories).toContain(".claude");
    // The two copy paths must exclude exactly the same directory names.
    expect([...fallbackExcludedDirectories].sort()).toEqual(
      [...robocopyExcludedDirectories].sort(),
    );
  });

  // Exercises only the extracted Copy-AppFiles against a disposable temp
  // directory created here: never a real install root, never Task Scheduler.
  // The multi-line try/finally needs -File; stdin -Command mode drops it.
  // `shadowRobocopy` resolves Get-CommandPath to the real system Robocopy path
  // while defining a PowerShell function named `robocopy` that records and
  // throws, so a bare `& robocopy` would hit the shadow and only the resolved
  // executable path copies anything.
  // `bracketFixture` names the source directory and one top-level file with
  // [ ] characters, which -Path would read as wildcards. Fixture paths are
  // created through literal-safe .NET APIs so only Copy-AppFiles is exercised.
  function runCopyAppFilesSimulation({
    forceFallback,
    shadowRobocopy = false,
    bracketFixture = false,
  }) {
    const directory = mkdtempSync(join(tmpdir(), "awardping-copy-appfiles-"));
    const simulation = [
      "$ErrorActionPreference = 'Stop'",
      "function Write-Step { param([string]$Message) }",
      "$script:shadowInvoked = $false",
      forceFallback
        ? "function Get-CommandPath { param([string]$Command); return $null }"
        : shadowRobocopy
          ? "function Get-CommandPath { param([string]$Command); return [System.IO.Path]::Combine($env:SystemRoot, 'System32', 'robocopy.exe') }"
          : extractPowerShellFunction(installer, "Get-CommandPath", "Ensure-Node"),
      shadowRobocopy
        ? "function robocopy { $script:shadowInvoked = $true; throw 'shadow robocopy command was invoked' }"
        : "",
      copyAppFilesFunction(),
      `$root = Join-Path '${directory.replace(/'/g, "''")}' 'fixture'`,
      bracketFixture
        ? "$source = Join-Path $root 'source [beta]'"
        : "$source = Join-Path $root 'source'",
      "$target = Join-Path $root 'app'",
      "$copyError = ''",
      "try {",
      "  [void][System.IO.Directory]::CreateDirectory((Join-Path $source 'src/lib'))",
      "  [void][System.IO.Directory]::CreateDirectory((Join-Path $source '.claude/worktrees/example'))",
      "  [System.IO.File]::WriteAllText((Join-Path $source 'package.json'), '{\"name\":\"fixture\"}')",
      "  [System.IO.File]::WriteAllText((Join-Path $source 'src/lib/nested.txt'), 'ordinary app file')",
      "  [System.IO.File]::WriteAllText((Join-Path $source '.claude/settings.local.json'), '{\"permissions\":{}}')",
      "  [System.IO.File]::WriteAllText((Join-Path $source '.claude/worktrees/example/marker.txt'), 'nested worktree copy')",
      bracketFixture
        ? "  [System.IO.File]::WriteAllText((Join-Path $source 'notes [draft].txt'), 'bracketed top-level file')"
        : "",
      "  try { Copy-AppFiles -SourceRoot $source -AppDir $target } catch { $copyError = $_.Exception.Message }",
      "  'COPY_ERROR=' + $copyError",
      "  'SHADOW_INVOKED=' + $script:shadowInvoked",
      "  'USED_ROBOCOPY=' + [bool](Get-CommandPath 'robocopy.exe')",
      "  'NESTED=' + (Test-Path -LiteralPath (Join-Path $target 'src/lib/nested.txt'))",
      "  'PACKAGE=' + (Test-Path -LiteralPath (Join-Path $target 'package.json'))",
      "  'BRACKET_FILE=' + (Test-Path -LiteralPath (Join-Path $target 'notes [draft].txt'))",
      "  'CLAUDE_DIR=' + (Test-Path -LiteralPath (Join-Path $target '.claude'))",
      "  'CLAUDE_SENTINEL=' + (Test-Path -LiteralPath (Join-Path $target '.claude/settings.local.json'))",
      "} finally {",
      "  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue",
      "}",
    ].join("\n");
    const scriptPath = join(directory, "copy-appfiles.ps1");
    writeFileSync(scriptPath, simulation, "utf8");
    try {
      return spawnSync(
        "powershell.exe",
        ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
        { encoding: "utf8" },
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }

  it("invokes the resolved Robocopy executable path rather than a bare command name", () => {
    const copyAppFiles = copyAppFilesFunction();
    const robocopySection = copyAppFiles.slice(0, fallbackStartOf(copyAppFiles));
    expect(robocopySection).toContain('$robocopy = Get-CommandPath "robocopy.exe"');
    expect(robocopySection).toContain("& $robocopy @args");
    expect(robocopySection).not.toMatch(/&\s+robocopy\b/);
  });

  windowsIt("copies nested app files but not the root .claude directory through the PowerShell fallback", () => {
    const result = runCopyAppFilesSimulation({ forceFallback: true });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("COPY_ERROR=\r\n");
    expect(result.stdout).toContain("USED_ROBOCOPY=False");
    expect(result.stdout).toContain("NESTED=True");
    expect(result.stdout).toContain("PACKAGE=True");
    expect(result.stdout).toContain("CLAUDE_DIR=False");
    expect(result.stdout).toContain("CLAUDE_SENTINEL=False");
  });

  const robocopyAvailable =
    process.platform === "win32" &&
    existsSync(join(process.env.SystemRoot || "C:/Windows", "System32", "robocopy.exe"));
  (robocopyAvailable ? it : it.skip)(
    "copies nested app files but not the root .claude directory through robocopy",
    () => {
      const result = runCopyAppFilesSimulation({ forceFallback: false });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("COPY_ERROR=\r\n");
      expect(result.stdout).toContain("USED_ROBOCOPY=True");
      expect(result.stdout).toContain("NESTED=True");
      expect(result.stdout).toContain("PACKAGE=True");
      expect(result.stdout).toContain("CLAUDE_DIR=False");
      expect(result.stdout).toContain("CLAUDE_SENTINEL=False");
    },
    20_000,
  );

  (robocopyAvailable ? it : it.skip)(
    "copies through the resolved Robocopy path even when a robocopy command is shadowed",
    () => {
      const result = runCopyAppFilesSimulation({ forceFallback: false, shadowRobocopy: true });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("COPY_ERROR=\r\n");
      expect(result.stdout).toContain("SHADOW_INVOKED=False");
      expect(result.stdout).toContain("USED_ROBOCOPY=True");
      expect(result.stdout).toContain("NESTED=True");
      expect(result.stdout).toContain("PACKAGE=True");
      expect(result.stdout).toContain("CLAUDE_DIR=False");
    },
    20_000,
  );

  windowsIt("copies a bracketed source root and bracketed file literally through the PowerShell fallback", () => {
    const result = runCopyAppFilesSimulation({ forceFallback: true, bracketFixture: true });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("COPY_ERROR=\r\n");
    expect(result.stdout).toContain("USED_ROBOCOPY=False");
    expect(result.stdout).toContain("NESTED=True");
    expect(result.stdout).toContain("PACKAGE=True");
    expect(result.stdout).toContain("BRACKET_FILE=True");
    expect(result.stdout).toContain("CLAUDE_DIR=False");
    expect(result.stdout).toContain("CLAUDE_SENTINEL=False");
  });

  it("generates an uninstaller that unregisters only owned allowlisted tasks by exact name and path", () => {
    const writer = extractPowerShellFunction(installer, "Write-UninstallScript", "Write-LauncherScripts");
    expect(writer).toContain("$installRoot = Split-Path -Parent $PSCommandPath");
    expect(writer).toContain("Get-ScheduledTask -ErrorAction Stop");
    expect(writer).toContain("[string]$_.TaskName -in $taskNames");
    expect(writer).toContain("Test-UninstallTaskTargetsInstallRoot -Task $_ -InstallRoot $installRoot");
    expect(writer).toContain("Unregister-ScheduledTask -TaskName $task.TaskName -TaskPath $taskPath");
    expect(writer).not.toMatch(/Unregister-ScheduledTask -TaskName `?\$taskName\b/);
  });

  // Generates the uninstaller into a disposable install root with the extracted
  // Write-UninstallScript, then runs the generated script in a PowerShell
  // process whose Get-ScheduledTask and Unregister-ScheduledTask are shadow
  // functions. No real scheduled task is ever read or removed.
  function runUninstallScriptSimulation() {
    const directory = mkdtempSync(join(tmpdir(), "awardping-uninstall-script-"));
    const simulation = [
      "$ErrorActionPreference = 'Stop'",
      extractPowerShellFunction(installer, "Write-UninstallScript", "Write-LauncherScripts"),
      `$root = Join-Path '${directory.replace(/'/g, "''")}' 'install'`,
      "[void][System.IO.Directory]::CreateDirectory($root)",
      "Write-UninstallScript -InstallRoot $root",
      "$generated = Join-Path $root 'Uninstall-AwardPingWorker.ps1'",
      "'GENERATED=' + (Test-Path -LiteralPath $generated)",
      "$global:uninstallRemoved = @()",
      "function Get-ScheduledTask {",
      "  param($TaskName, $TaskPath, $ErrorAction)",
      "  $owned = '-NoProfile -File \"' + $root + '\\Run-AwardPingVisualSnapshots.ps1\"'",
      "  $foreign = '-NoProfile -File \"D:\\OtherAwardPing\\Run-AwardPingVisualSnapshots.ps1\"'",
      "  @(",
      "    [pscustomobject]@{ TaskName='AwardPing Local Source Worker'; TaskPath='\\'; Actions=@([pscustomobject]@{ Execute='powershell.exe'; Arguments=$owned }) },",
      "    [pscustomobject]@{ TaskName='AwardPing Local Source Worker'; TaskPath='\\Other\\'; Actions=@([pscustomobject]@{ Execute='powershell.exe'; Arguments=$foreign }) },",
      "    [pscustomobject]@{ TaskName='AwardPing Concurrent Custom Audit'; TaskPath='\\'; Actions=@([pscustomobject]@{ Execute='powershell.exe'; Arguments=$owned }) },",
      "    [pscustomobject]@{ TaskName='AwardPing Nightly Report Lane'; TaskPath='\\AwardPing\\'; Actions=@([pscustomobject]@{ Execute='powershell.exe'; Arguments=$owned }) }",
      "  )",
      "}",
      "function Unregister-ScheduledTask { param($TaskName, $TaskPath, $Confirm, $ErrorAction); $global:uninstallRemoved += ([string]$TaskPath + '|' + [string]$TaskName) }",
      "& $generated",
      "'REMOVED=' + ($global:uninstallRemoved -join ';')",
    ].join("\n");
    const scriptPath = join(directory, "uninstall-simulation.ps1");
    writeFileSync(scriptPath, simulation, "utf8");
    try {
      return spawnSync(
        "powershell.exe",
        ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
        { encoding: "utf8" },
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }

  windowsIt("generated uninstaller removes only its own allowlisted tasks by exact name and path", () => {
    const result = runUninstallScriptSimulation();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("GENERATED=True");
    expect(result.stdout).toContain(
      "REMOVED=\\|AwardPing Local Source Worker;\\AwardPing\\|AwardPing Nightly Report Lane\r\n",
    );
    expect(result.stdout).not.toContain("\\Other\\|");
    expect(result.stdout).not.toContain("Concurrent Custom Audit");
  });

  it("claims the generated visual worker lock with a single-pass byte-range lock, tying contention and metadata evidence to one file handle", () => {
    const launcher = extractPowerShellFunction(installer, "Write-LauncherScripts", "Install-Dependencies");

    // The persistent-lock design (a single broad write-exclusive open as
    // the sole signal) is gone: it let a foreign holder's mere conflict
    // with our own open be answered by a SEPARATELY read, stale content
    // probe. There is no more retry loop, no more Retry/Stale state, and
    // no more removal step.
    expect(launcher).not.toContain("function Get-VisualLockContentionStatus");
    expect(launcher).not.toContain("`$maxClaimAttempts");
    expect(launcher).not.toContain("`$claimAttempt");
    expect(launcher).not.toMatch(/while \(`\$true\)/);
    expect(launcher).not.toContain('"Retry"');
    expect(launcher).not.toContain('"Stale"');

    const claimIndex = launcher.indexOf("[System.IO.FileMode]::OpenOrCreate");
    const invokeIndex = launcher.indexOf("& `$nodePath @workerArgs");
    expect(claimIndex).toBeGreaterThan(0);
    expect(invokeIndex).toBeGreaterThan(claimIndex);

    // The open is deliberately broad (ReadWrite/ReadWrite) and compatible
    // with every cooperating participant - it is not itself the ownership
    // primitive, so a genuine conflict there (an unrelated, incompatible
    // holder) must never be answered by a separately read stale PID.
    expect(launcher).toContain("[System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::ReadWrite");
    const openCatchStart = launcher.indexOf("catch [System.IO.IOException] {", claimIndex);
    const openCatchEnd = launcher.indexOf("}", launcher.indexOf("failing closed instead of assuming it is safe to claim", openCatchStart));
    expect(openCatchStart).toBeGreaterThan(claimIndex);
    const openCatchBody = launcher.slice(openCatchStart, openCatchEnd);
    expect(openCatchBody).not.toContain("Get-Content");
    expect(openCatchBody).not.toContain("ActiveOwner");

    // The byte-range lock is the sole ownership primitive: exactly one
    // sentinel byte, contention code 33 alone (no 32/80/183 - those were
    // CreateNew/exclusive-open-specific and cannot occur for a Lock call),
    // no post-error Test-Path recheck.
    const lockCallIndex = launcher.indexOf("`$lockStream.Lock(0, 1)");
    expect(lockCallIndex).toBeGreaterThan(claimIndex);
    const lockCatchStart = launcher.indexOf("catch [System.IO.IOException] {", lockCallIndex);
    expect(lockCatchStart).toBeGreaterThan(lockCallIndex);
    const lockCatchEnd = launcher.indexOf("Recorded metadata:", lockCatchStart);
    const lockCatchBody = launcher.slice(lockCatchStart, lockCatchEnd);
    expect(lockCatchBody).toContain("-ne 33");
    expect(lockCatchBody).not.toMatch(/\(Test-Path[^)]*\)/);
    expect(lockCatchBody).not.toContain("32");
    expect(lockCatchBody).not.toContain("80");
    expect(lockCatchBody).not.toContain("183");

    // Metadata on lock failure is read via Read-VisualLockMetadataFromHandle
    // against the SAME already-open $lockStream - never a fresh pathname
    // reopen - purely for a richer diagnostic message. It is never treated
    // as sufficient proof of ownership: there is no "already running, skip"
    // path here at all - a same-handle content read cannot prove who
    // currently holds the byte-range lock (an unrelated holder could leave
    // genuinely stale, well-formed, live-PID-matching metadata behind
    // without ever touching it), so every genuine collision fails closed.
    expect(lockCatchBody).toContain("Read-VisualLockMetadataFromHandle -Stream `$lockStream");
    expect(lockCatchBody).toContain("Test-VisualLockOwnedByAwardPing -Content `$currentMetadata");
    // No actual code path here ever reports a benign skip - a comment may
    // legitimately discuss that removed behavior in prose, but there must
    // be no real Write-Host call announcing it, and no "exit 0" statement.
    expect(lockCatchBody).not.toMatch(/Write-Host "AwardPing visual snapshot worker is already running/);
    expect(lockCatchBody).not.toContain("exit 0");
    expect(lockCatchBody).toContain("try { `$lockStream.Dispose() } catch {}");
    expect(lockCatchBody).toContain("Cannot verify who holds the AwardPing visual worker lock");

    // The diagnostic read can genuinely fail (its metadata region may be
    // separately byte-range locked). Disposal therefore happens in a real
    // finally - not as a statement the read can jump past - and the read's
    // own failure only degrades the note, never replacing the fail-closed
    // collision error, which is thrown unconditionally afterwards.
    const diagnosticTryIndex = lockCatchBody.indexOf("try {", lockCatchBody.indexOf("-ne 33"));
    const diagnosticReadIndex = lockCatchBody.indexOf("Read-VisualLockMetadataFromHandle -Stream `$lockStream");
    const diagnosticFinallyIndex = lockCatchBody.indexOf("} finally {", diagnosticReadIndex);
    const diagnosticDisposeIndex = lockCatchBody.indexOf("try { `$lockStream.Dispose() } catch {}", diagnosticFinallyIndex);
    expect(diagnosticTryIndex).toBeGreaterThan(0);
    expect(diagnosticReadIndex).toBeGreaterThan(diagnosticTryIndex);
    expect(diagnosticFinallyIndex).toBeGreaterThan(diagnosticReadIndex);
    expect(diagnosticDisposeIndex).toBeGreaterThan(diagnosticFinallyIndex);
    // The throw is outside that try/finally, so it always runs.
    const failClosedThrowIndex = lockCatchBody.indexOf("throw [System.IO.IOException]::new(\"Cannot verify who holds");
    expect(failClosedThrowIndex).toBeGreaterThan(diagnosticDisposeIndex);

    // Content is written starting at offset 1 (byte 0 is a pure lock
    // sentinel, never data) in a SEPARATE try from the lock acquisition;
    // any failure disposes and rethrows the REAL failure - untyped catch,
    // and best-effort cleanup so Dispose() itself failing (it can, if the
    // same underlying I/O problem is still present) never replaces the
    // original, more informative error.
    const setLengthIndex = launcher.indexOf("`$lockStream.SetLength(0)", lockCatchStart);
    const writeIndex = launcher.indexOf("`$lockStream.Write(`$sentinelAndContent", setLengthIndex);
    const flushIndex = launcher.indexOf("`$lockStream.Flush()", writeIndex);
    expect(setLengthIndex).toBeGreaterThan(lockCatchStart);
    expect(writeIndex).toBeGreaterThan(setLengthIndex);
    expect(flushIndex).toBeGreaterThan(writeIndex);
    const writeCatchStart = launcher.indexOf("} catch {", flushIndex);
    const writeCatchEnd = launcher.indexOf("}", launcher.indexOf("throw `$writeFailure", writeCatchStart));
    const writeCatchBody = launcher.slice(writeCatchStart, writeCatchEnd);
    expect(writeCatchBody).toContain("`$writeFailure = `$_");
    expect(writeCatchBody).toContain("try { `$lockStream.Unlock(0, 1) } catch {}");
    expect(writeCatchBody).toContain("try { `$lockStream.Dispose() } catch {}");
    expect(writeCatchBody).toContain("throw `$writeFailure");
    expect(writeCatchBody).not.toContain("[System.IO.IOException]");
    expect(writeCatchBody).not.toContain("already running");

    // Identity-bound cleanup: the release still Unlocks and Disposes the
    // same handle, never a separate pathname-based removal.
    const cleanupIndex = launcher.indexOf("`$lockStream.Unlock(0, 1)", invokeIndex);
    expect(cleanupIndex).toBeGreaterThan(invokeIndex);
  });

  it("releases the owner's lock and handle in a real finally that can never mask a primary failure or the catch's own logging failure", () => {
    const launcher = extractPowerShellFunction(installer, "Write-LauncherScripts", "Install-Dependencies");
    const invokeIndex = launcher.indexOf("& `$nodePath @workerArgs");
    const exitCodeStatementIndex = launcher.indexOf("exit `$exitCode");
    expect(invokeIndex).toBeGreaterThan(0);
    expect(exitCodeStatementIndex).toBeGreaterThan(invokeIndex);
    const releaseSequence = launcher.slice(invokeIndex, exitCodeStatementIndex);

    // $primaryFailure is captured as the FIRST statement in the catch -
    // before any other statement, including the error-report logging.
    // Under $ErrorActionPreference = "Stop", a failure in that logging
    // (share-denied, full, or otherwise unavailable log) is itself a
    // terminating error; capturing $_ first means it is never lost even
    // if the logging attempt right after it fails.
    const catchStart = releaseSequence.indexOf("} catch {");
    const catchBodyEnd = releaseSequence.indexOf("} finally {", catchStart);
    expect(catchStart).toBeGreaterThan(0);
    expect(catchBodyEnd).toBeGreaterThan(catchStart);
    const catchBody = releaseSequence.slice(catchStart, catchBodyEnd);
    const firstStatement = catchBody
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0 && line !== "} catch {" && !line.startsWith("#"));
    expect(firstStatement).toBe("`$primaryFailure = `$_");

    // The error-report logging itself is best-effort: wrapped in its own
    // try/catch so it can never escape the outer catch and replace
    // $primaryFailure or skip the finally below.
    const loggingTryIndex = catchBody.indexOf("try {", catchBody.indexOf("`$primaryFailure = `$_"));
    const loggingAddContentIndex = catchBody.indexOf("Add-Content -Path `$logPath -Value \"VISUAL_WORKER_WRAPPER_ERROR");
    const loggingCatchIndex = catchBody.indexOf("} catch {", loggingAddContentIndex);
    expect(loggingTryIndex).toBeGreaterThan(0);
    expect(loggingAddContentIndex).toBeGreaterThan(loggingTryIndex);
    expect(loggingCatchIndex).toBeGreaterThan(loggingAddContentIndex);

    // Lock release lives in a REAL finally now, so it always runs - even
    // if the catch's own best-effort logging still somehow failed to
    // protect itself. Unlock and Dispose remain separate, independently
    // guarded attempts: sharing one unguarded finally meant an Unlock
    // failure threw straight out of it - replacing any exception already
    // in flight - and skipped Dispose() entirely, leaking the handle.
    const finallyBody = releaseSequence.slice(catchBodyEnd, releaseSequence.indexOf("\n\n# A genuine failure"));
    expect(finallyBody).toContain("try { `$lockStream.Unlock(0, 1) } catch { `$unlockFailure = `$_ }");
    expect(finallyBody).toContain("try { `$lockStream.Dispose() } catch { `$disposeFailure = `$_ }");
    // Neither cleanup attempt can throw OUT of this finally - each is
    // fully captured, never left to propagate on its own.
    expect(finallyBody).not.toMatch(/`\$lockStream\.Unlock\(0, 1\)\r?\n/);

    const primaryThrowIndex = releaseSequence.indexOf("throw `$primaryFailure");
    const unlockThrowIndex = releaseSequence.indexOf("throw `$unlockFailure");
    const disposeThrowIndex = releaseSequence.indexOf("throw `$disposeFailure");
    // All three throws happen AFTER the finally completes, and the
    // primary failure outranks both cleanup failures.
    expect(primaryThrowIndex).toBeGreaterThan(catchBodyEnd);
    expect(unlockThrowIndex).toBeGreaterThan(primaryThrowIndex);
    expect(disposeThrowIndex).toBeGreaterThan(unlockThrowIndex);

    // A cleanup failure with no primary failure is still reported, never
    // silently swallowed into a clean exit.
    expect(releaseSequence).not.toContain("Remove-Item");
  });

  it("requires the protocol marker for ownership, anchored parsing, and fixes the exact PowerShell exception types for missing-path compatibility", () => {
    const launcher = extractPowerShellFunction(installer, "Write-LauncherScripts", "Install-Dependencies");

    // Test-VisualLockOwnedByAwardPing is diagnostic-only (never gates a
    // skip) but still anchored to the START of the content, so it cannot
    // be tripped by the substring appearing elsewhere in unrelated text.
    expect(launcher).toContain('`$Content -notmatch "^protocol=2\\b"');
    expect(launcher).toContain('`$lockContent = "protocol=2 pid=`$PID');

    // The legacy check reads the file from byte 0. A NUL sentinel byte
    // there is written ONLY by the new protocol's claim - genuine,
    // corrupt, or partial - and must NEVER enter legacy pid= parsing:
    // requiring a well-formed "protocol=N" marker to follow the sentinel
    // (rather than excluding on the sentinel alone) would let corrupt or
    // partial new-protocol content that doesn't match fall through to the
    // legacy scan and be misread as legacy (reproduced empirically).
    const legacyFnStart = launcher.indexOf("function Test-LegacyMarkerlessVisualLockActive");
    const legacyFnEnd = launcher.indexOf("function Test-VisualLockOwnedByAwardPing");
    const legacyFnBody = launcher.slice(legacyFnStart, legacyFnEnd);
    expect(legacyFnBody).toContain("if (`$raw[0] -eq [char]0) {");
    expect(legacyFnBody).not.toMatch(/`\$raw\[0\] -eq \[char\]0 -and/);
    // The legacy pid= match itself is anchored to the exact start of the
    // content, matching only the real deployed 25dc124 shape - an
    // unanchored search could match "pid=" appearing anywhere in
    // garbage-prefixed or otherwise corrupted text and misread it as a
    // genuine legacy record (reproduced empirically).
    expect(legacyFnBody).toContain('`$match = [regex]::Match(`$raw, "^pid=(\\d+)\\b")');
    expect(legacyFnBody).not.toContain('[regex]::Match(`$raw, "pid=(\\d+)")');

    // The current launcher's own PID is never legacy-ownership evidence:
    // it is trivially live and trivially matches the command-line check,
    // so a stale record naming a PID the OS reused for this very process
    // would otherwise make the launch skip itself.
    expect(legacyFnBody).toContain("if (`$workerPid -eq `$PID) {");
    const selfPidIndex = legacyFnBody.indexOf("`$workerPid -eq `$PID");
    const cimQueryIndex = legacyFnBody.indexOf("Get-CimInstance Win32_Process");
    expect(selfPidIndex).toBeGreaterThan(0);
    expect(selfPidIndex).toBeLessThan(cimQueryIndex);

    // Get-Content raises System.Management.Automation.ItemNotFoundException
    // for a missing path (verified empirically, HResult 0x80131501, native
    // 5377) - not System.IO.FileNotFoundException - so the legacy
    // preflight's catch must use the real type, or a missing/vanished path
    // escapes uncaught instead of being treated as "not legacy-active."
    expect(legacyFnBody).toContain("catch [System.Management.Automation.ItemNotFoundException]");
    expect(legacyFnBody).not.toContain("System.IO.FileNotFoundException");
    // Get-Content -Raw returns $null (not "") for a zero-byte file -
    // verified empirically - and a static [regex]::Match call throws on a
    // null input, unlike the -match operator; the null/empty case must be
    // guarded before any [regex]::Match call.
    // The same guard also has to precede the sentinel check, which indexes
    // $raw[0] - that too would throw on a null/empty value.
    const nullGuardIndex = legacyFnBody.indexOf("[string]::IsNullOrEmpty(`$raw)");
    const sentinelCheckIndex = legacyFnBody.indexOf("`$raw[0] -eq [char]0");
    const regexMatchIndex = legacyFnBody.indexOf("[regex]::Match(`$raw");
    expect(nullGuardIndex).toBeGreaterThan(0);
    expect(sentinelCheckIndex).toBeGreaterThan(0);
    expect(nullGuardIndex).toBeLessThan(sentinelCheckIndex);
    expect(nullGuardIndex).toBeLessThan(regexMatchIndex);
    expect(sentinelCheckIndex).toBeLessThan(regexMatchIndex);
  });

  function visualStatusScriptSourceText() {
    const start = installer.indexOf('`$LockPath = Join-Path `$InstallRoot "visual-worker.lock"');
    const end = installer.indexOf("`$latestLog = Get-ChildItem", start);
    expect(start, "status script lock probe").toBeGreaterThan(0);
    expect(end, "end of status script lock probe").toBeGreaterThan(start);
    return installer.slice(start, end);
  }

  it("never attempts to acquire the byte-range lock from the status script, and labels recorded metadata honestly rather than as a proven current lock", () => {
    const probeSource = visualStatusScriptSourceText();
    // Status inspection must be non-interfering: it never calls Lock() at
    // all, so it can never itself become a transient, unrelated byte-0
    // holder colliding with a genuine claimant. Reads via a plain,
    // non-locking open instead.
    expect(probeSource).not.toContain(".Lock(");
    expect(probeSource).not.toContain(".Unlock(");
    expect(probeSource).not.toContain("`$lockHeld");
    expect(probeSource).toContain("[System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite");
    // Reads from offset 1 (never byte 0, the sentinel).
    expect(probeSource).toContain("`$statusProbe.Seek(1, [System.IO.SeekOrigin]::Begin)");
    // A Seek/Read failure after a successful open used to jump straight to
    // the catch, skipping Dispose() and leaking the handle until GC. The
    // probe handle is disposed in a real finally, guarded for the case
    // where the open itself is what failed.
    const probeOpenIndex = probeSource.indexOf("`$statusProbe = [System.IO.FileStream]::new(");
    const probeFinallyIndex = probeSource.indexOf("} finally {", probeOpenIndex);
    const probeDisposeIndex = probeSource.indexOf("`$statusProbe.Dispose()", probeFinallyIndex);
    expect(probeOpenIndex).toBeGreaterThan(0);
    expect(probeFinallyIndex).toBeGreaterThan(probeOpenIndex);
    expect(probeDisposeIndex).toBeGreaterThan(probeFinallyIndex);
    expect(probeSource).toContain("if (`$statusProbe) { try { `$statusProbe.Dispose() } catch {} }");
    // Initialized to $null before the try so the finally can tell "never
    // opened" from "opened then failed".
    const probeNullInitIndex = probeSource.indexOf("`$statusProbe = `$null");
    expect(probeNullInitIndex).toBeGreaterThan(0);
    expect(probeNullInitIndex).toBeLessThan(probeOpenIndex);
    // "Running" comes solely from the independent CIM process scan, never
    // from anything derived from the lock file.
    expect(probeSource).toContain("`$running = Get-CimInstance Win32_Process");

    const installer_ = extractPowerShellFunction(installer, "Write-LauncherScripts", "Install-Dependencies");
    const labelStart = installer_.indexOf('if (`$lockText) {');
    const labelEnd = installer_.indexOf("Write-Host \"\"", labelStart);
    expect(labelStart).toBeGreaterThan(0);
    const labelBody = installer_.slice(labelStart, labelEnd);
    // Never asserts a proven "Lock:" label - only ever presents recorded
    // metadata as historical, since the status script has no safe way to
    // prove it reflects a currently held lock without itself becoming a
    // protocol participant.
    expect(labelBody).toContain('Write-Host "Last recorded lock metadata: `$(`$lockText.Trim())"');
    expect(labelBody).not.toMatch(/Write-Host "Lock: /);
  });

  // Generates the real visual wrapper AND status script via the extracted
  // Write-LauncherScripts into a disposable install root, then extracts
  // the lock-helper functions, claim statements, the status script's
  // byte-lock probe, and the COMPLETE production owner section (the real
  // "$exitCode = 1; try { ... } catch { ... } finally { ... }" that
  // follows the claim) for direct execution against real, disposable temp
  // lock paths. Never reaches worker, node, Task Scheduler, or a real
  // installer entrypoint.
  function visualLockSnippets(installRoot) {
    const launcherFunctions = extractPowerShellFunction(installer, "Write-LauncherScripts", "Install-Dependencies");
    const generateResult = runPowerShell(
      [launcherFunctions, `Write-LauncherScripts -InstallRoot '${installRoot.replace(/'/g, "''")}'`].join("\n"),
    );
    if (generateResult.status !== 0) {
      throw new Error(`Write-LauncherScripts failed: ${generateResult.stderr}`);
    }
    const visualRunContent = readFileSync(join(installRoot, "Run-AwardPingVisualSnapshots.ps1"), "utf8");
    const statusScriptContent = readFileSync(join(installRoot, "Show-AwardPingVisualStatus.ps1"), "utf8");

    function slice(startAnchor, endAnchor, inclusive = false) {
      const start = visualRunContent.indexOf(startAnchor);
      const end = visualRunContent.indexOf(endAnchor, start);
      if (start < 0 || end < 0) {
        throw new Error(`Could not locate "${startAnchor}" .. "${endAnchor}" in the generated wrapper.`);
      }
      return visualRunContent.slice(start, inclusive ? end + endAnchor.length : end);
    }

    const functionsStart = visualRunContent.indexOf("function Test-LegacyMarkerlessVisualLockActive {");
    const functionsEnd = visualRunContent.indexOf("\n$stamp = Get-Date", functionsStart);
    if (functionsStart < 0 || functionsEnd < 0) {
      throw new Error("Could not locate the visual lock helper functions in the generated wrapper.");
    }

    const exitCodeStatementIndex = visualRunContent.indexOf("exit $exitCode");
    const ownerSectionStart = visualRunContent.indexOf("$exitCode = 1");
    const ownerSectionEnd = exitCodeStatementIndex + "exit $exitCode".length;
    if (ownerSectionStart < 0 || exitCodeStatementIndex < ownerSectionStart) {
      throw new Error("Could not locate the complete production owner section.");
    }
    const realOwnerSection = visualRunContent.slice(ownerSectionStart, ownerSectionEnd);
    const workerInvocationAnchor = "& $nodePath @workerArgs 2>&1 | ForEach-Object {";
    const workerInvocationStart = realOwnerSection.indexOf(workerInvocationAnchor);
    if (workerInvocationStart < 0) {
      throw new Error("Could not locate the worker invocation to stub in the owner section.");
    }
    const workerInvocationOpenBrace = workerInvocationStart + workerInvocationAnchor.length - 1;
    const workerInvocationBody = extractBalancedBlockBody(realOwnerSection, workerInvocationOpenBrace);
    const workerInvocationEnd = workerInvocationOpenBrace + 1 + workerInvocationBody.length + 1;
    // The ONLY transformation: replace the real node invocation with a
    // caller-supplied stand-in statement - every other statement in the
    // real try/catch/do-while/release sequence runs unmodified and for
    // real. A harmless stub exercises the success path; a throwing stub
    // produces a genuine primary failure inside the real production
    // control flow, which is how cleanup-vs-primary precedence is proved
    // behaviorally rather than by reading the generated text.
    function ownerSectionWithStub(stubStatement) {
      return (
        realOwnerSection.slice(0, workerInvocationStart) +
        stubStatement +
        realOwnerSection.slice(workerInvocationEnd)
      );
    }
    const ownerSectionWithStubbedWorker = ownerSectionWithStub(
      '$global:LASTEXITCODE = 0; Write-Host "STUBBED_WORKER_INVOCATION"',
    );

    const statusProbeStart = statusScriptContent.indexOf('$lockText = ""');
    const statusProbeEnd = statusScriptContent.indexOf("$latestLog = Get-ChildItem");
    if (statusProbeStart < 0 || statusProbeEnd < 0) {
      throw new Error("Could not locate the status script's byte-lock probe.");
    }

    return {
      // Test-LegacyMarkerlessVisualLockActive / Test-VisualLockOwnedByAwardPing
      // / Read-VisualLockMetadataFromHandle.
      functions: visualRunContent.slice(functionsStart, functionsEnd),
      // The Write-Host announcement through the whole claim (open, lock,
      // classify-or-claim, write), stopping before the worker-owning try.
      claim: slice('Write-Host "Running AwardPing visual snapshot worker (', "$exitCode = 1"),
      // The real production owner section, worker invocation safely
      // stubbed, everything else executed unmodified (including the real
      // independent Unlock/Dispose release sequence).
      ownerSectionWithStubbedWorker,
      // Same, with a caller-chosen stand-in for the worker invocation.
      ownerSectionWithStub,
      // The status script's real, non-locking metadata read (plain
      // Read-access open, Seek+Read from offset 1 - never Lock/Unlock).
      statusProbe: statusScriptContent.slice(statusProbeStart, statusProbeEnd),
    };
  }

  function extractBalancedBlockBody(text, openBraceIndex) {
    if (text[openBraceIndex] !== "{") {
      throw new Error(`Expected '{' at index ${openBraceIndex}, found ${JSON.stringify(text[openBraceIndex])}`);
    }
    let depth = 0;
    for (let i = openBraceIndex; i < text.length; i++) {
      if (text[i] === "{") depth++;
      else if (text[i] === "}") {
        depth--;
        if (depth === 0) {
          return text.slice(openBraceIndex + 1, i);
        }
      }
    }
    throw new Error("Unbalanced braces");
  }

  function runVisualLockSimulation(directory, lines, fileName) {
    const scriptPath = join(directory, fileName || `visual-lock-${Math.random().toString(36).slice(2)}.ps1`);
    writeFileSync(scriptPath, lines.join("\n"), "utf8");
    return spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath], {
      encoding: "utf8",
    });
  }

  function runVisualLockSimulationAsync(directory, lines, fileName) {
    const scriptPath = join(directory, fileName || `visual-lock-${Math.random().toString(36).slice(2)}.ps1`);
    writeFileSync(scriptPath, lines.join("\n"), "utf8");
    return new Promise((resolvePromise) => {
      const child = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath], {
        encoding: "utf8",
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("close", (status) => resolvePromise({ status, stdout, stderr }));
    });
  }

  function baseScenarioLines(lockPath, functions) {
    return [
      "$ErrorActionPreference = 'Stop'",
      `$LockPath = '${lockPath.replace(/'/g, "''")}'`,
      "$ShardLabel = 'shard-1-of-3'",
      "$mode = 'snapshots'",
      "$ShardCount = 3",
      "$ShardIndex = 0",
      functions,
    ];
  }

  // Behavioral proof that a handle was really released. An exclusive open
  // (FileShare.None) can only succeed when NO other handle on the path is
  // still open, so running this in the SAME still-live process that just
  // executed the production cleanup distinguishes a real Dispose() from a
  // leaked handle - something no assertion over the generated text could.
  // (Process exit would close handles regardless, which is exactly why this
  // check must run before the script under test terminates.)
  const EXCLUSIVE_OPEN_PROOF = [
    "try {",
    "  $exclusive = [System.IO.FileStream]::new($LockPath, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)",
    "  'EXCLUSIVE_OPEN_OK=true'",
    "  $exclusive.Dispose()",
    "} catch {",
    "  'EXCLUSIVE_OPEN_FAILED=' + $_.Exception.Message",
    "}",
  ];

  // The exact on-disk shape the production claim writes: a NUL sentinel byte
  // at offset 0, then the versioned metadata from offset 1. Seeding test
  // content any other way is not faithful to the real format and silently
  // exercises different parsing.
  function faithfulLockContentLine(metadata) {
    return `Set-Content -LiteralPath $LockPath -Value ([char]0 + "${metadata}") -Encoding ASCII`;
  }

  windowsIt(
    "runs the complete real production owner control flow - claim, log init, worker loop, and the real finally/Unlock/Dispose - with only the node invocation stubbed",
    () => {
      const directory = mkdtempSync(join(tmpdir(), "awardping-visual-lock-"));
      try {
        const installRoot = join(directory, "install");
        mkdirSync(installRoot, { recursive: true });
        const { functions, claim, ownerSectionWithStubbedWorker } = visualLockSnippets(installRoot);
        const lockPath = join(directory, "shard.lock");
        const logPath = join(directory, "worker.log");

        const lines = [
          ...baseScenarioLines(lockPath, functions),
          `$logPath = '${logPath.replace(/'/g, "''")}'`,
          "$RunTrigger = 'manual'",
          "$MaxRestarts = 3",
          "$Limit = 50000",
          "$All = $false",
          claim,
          "'CLAIMED_BEFORE_OWNER_SECTION=' + (Test-Path -LiteralPath $LockPath)",
          ownerSectionWithStubbedWorker,
        ];
        const result = runVisualLockSimulation(directory, lines);

        expect(result.status, `stdout=${result.stdout}\nstderr=${result.stderr}`).toBe(0);
        expect(result.stdout).toContain("CLAIMED_BEFORE_OWNER_SECTION=True");
        expect(result.stdout).toContain("STUBBED_WORKER_INVOCATION");
        expect(readFileSync(logPath, "utf8")).toContain("VISUAL_WORKER_START");
        expect(readFileSync(logPath, "utf8")).toContain("VISUAL_WORKER_EXIT attempt=1 exit_code=0");
        // The real finally really Unlocked and Disposed the real handle:
        // the lock persists (this design leaves the file, never deletes
        // it) and is no longer held - a fresh claim against it must
        // succeed cleanly.
        expect(existsSync(lockPath)).toBe(true);
        const reclaim = runVisualLockSimulation(directory, [
          ...baseScenarioLines(lockPath, functions),
          "try {",
          claim,
          "  'RECLAIMED_AFTER_REAL_DISPOSE=true'",
          "} catch {",
          "  'PROPAGATED=' + $_.Exception.Message",
          "}",
        ]);
        expect(reclaim.status).toBe(0);
        expect(reclaim.stdout).toContain("RECLAIMED_AFTER_REAL_DISPOSE=true");
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  windowsIt(
    "disposes the contender's handle and still reports the fail-closed collision error when the collision diagnostic read itself fails",
    () => {
      const directory = mkdtempSync(join(tmpdir(), "awardping-visual-lock-"));
      try {
        const installRoot = join(directory, "install");
        mkdirSync(installRoot, { recursive: true });
        const { functions, claim } = visualLockSnippets(installRoot);
        const lockPath = join(directory, "shard.lock");

        const lines = [
          ...baseScenarioLines(lockPath, functions),
          "$logPath = Join-Path (Split-Path -Parent $LockPath) 'first.log'",
          // A genuine holder of byte 0, so the contender's Lock(0, 1)
          // really does fail with native 33.
          "$genuineHolder = [System.IO.FileStream]::new($LockPath, [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::ReadWrite)",
          "$genuineHolder.Lock(0, 1)",
          // Behavioral fault injection: shadow the real diagnostic reader
          // with one that genuinely throws - exactly what happens when the
          // metadata region is itself separately byte-range locked (that
          // real failure is reproduced in its own case below). Defined
          // AFTER the extracted production functions, so this definition is
          // the one the production collision branch actually calls.
          "function Read-VisualLockMetadataFromHandle { param([System.IO.FileStream]$Stream) throw [System.IO.IOException]::new('INJECTED_DIAGNOSTIC_READ_FAILURE') }",
          "try {",
          claim,
          "  'CLAIMED_SUCCESSFULLY=true'",
          "} catch {",
          "  'PROPAGATED=' + $_.Exception.Message",
          "}",
          // Release the genuine holder, so only a LEAKED contender handle
          // could still keep the exclusive open below from succeeding.
          "$genuineHolder.Unlock(0, 1)",
          "$genuineHolder.Dispose()",
          ...EXCLUSIVE_OPEN_PROOF,
        ];
        const result = runVisualLockSimulation(directory, lines);

        expect(result.status, `stdout=${result.stdout}\nstderr=${result.stderr}`).toBe(0);
        // The fail-closed collision error is what propagates ...
        expect(result.stdout).toContain("Cannot verify who holds the AwardPing visual worker lock");
        expect(result.stdout).not.toContain("CLAIMED_SUCCESSFULLY=true");
        // ... never replaced by the diagnostic read's own failure ...
        expect(result.stdout).not.toContain("PROPAGATED=INJECTED_DIAGNOSTIC_READ_FAILURE");
        // ... which is still surfaced, but only as a degraded note.
        expect(result.stdout).toContain("INJECTED_DIAGNOSTIC_READ_FAILURE");
        // Behavioral proof the finally ran: an exclusive open can only
        // succeed if the contender's handle was really disposed.
        expect(result.stdout).toContain("EXCLUSIVE_OPEN_OK=true");
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  windowsIt(
    "preserves the original worker failure and still disposes the handle when the owner's Unlock genuinely fails",
    () => {
      const directory = mkdtempSync(join(tmpdir(), "awardping-visual-lock-"));
      try {
        const installRoot = join(directory, "install");
        mkdirSync(installRoot, { recursive: true });
        const { functions, claim, ownerSectionWithStub } = visualLockSnippets(installRoot);
        const lockPath = join(directory, "shard.lock");
        const logPath = join(directory, "worker.log");

        const lines = [
          ...baseScenarioLines(lockPath, functions),
          `$logPath = '${logPath.replace(/'/g, "''")}'`,
          "$RunTrigger = 'manual'",
          "$MaxRestarts = 3",
          "$Limit = 50000",
          "$All = $false",
          claim,
          // Behavioral fault injection with a real .NET/OS failure rather
          // than a mock: consuming the unlock here makes the production
          // Unlock(0, 1) below throw "The segment is already unlocked."
          "$lockStream.Unlock(0, 1)",
          "'PRE_CONSUMED_UNLOCK=true'",
          "try {",
          // A genuine primary failure inside the real production control
          // flow, raised where the worker invocation would run.
          ownerSectionWithStub('throw [System.IO.IOException]::new("SIMULATED_PRIMARY_WORKER_FAILURE")'),
          "} catch {",
          "  'PROPAGATED=' + $_.Exception.Message",
          "}",
          ...EXCLUSIVE_OPEN_PROOF,
        ];
        const result = runVisualLockSimulation(directory, lines);

        expect(result.status, `stdout=${result.stdout}\nstderr=${result.stderr}`).toBe(0);
        expect(result.stdout).toContain("PRE_CONSUMED_UNLOCK=true");
        // The real, informative worker failure is what propagates ...
        expect(result.stdout).toContain("PROPAGATED=SIMULATED_PRIMARY_WORKER_FAILURE");
        // ... and the Unlock failure never replaces it.
        expect(result.stdout).not.toContain('PROPAGATED=Exception calling "Unlock"');
        // Dispose still ran even though Unlock threw first.
        expect(result.stdout).toContain("EXCLUSIVE_OPEN_OK=true");
        // The primary failure was still logged before propagating.
        expect(readFileSync(logPath, "utf8")).toContain("VISUAL_WORKER_WRAPPER_ERROR");
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  windowsIt(
    "reports a cleanup failure deliberately when the worker itself succeeded, and still disposes the handle",
    () => {
      const directory = mkdtempSync(join(tmpdir(), "awardping-visual-lock-"));
      try {
        const installRoot = join(directory, "install");
        mkdirSync(installRoot, { recursive: true });
        const { functions, claim, ownerSectionWithStubbedWorker } = visualLockSnippets(installRoot);
        const lockPath = join(directory, "shard.lock");
        const logPath = join(directory, "worker.log");

        const lines = [
          ...baseScenarioLines(lockPath, functions),
          `$logPath = '${logPath.replace(/'/g, "''")}'`,
          "$RunTrigger = 'manual'",
          "$MaxRestarts = 3",
          "$Limit = 50000",
          "$All = $false",
          claim,
          "$lockStream.Unlock(0, 1)",
          "try {",
          ownerSectionWithStubbedWorker,
          "} catch {",
          "  'PROPAGATED=' + $_.Exception.Message",
          "}",
          ...EXCLUSIVE_OPEN_PROOF,
        ];
        const result = runVisualLockSimulation(directory, lines);

        expect(result.status, `stdout=${result.stdout}\nstderr=${result.stderr}`).toBe(0);
        // The work itself completed normally ...
        expect(result.stdout).toContain("STUBBED_WORKER_INVOCATION");
        expect(readFileSync(logPath, "utf8")).toContain("VISUAL_WORKER_EXIT attempt=1 exit_code=0");
        // ... so the cleanup failure is this launch's ONLY failure, and it
        // is deliberately reported rather than swallowed into a clean exit
        // that would hide an unreleased lock or handle.
        expect(result.stdout).toContain("PROPAGATED=");
        expect(result.stdout).toContain("already unlocked");
        // Dispose still ran despite the Unlock failure being the reported
        // one.
        expect(result.stdout).toContain("EXCLUSIVE_OPEN_OK=true");
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  windowsIt(
    "preserves the original worker failure and still releases the lock when the catch's own error-report logging genuinely fails",
    () => {
      const directory = mkdtempSync(join(tmpdir(), "awardping-visual-lock-"));
      try {
        const installRoot = join(directory, "install");
        mkdirSync(installRoot, { recursive: true });
        const { functions, claim, ownerSectionWithStub } = visualLockSnippets(installRoot);
        const lockPath = join(directory, "shard.lock");
        const logPath = join(directory, "worker.log");

        const lines = [
          ...baseScenarioLines(lockPath, functions),
          `$logPath = '${logPath.replace(/'/g, "''")}'`,
          "$RunTrigger = 'manual'",
          "$MaxRestarts = 3",
          "$Limit = 50000",
          "$All = $false",
          claim,
          "try {",
          // A genuine primary failure inside the real production control
          // flow, raised where the worker invocation would run. The stub
          // ALSO opens a genuine, real share-denying handle on the same
          // log path the catch's own error-report logging writes to -
          // opened here (not by the harness beforehand), so the FIRST
          // "VISUAL_WORKER_START" write inside the try still succeeds and
          // only the catch's later "VISUAL_WORKER_WRAPPER_ERROR" append
          // collides with it, exactly as the reviewer's repro requires.
          // Real .NET/OS behavior, not a mock: FileAccess.Read/
          // FileShare.Read is incompatible with the Write access
          // Add-Content needs, so its append genuinely throws.
          ownerSectionWithStub(
            '$logDenier = [System.IO.FileStream]::new($logPath, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read); ' +
              'throw [System.IO.IOException]::new("SENTINEL_PRIMARY_FAILURE")',
          ),
          "} catch {",
          "  'PROPAGATED=' + $_.Exception.Message",
          "}",
          // Release the log-path denier from the SAME still-live process,
          // before checking whether the lock handle was released.
          "if ($logDenier) { $logDenier.Dispose() }",
          ...EXCLUSIVE_OPEN_PROOF,
        ];
        const result = runVisualLockSimulation(directory, lines);

        expect(result.status, `stdout=${result.stdout}\nstderr=${result.stderr}`).toBe(0);
        // The original, informative sentinel failure is what propagates ...
        expect(result.stdout).toContain("PROPAGATED=SENTINEL_PRIMARY_FAILURE");
        // ... never replaced by the catch's own logging/sharing failure,
        // which - under $ErrorActionPreference = "Stop" and without
        // capturing $_ first - would otherwise leave the catch before
        // $primaryFailure is ever assigned.
        expect(result.stdout).not.toContain("PROPAGATED=The process cannot access");
        // The byte-range lock is still released despite that logging
        // failure - proved behaviorally: an exclusive reopen from this
        // same still-live process can only succeed if it really was.
        expect(result.stdout).toContain("EXCLUSIVE_OPEN_OK=true");
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  windowsIt(
    "disposes the status probe's handle when its read genuinely fails, and never contends for byte 0",
    () => {
      const directory = mkdtempSync(join(tmpdir(), "awardping-visual-lock-"));
      try {
        const installRoot = join(directory, "install");
        mkdirSync(installRoot, { recursive: true });
        const { statusProbe } = visualLockSnippets(installRoot);
        const lockPath = join(directory, "shard.lock");

        const lines = [
          "$ErrorActionPreference = 'Stop'",
          `$LockPath = '${lockPath.replace(/'/g, "''")}'`,
          "Set-Content -LiteralPath $LockPath -Value ([char]0 + 'protocol=2 pid=1234 started=now') -Encoding ASCII",
          // A genuine competing byte-range lock over the metadata region
          // (offset 1 onwards, NOT byte 0) makes the probe's own Read()
          // fail for real, after its open has already succeeded - the exact
          // path that previously skipped Dispose() entirely. Windows
          // enforces byte-range locks against other handles regardless of
          // share mode, so this is a real I/O failure, not a simulated one.
          "$blocker = [System.IO.FileStream]::new($LockPath, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::ReadWrite)",
          "$blocker.Lock(1, 4096)",
          statusProbe,
          "'LOCKTEXT_LENGTH=' + $lockText.Length",
          // Drop the blocker so only a LEAKED probe handle could keep the
          // exclusive open below from succeeding.
          "$blocker.Unlock(1, 4096)",
          "$blocker.Dispose()",
          ...EXCLUSIVE_OPEN_PROOF,
        ];
        const result = runVisualLockSimulation(directory, lines);

        // The probe swallows the read failure and reports nothing rather
        // than guessing ...
        expect(result.status, `stdout=${result.stdout}\nstderr=${result.stderr}`).toBe(0);
        expect(result.stdout).toContain("LOCKTEXT_LENGTH=0");
        // ... and its handle is still released.
        expect(result.stdout).toContain("EXCLUSIVE_OPEN_OK=true");
        // Byte 0 is never touched by the probe at all, so it can never
        // become a transient owner racing a genuine claimant.
        expect(statusProbe).not.toContain(".Lock(");
        expect(statusProbe).not.toContain(".Unlock(");
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  windowsIt(
    "does not falsely confirm ActiveOwner when a readable unrelated holder's mere open-level conflict coincides with stale metadata naming a live, matching PID",
    () => {
      const directory = mkdtempSync(join(tmpdir(), "awardping-visual-lock-"));
      try {
        const installRoot = join(directory, "install");
        mkdirSync(installRoot, { recursive: true });
        const { functions, claim } = visualLockSnippets(installRoot);
        const lockPath = join(directory, "shard.lock");

        const lines = [
          ...baseScenarioLines(lockPath, functions),
          "$logPath = Join-Path (Split-Path -Parent $LockPath) 'first.log'",
          // Stale content naming THIS script's own real, live PID, written
          // in the production-faithful on-disk shape (NUL sentinel byte,
          // then metadata at offset 1) - exactly the reused/current-PID
          // collision that metadata alone cannot resolve safely.
          faithfulLockContentLine("protocol=2 pid=$PID started=stale"),
          // A foreign, unrelated holder whose access conflicts with our
          // own open (FileAccess.Read/FileShare.Read denies the Write
          // component of our ReadWrite request) but has nothing to do
          // with the AwardPing protocol.
          "$foreignHolder = [System.IO.FileStream]::new($LockPath, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)",
          "try {",
          claim,
          "  'CLAIMED_SUCCESSFULLY=true'",
          "} catch {",
          "  'PROPAGATED=' + $_.Exception.Message",
          "} finally {",
          "  $foreignHolder.Dispose()",
          "}",
        ];
        // Named so this process's own PID would genuinely match via CIM,
        // if content were ever (wrongly) trusted without tying it to the
        // actual conflicting handle's identity.
        const result = runVisualLockSimulation(directory, lines, "Run-AwardPingVisualSnapshots.ps1");

        expect(result.status, `stdout=${result.stdout}\nstderr=${result.stderr}`).toBe(0);
        expect(result.stdout).toContain("PROPAGATED=");
        expect(result.stdout).not.toContain("CLAIMED_SUCCESSFULLY=true");
        expect(result.stdout).not.toContain("AwardPing visual snapshot worker is already running. Skipping this launch.");
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  windowsIt(
    "does not falsely confirm ActiveOwner when a foreign process holds byte 0 itself with content that does not verify",
    () => {
      const directory = mkdtempSync(join(tmpdir(), "awardping-visual-lock-"));
      try {
        const installRoot = join(directory, "install");
        mkdirSync(installRoot, { recursive: true });
        const { functions, claim } = visualLockSnippets(installRoot);
        const lockPath = join(directory, "shard.lock");

        const lines = [
          ...baseScenarioLines(lockPath, functions),
          "$logPath = Join-Path (Split-Path -Parent $LockPath) 'first.log'",
          // A foreign process, cooperating enough to open with the same
          // broad ReadWrite/ReadWrite sharing (so our own open succeeds)
          // but genuinely locking byte 0 itself with content that has no
          // AwardPing protocol marker at all.
          "$foreign = [System.IO.FileStream]::new($LockPath, [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::ReadWrite)",
          "$foreign.Lock(0, 1)",
          "$foreignBytes = [System.Text.Encoding]::ASCII.GetBytes([char]0 + 'not-awardping-at-all')",
          "$foreign.Write($foreignBytes, 0, $foreignBytes.Length)",
          "$foreign.Flush()",
          "try {",
          claim,
          "  'CLAIMED_SUCCESSFULLY=true'",
          "} catch {",
          "  'PROPAGATED=' + $_.Exception.Message",
          "} finally {",
          "  $foreign.Unlock(0, 1)",
          "  $foreign.Dispose()",
          "}",
        ];
        const result = runVisualLockSimulation(directory, lines);

        expect(result.status, `stdout=${result.stdout}\nstderr=${result.stderr}`).toBe(0);
        expect(result.stdout).toContain("PROPAGATED=");
        expect(result.stdout).toContain("not-awardping-at-all");
        expect(result.stdout).not.toContain("CLAIMED_SUCCESSFULLY=true");
        expect(result.stdout).not.toContain("AwardPing visual snapshot worker is already running. Skipping this launch.");
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  windowsIt(
    "reclaims a stale, unlocked lock written in the real on-disk sentinel format whose recorded PID has been reused by the current live launcher, instead of self-skipping it as a legacy owner",
    () => {
      const directory = mkdtempSync(join(tmpdir(), "awardping-visual-lock-"));
      try {
        const installRoot = join(directory, "install");
        mkdirSync(installRoot, { recursive: true });
        const { functions, claim } = visualLockSnippets(installRoot);
        const lockPath = join(directory, "shard.lock");

        const lines = [
          ...baseScenarioLines(lockPath, functions),
          "$logPath = Join-Path (Split-Path -Parent $LockPath) 'first.log'",
          // A genuinely stale, UNLOCKED leftover written exactly the way
          // the production claim writes it - NUL sentinel at byte 0, then
          // "protocol=2 ..." from offset 1 - naming this launch's own
          // current PID, i.e. a PID the OS reused for this very process.
          //
          // The legacy preflight reads this file from byte 0, so it must
          // recognize the sentinel format for what it is. Anchoring the
          // marker check at offset 0 cannot match sentinel-prefixed
          // content, which would drop through to the legacy pid= scan,
          // find this process's own live, command-line-matching PID, and
          // make the launch skip ITSELF as a "legacy lock" before ever
          // reaching the byte-lock path. Nothing holds byte 0 here, so the
          // only correct outcome is a clean claim.
          faithfulLockContentLine(
            "protocol=2 pid=$PID started=2020-01-01T00:00:00Z mode=snapshots shard_count=3 shard_index=0 log=C:\\logs\\old.log",
          ),
          "try {",
          claim,
          "  'CLAIMED_SUCCESSFULLY=true'",
          "} catch {",
          "  'PROPAGATED=' + $_.Exception.Message",
          "}",
        ];
        // Named so this process genuinely satisfies the command-line half
        // of the legacy liveness check, exactly as a real launcher would.
        const result = runVisualLockSimulation(directory, lines, "Run-AwardPingVisualSnapshots.ps1");

        expect(result.status, `stdout=${result.stdout}\nstderr=${result.stderr}`).toBe(0);
        expect(result.stdout).toContain("CLAIMED_SUCCESSFULLY=true");
        expect(result.stdout).not.toContain("(legacy lock)");
        expect(result.stdout).not.toContain("Skipping this launch.");
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  windowsIt(
    "never accepts the current launcher's own PID as evidence of a separate legacy owner, even for markerless legacy content",
    () => {
      const directory = mkdtempSync(join(tmpdir(), "awardping-visual-lock-"));
      try {
        const installRoot = join(directory, "install");
        mkdirSync(installRoot, { recursive: true });
        const { functions, claim } = visualLockSnippets(installRoot);
        const lockPath = join(directory, "shard.lock");

        const lines = [
          ...baseScenarioLines(lockPath, functions),
          "$logPath = Join-Path (Split-Path -Parent $LockPath) 'first.log'",
          // Genuinely markerless legacy content (no sentinel, no protocol
          // marker) that names this launcher's own PID. A live PID plus a
          // matching command line is trivially true of the checking
          // process itself, so it can never distinguish a real separate
          // legacy owner from a stale record whose PID got reused here.
          "Set-Content -LiteralPath $LockPath -Value \"pid=$PID started=2020-01-01T00:00:00Z mode=snapshots shard_count=3 shard_index=0 log=C:\\logs\\legacy.log\" -Encoding ASCII",
          "try {",
          claim,
          "  'CLAIMED_SUCCESSFULLY=true'",
          "} catch {",
          "  'PROPAGATED=' + $_.Exception.Message",
          "}",
        ];
        const result = runVisualLockSimulation(directory, lines, "Run-AwardPingVisualSnapshots.ps1");

        expect(result.status, `stdout=${result.stdout}\nstderr=${result.stderr}`).toBe(0);
        expect(result.stdout).toContain("CLAIMED_SUCCESSFULLY=true");
        expect(result.stdout).not.toContain("(legacy lock)");
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  windowsIt(
    "conservatively prevents a duplicate against a genuine, separate, actually-deployed-style legacy process, while a stale legacy leftover is reclaimed by the new protocol",
    async () => {
      const directory = mkdtempSync(join(tmpdir(), "awardping-visual-lock-"));
      try {
        mkdirSync(join(directory, "install"), { recursive: true });
        const { functions, claim } = visualLockSnippets(join(directory, "install"));
        const lockPath = join(directory, "shard.lock");

        // A GENUINE, SEPARATE process reproducing parent 25dc124's actual
        // deployed behavior exactly: a plain Set-Content lock, no file
        // handle held at all, staying alive for a real duration (not the
        // same process that then checks it, and not the contender naming
        // its own PID - a genuinely independent legacy lifecycle).
        const legacyOwnerLines = [
          "$ErrorActionPreference = 'Stop'",
          `$LockPath = '${lockPath.replace(/'/g, "''")}'`,
          // The log= field itself contains the substring "protocol=" (a
          // real risk on a system whose install/log directory name
          // happens to contain that text) - the legacy check's anchored
          // parsing must still recognize this as legacy content, never
          // mistake it for new-protocol content.
          "Set-Content -Path $LockPath -Value \"pid=$PID started=$(Get-Date -Format o) mode=snapshots shard_count=3 shard_index=0 log=C:\\install\\protocol=2-test\\legacy.log\" -Encoding ASCII",
          "Start-Sleep -Milliseconds 2500",
          "Remove-Item -Path $LockPath -Force -ErrorAction SilentlyContinue",
          "'LEGACY_OWNER_DONE=true'",
        ];
        const legacyOwnerPromise = runVisualLockSimulationAsync(directory, legacyOwnerLines, "Run-AwardPingVisualSnapshots.ps1");
        await new Promise((r) => setTimeout(r, 700));

        const contenderLines = [
          ...baseScenarioLines(lockPath, functions),
          "$logPath = Join-Path (Split-Path -Parent $LockPath) 'contender.log'",
          "try {",
          claim,
          "  'CLAIMED_SUCCESSFULLY=true'",
          "} catch {",
          "  'PROPAGATED=' + $_.Exception.Message",
          "}",
        ];
        const contenderResult = runVisualLockSimulation(directory, contenderLines);
        const legacyOwnerResult = await legacyOwnerPromise;

        expect(legacyOwnerResult.status, `stdout=${legacyOwnerResult.stdout}`).toBe(0);
        expect(legacyOwnerResult.stdout).toContain("LEGACY_OWNER_DONE=true");
        expect(contenderResult.status, `stdout=${contenderResult.stdout}\nstderr=${contenderResult.stderr}`).toBe(0);
        expect(contenderResult.stdout).toContain("AwardPing visual snapshot worker is already running (legacy lock). Skipping this launch.");
        expect(contenderResult.stdout).not.toContain("CLAIMED_SUCCESSFULLY=true");
        expect(contenderResult.stdout).not.toContain("PROPAGATED=");
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
    20_000,
  );

  windowsIt(
    "reclaims stale legacy content via the new protocol",
    () => {
      const directory = mkdtempSync(join(tmpdir(), "awardping-visual-lock-"));
      try {
        const installRoot = join(directory, "install");
        mkdirSync(installRoot, { recursive: true });
        const { functions, claim } = visualLockSnippets(installRoot);
        const lockPath = join(directory, "shard.lock");
        // Stale legacy content naming a PID that is not live - falls
        // through to the new protocol, which claims it directly.
        writeFileSync(lockPath, "pid=999999 started=legacy-stale", "utf8");

        const lines = [
          ...baseScenarioLines(lockPath, functions),
          "$logPath = Join-Path (Split-Path -Parent $LockPath) 'first.log'",
          "try {",
          claim,
          "  'CLAIMED_SUCCESSFULLY=true'",
          "} catch {",
          "  'PROPAGATED=' + $_.Exception.Message",
          "}",
        ];
        const result = runVisualLockSimulation(directory, lines);
        expect(result.status, `stdout=${result.stdout}`).toBe(0);
        expect(result.stdout).toContain("CLAIMED_SUCCESSFULLY=true");
        expect(result.stdout).not.toContain("legacy lock");
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  windowsIt(
    "classifies every lock-content shape correctly against a genuinely separate live legacy process: anchored log= paths, the real sentinel format, corrupt/partial sentinels, garbage-prefixed pid=, self-PID, and stale PIDs",
    () => {
      const directory = mkdtempSync(join(tmpdir(), "awardping-visual-lock-"));
      let legacyPid = "";
      try {
        const installRoot = join(directory, "install");
        mkdirSync(installRoot, { recursive: true });
        const { functions } = visualLockSnippets(installRoot);
        const lockPath = join(directory, "shard.lock");

        // A genuinely SEPARATE, live process whose command line matches the
        // legacy liveness check - never this test's own process, so a
        // "legacy is active" verdict can only come from real, independent
        // evidence rather than from the checker trivially matching itself.
        const legacyOwnerScript = join(directory, "Run-AwardPingVisualSnapshots.ps1");
        writeFileSync(legacyOwnerScript, "Start-Sleep -Seconds 30\n", "utf8");
        const spawned = spawnSync(
          "powershell.exe",
          ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command",
            `(Start-Process powershell.exe -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','${legacyOwnerScript}' -PassThru -WindowStyle Hidden).Id`],
          { encoding: "utf8" },
        );
        legacyPid = spawned.stdout.trim();
        expect(legacyPid, `spawn stdout=${spawned.stdout} stderr=${spawned.stderr}`).toMatch(/^\d+$/);

        // Each case writes real content to a real file and asks the real
        // extracted production function for its verdict.
        const cases = [
          {
            label: "LEGACY_WITH_PROTOCOL_IN_LOG_PATH",
            // Markerless legacy content whose OWN log= field contains the
            // substring "protocol=". An unanchored marker check would treat
            // this as new-protocol content and skip the legacy check
            // entirely, permitting a duplicate against a live legacy run.
            write: `Set-Content -LiteralPath $LockPath -Value "pid=${legacyPid} started=legacy mode=snapshots shard_count=3 shard_index=0 log=C:\\install\\protocol=2-test\\worker.log" -Encoding ASCII`,
            expected: "True",
          },
          {
            label: "REAL_SENTINEL_NEW_PROTOCOL_CONTENT",
            // The genuine on-disk new-protocol shape - NUL sentinel at byte
            // 0, marker at offset 1 - naming that same live, matching PID.
            // It must be recognized as new-protocol content and left to the
            // byte-lock path, never scanned for a legacy pid=.
            write: `Set-Content -LiteralPath $LockPath -Value ([char]0 + "protocol=2 pid=${legacyPid} started=now mode=snapshots shard_count=3 shard_index=0 log=C:\\logs\\x.log") -Encoding ASCII`,
            expected: "False",
          },
          {
            label: "CORRUPT_SENTINEL",
            // NUL-prefixed (so it belongs to the new protocol's write
            // space), but the content after it is garbled and matches no
            // recognized "protocol=N" marker at all - and yet still
            // contains a pid= substring naming the live, matching process.
            // It must never enter legacy parsing regardless.
            write: `Set-Content -LiteralPath $LockPath -Value ([char]0 + "garbled-not-a-real-marker pid=${legacyPid}") -Encoding ASCII`,
            expected: "False",
          },
          {
            label: "PARTIAL_SENTINEL",
            // NUL-prefixed, as if a write was interrupted mid-flush - only
            // "prot" made it to disk before the live, matching pid=.
            write: `Set-Content -LiteralPath $LockPath -Value ([char]0 + "prot pid=${legacyPid}") -Encoding ASCII`,
            expected: "False",
          },
          {
            label: "GARBAGE_PREFIX_WITH_PID",
            // No sentinel at all, but "pid=" does not begin the content -
            // an unanchored legacy scan would still find and misuse it.
            write: `Set-Content -LiteralPath $LockPath -Value "XYZ garbage pid=${legacyPid} started=now" -Encoding ASCII`,
            expected: "False",
          },
          {
            label: "EXACT_MARKERLESS_LEGACY",
            // The real, exact deployed 25dc124 shape, with nothing else
            // preceding "pid=" - must still be recognized as legacy.
            write: `Set-Content -LiteralPath $LockPath -Value "pid=${legacyPid} started=now mode=snapshots shard_count=3 shard_index=0 log=C:\\logs\\legacy.log" -Encoding ASCII`,
            expected: "True",
          },
          {
            label: "SELF_PID_IS_NEVER_LEGACY_EVIDENCE",
            write: "Set-Content -LiteralPath $LockPath -Value \"pid=$PID started=legacy mode=snapshots\" -Encoding ASCII",
            expected: "False",
          },
          {
            label: "STALE_DEAD_PID",
            write: "Set-Content -LiteralPath $LockPath -Value \"pid=999999 started=2020-01-01T00:00:00Z mode=snapshots\" -Encoding ASCII",
            expected: "False",
          },
        ];

        const lines = [
          "$ErrorActionPreference = 'Stop'",
          `$LockPath = '${lockPath.replace(/'/g, "''")}'`,
          functions,
        ];
        for (const testCase of cases) {
          lines.push(testCase.write);
          lines.push(`'${testCase.label}=' + (Test-LegacyMarkerlessVisualLockActive -Path $LockPath)`);
        }
        const result = runVisualLockSimulation(directory, lines);

        expect(result.status, `stdout=${result.stdout}\nstderr=${result.stderr}`).toBe(0);
        for (const testCase of cases) {
          expect(result.stdout, `case ${testCase.label}`).toContain(`${testCase.label}=${testCase.expected}`);
        }
      } finally {
        if (/^\d+$/.test(legacyPid)) {
          spawnSync("powershell.exe", ["-NoProfile", "-Command", `Stop-Process -Id ${legacyPid} -Force -ErrorAction SilentlyContinue`], { encoding: "utf8" });
        }
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  windowsIt(
    "does not crash the legacy preflight on partial or corrupt lock content",
    () => {
      const directory = mkdtempSync(join(tmpdir(), "awardping-visual-lock-"));
      try {
        const installRoot = join(directory, "install");
        mkdirSync(installRoot, { recursive: true });
        const { functions, claim } = visualLockSnippets(installRoot);

        const cases = [
          "not a lock at all, just garbage bytes \x00\x01\x02",
          "pid=",
          "pid=notanumber started=corrupt",
          "protocol=",
          "protocol=notanumber pid=1 started=corrupt",
        ];
        for (const content of cases) {
          const lockPath = join(directory, `shard-${Math.random().toString(36).slice(2)}.lock`);
          writeFileSync(lockPath, content, "utf8");
          const lines = [
            ...baseScenarioLines(lockPath, functions),
            "$logPath = Join-Path (Split-Path -Parent $LockPath) 'first.log'",
            "try {",
            claim,
            "  'CLAIMED_SUCCESSFULLY=true'",
            "} catch {",
            "  'PROPAGATED=' + $_.Exception.Message",
            "}",
          ];
          const result = runVisualLockSimulation(directory, lines);
          expect(result.status, `content=${JSON.stringify(content)} stdout=${result.stdout}\nstderr=${result.stderr}`).toBe(0);
          // Whatever the classification, it must not crash with an
          // uncaught parser exception - either it claims (partial/corrupt
          // legacy content that never matches the legacy check falls
          // through and is reclaimed) or it fails closed cleanly, never a
          // PowerShell parse/argument exception escaping unexpectedly.
          expect(result.stderr).not.toContain("ArgumentNullException");
          expect(result.stderr).not.toContain("Cannot convert value");
        }
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  windowsIt(
    "does not crash on an empty (zero-byte) lock file during the legacy preflight check",
    () => {
      const directory = mkdtempSync(join(tmpdir(), "awardping-visual-lock-"));
      try {
        const installRoot = join(directory, "install");
        mkdirSync(installRoot, { recursive: true });
        const { functions, claim } = visualLockSnippets(installRoot);
        const lockPath = join(directory, "shard.lock");
        // Get-Content -Raw returns $null (not "") for a zero-byte file -
        // exactly what a crashed prior claim (truncated but never
        // finished writing) could leave behind.
        writeFileSync(lockPath, "", "utf8");

        const lines = [
          ...baseScenarioLines(lockPath, functions),
          "$logPath = Join-Path (Split-Path -Parent $LockPath) 'first.log'",
          "try {",
          claim,
          "  'CLAIMED_SUCCESSFULLY=true'",
          "} catch {",
          "  'PROPAGATED=' + $_.Exception.Message",
          "}",
        ];
        const result = runVisualLockSimulation(directory, lines);

        expect(result.status, `stdout=${result.stdout}\nstderr=${result.stderr}`).toBe(0);
        expect(result.stdout).toContain("CLAIMED_SUCCESSFULLY=true");
        expect(result.stdout).not.toContain("PROPAGATED=");
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  windowsIt(
    "disposes the exact acquired handle and rethrows the real failure - never a secondary Dispose failure - when writing its own just-claimed lock content fails",
    () => {
      const directory = mkdtempSync(join(tmpdir(), "awardping-visual-lock-"));
      try {
        const installRoot = join(directory, "install");
        mkdirSync(installRoot, { recursive: true });
        const { functions, claim } = visualLockSnippets(installRoot);
        const lockPath = join(directory, "shard.lock");

        // A safe, deterministic, real (not mocked) way to force the
        // owner's OWN post-lock Write/Flush to fail: a separate handle
        // locks the metadata byte range (offset 1 onward) the owner is
        // about to write into, before it writes - entirely within one
        // process, no multi-process timing. Because Dispose() itself
        // tries to flush any still-buffered write, it can ALSO fail here
        // (verified empirically) while the same external lock persists -
        // this specifically exercises that the ORIGINAL Flush failure,
        // not a secondary Dispose failure, is what propagates.
        const claimWithByteLock = claim.replace(
          "$sentinelAndContent = [byte[]]@(0) + [System.Text.Encoding]::ASCII.GetBytes($lockContent)",
          [
            "$__testLocker = [System.IO.FileStream]::new($LockPath, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::ReadWrite)",
            "$__testLocker.Lock(1, 4096)",
            "$sentinelAndContent = [byte[]]@(0) + [System.Text.Encoding]::ASCII.GetBytes($lockContent)",
          ].join("\n"),
        );
        expect(claimWithByteLock).not.toBe(claim);

        const lines = [
          ...baseScenarioLines(lockPath, functions),
          "$logPath = Join-Path (Split-Path -Parent $LockPath) 'first.log'",
          "try {",
          claimWithByteLock,
          "  'CLAIMED_SUCCESSFULLY=true'",
          "} catch {",
          "  'PROPAGATED=' + $_.Exception.Message",
          "} finally {",
          "  if ($__testLocker) { $__testLocker.Unlock(1, 4096); $__testLocker.Dispose() }",
          "}",
        ];
        const result = runVisualLockSimulation(directory, lines);

        expect(result.status, `stdout=${result.stdout}\nstderr=${result.stderr}`).toBe(0);
        expect(result.stdout).toContain("PROPAGATED=");
        expect(result.stdout).not.toContain("CLAIMED_SUCCESSFULLY=true");
        expect(result.stdout).not.toContain("AwardPing visual snapshot worker is already running. Skipping this launch.");
        // The real, original failure (Flush) propagates - never a
        // secondary Dispose-during-cleanup failure masking it, and never
        // reclassified into the generic "cannot verify ownership" wording.
        expect(result.stdout.toLowerCase()).toContain("flush");
        expect(result.stdout).not.toContain("Cannot verify whether the AwardPing visual worker lock");
        // The handle itself must not be leaked: a subsequent, independent
        // claim attempt against the same path must succeed cleanly.
        const reclaim = runVisualLockSimulation(directory, [
          ...baseScenarioLines(lockPath, functions),
          "try {",
          claim,
          "  'RECLAIMED=true'",
          "} catch {",
          "  'PROPAGATED=' + $_.Exception.Message",
          "}",
        ]);
        expect(reclaim.status, `stdout=${reclaim.stdout}`).toBe(0);
        expect(reclaim.stdout).toContain("RECLAIMED=true");
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  windowsIt(
    "reads recorded lock metadata honestly (present before, during, and after a real claim) without ever asserting a proven current lock",
    async () => {
      const directory = mkdtempSync(join(tmpdir(), "awardping-visual-lock-"));
      try {
        const installRoot = join(directory, "install");
        mkdirSync(installRoot, { recursive: true });
        const { functions, claim, statusProbe } = visualLockSnippets(installRoot);
        const lockPath = join(directory, "shard.lock");

        function runStatusProbe() {
          return runVisualLockSimulation(directory, [
            `$LockPath = '${lockPath.replace(/'/g, "''")}'`,
            statusProbe,
            "'TEXT=' + $lockText",
          ]);
        }

        const beforeClaim = runStatusProbe();
        expect(beforeClaim.status, `stdout=${beforeClaim.stdout}`).toBe(0);
        expect(beforeClaim.stdout).toContain("TEXT=");
        expect(beforeClaim.stdout).not.toMatch(/TEXT=protocol=2/);

        const ownerLines = [
          ...baseScenarioLines(lockPath, functions),
          "$logPath = Join-Path (Split-Path -Parent $LockPath) 'owner.log'",
          claim,
          "Start-Sleep -Milliseconds 1500",
          "if ($lockStream) { $lockStream.Unlock(0,1); $lockStream.Dispose() }",
          "'OWNER_RELEASED=true'",
        ];
        const ownerPromise = runVisualLockSimulationAsync(directory, ownerLines);
        await new Promise((r) => setTimeout(r, 700));

        const whileHeld = runStatusProbe();
        expect(whileHeld.status, `stdout=${whileHeld.stdout}`).toBe(0);
        expect(whileHeld.stdout).toMatch(/TEXT=protocol=2 pid=\d+/);

        const ownerResult = await ownerPromise;
        expect(ownerResult.status).toBe(0);
        expect(ownerResult.stdout).toContain("OWNER_RELEASED=true");

        const afterRelease = runStatusProbe();
        expect(afterRelease.status, `stdout=${afterRelease.stdout}`).toBe(0);
        // The metadata is still readable (never deleted) - the status
        // script has no basis to distinguish this from the held case, and
        // correctly never claims to.
        expect(afterRelease.stdout).toMatch(/TEXT=protocol=2 pid=\d+/);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
    20_000,
  );

  windowsIt(
    "status inspection never contends on byte 0 or perturbs a real claimant, even when run repeatedly while the claim is in flight",
    async () => {
      const directory = mkdtempSync(join(tmpdir(), "awardping-visual-lock-"));
      try {
        const installRoot = join(directory, "install");
        mkdirSync(installRoot, { recursive: true });
        const { functions, claim, statusProbe } = visualLockSnippets(installRoot);
        const lockPath = join(directory, "shard.lock");

        const ownerLines = [
          ...baseScenarioLines(lockPath, functions),
          "$logPath = Join-Path (Split-Path -Parent $LockPath) 'owner.log'",
          claim,
          "Start-Sleep -Milliseconds 1500",
          "if ($lockStream) { $lockStream.Unlock(0,1); $lockStream.Dispose() }",
          "'OWNER_RELEASED=true'",
        ];
        const ownerPromise = runVisualLockSimulationAsync(directory, ownerLines, "Run-AwardPingVisualSnapshots.ps1");
        await new Promise((r) => setTimeout(r, 300));

        // Hammer the status probe repeatedly WHILE the real claimant holds
        // the lock - none of these may ever fail, and none may cause the
        // real claimant to fail or falsely skip.
        const statusResults = [];
        for (let i = 0; i < 10; i++) {
          statusResults.push(
            runVisualLockSimulation(directory, [
              `$LockPath = '${lockPath.replace(/'/g, "''")}'`,
              statusProbe,
              "'TEXT=' + $lockText",
            ]),
          );
        }
        const ownerResult = await ownerPromise;

        statusResults.forEach((r, i) => {
          expect(r.status, `status probe ${i}: stdout=${r.stdout}\nstderr=${r.stderr}`).toBe(0);
        });
        expect(ownerResult.status, `stdout=${ownerResult.stdout}\nstderr=${ownerResult.stderr}`).toBe(0);
        expect(ownerResult.stdout).toContain("OWNER_RELEASED=true");
        expect(ownerResult.stdout).not.toContain("PROPAGATED=");
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
    20_000,
  );

  windowsIt(
    "proves genuine byte-lock contention with an explicit collision marker from the contender's own attempt, fails closed against a real active owner rather than a silent skip, then reclaims after a real, confirmed release",
    async () => {
      const directory = mkdtempSync(join(tmpdir(), "awardping-visual-lock-"));
      try {
        const installRoot = join(directory, "install");
        mkdirSync(installRoot, { recursive: true });
        const { functions, claim } = visualLockSnippets(installRoot);
        const lockPath = join(directory, "shard.lock");
        const ownerClaimedSignal = join(directory, "owner-claimed.signal");

        // The contender is instrumented (a safe, additive transformation:
        // one line inside the real Lock(0,1) catch, changing nothing about
        // control flow) to record - as ground truth from the actual
        // production code path, independent of any timing assumption -
        // that it genuinely observed lock contention. Printed immediately,
        // since the Ambiguous failure throws from directly inside this
        // same catch block - a single pass, so any statement following
        // the try/catch never runs.
        const instrumentedClaim = claim.replace(
          "} catch [System.IO.IOException] {\n  # Best-effort cleanup throughout",
          "} catch [System.IO.IOException] {\n  Write-Host 'OBSERVED_LOCK_CONTENTION=True'\n  # Best-effort cleanup throughout",
        );
        expect(instrumentedClaim).not.toBe(claim);

        // The contender is PRE-STARTED and polls a tight loop for the
        // owner's claim signal, so its own PowerShell interpreter startup
        // latency happens entirely before the race window rather than
        // eating into a short hold duration.
        const contenderLines = [
          ...baseScenarioLines(lockPath, functions),
          "$logPath = Join-Path (Split-Path -Parent $LockPath) 'contender.log'",
          `while (-not (Test-Path -LiteralPath '${ownerClaimedSignal.replace(/'/g, "''")}')) { Start-Sleep -Milliseconds 2 }`,
          "try {",
          instrumentedClaim,
          "  'CLAIMED_SUCCESSFULLY=true'",
          "} catch {",
          "  'PROPAGATED=' + $_.Exception.Message",
          "}",
        ];
        const contenderPromise = runVisualLockSimulationAsync(directory, contenderLines);
        await new Promise((r) => setTimeout(r, 800));

        // Named so this process's own real command line matches the
        // broad substring check - the contender's Test-VisualLockOwnedByAwardPing
        // verification depends on the OWNER's actual process, not the
        // contender's.
        const ownerLines = [
          ...baseScenarioLines(lockPath, functions),
          "$logPath = Join-Path (Split-Path -Parent $LockPath) 'owner.log'",
          claim,
          `Set-Content -LiteralPath '${ownerClaimedSignal.replace(/'/g, "''")}' -Value 'claimed' -Encoding ASCII`,
          "Start-Sleep -Milliseconds 1500",
          "if ($lockStream) { $lockStream.Unlock(0,1); $lockStream.Dispose() }",
          "'OWNER_RELEASED=true'",
        ];
        const ownerResult = await runVisualLockSimulationAsync(directory, ownerLines, "Run-AwardPingVisualSnapshots.ps1");
        const contenderResult = await contenderPromise;

        expect(ownerResult.status, `stdout=${ownerResult.stdout}\nstderr=${ownerResult.stderr}`).toBe(0);
        expect(ownerResult.stdout).toContain("OWNER_RELEASED=true");
        expect(contenderResult.status, `stdout=${contenderResult.stdout}\nstderr=${contenderResult.stderr}`).toBe(0);
        // The contender genuinely contended (explicit marker, not
        // inferred from timing) against a real, live, verified-matching
        // owner - and still fails closed rather than skipping silently:
        // content-based verification is never sufficient proof of who
        // holds the byte-range lock, even when the owner is completely
        // genuine.
        expect(contenderResult.stdout).toContain("OBSERVED_LOCK_CONTENTION=True");
        expect(contenderResult.stdout).toContain("PROPAGATED=");
        expect(contenderResult.stdout).toContain("Cannot verify who holds the AwardPing visual worker lock");
        expect(contenderResult.stdout).not.toContain("CLAIMED_SUCCESSFULLY=true");
        expect(contenderResult.stdout).not.toContain("AwardPing visual snapshot worker is already running. Skipping this launch.");

        // After the owner's real, confirmed release (awaited above), a
        // fresh, independent claim attempt against the same path must
        // succeed cleanly.
        const reclaimResult = runVisualLockSimulation(directory, [
          ...baseScenarioLines(lockPath, functions),
          "try {",
          claim,
          "  'RECLAIMED_AFTER_RELEASE=true'",
          "} catch {",
          "  'PROPAGATED=' + $_.Exception.Message",
          "}",
        ]);
        expect(reclaimResult.status, `stdout=${reclaimResult.stdout}`).toBe(0);
        expect(reclaimResult.stdout).toContain("RECLAIMED_AFTER_RELEASE=true");
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
    20_000,
  );

  windowsIt(
    "resolves a genuinely stale lock among many parallel contenders with exactly one claimant and every loser failing closed (never a silent skip), stressed across repeated rounds",
    async () => {
      const ROUNDS = 3;
      const CONTENDER_COUNT = 12;

      async function runRound(roundIndex) {
        const directory = mkdtempSync(join(tmpdir(), `awardping-visual-lock-r${roundIndex}-`));
        try {
          const lockPath = join(directory, "shard.lock");
          writeFileSync(lockPath, "pid=999999 started=2020-01-01T00:00:00Z stale=true", "utf8");
          const signalPath = join(directory, "start.signal");

          const promises = [];
          for (let i = 0; i < CONTENDER_COUNT; i++) {
            const contenderDir = join(directory, `contender-${i}`);
            mkdirSync(contenderDir, { recursive: true });
            const installRoot = join(contenderDir, "install");
            mkdirSync(installRoot, { recursive: true });
            const { functions, claim } = visualLockSnippets(installRoot);
            const lines = [
              ...baseScenarioLines(lockPath, functions),
              `$logPath = Join-Path (Split-Path -Parent $LockPath) 'c${i}.log'`,
              `while (-not (Test-Path -LiteralPath '${signalPath.replace(/'/g, "''")}')) { Start-Sleep -Milliseconds 5 }`,
              "try {",
              claim,
              "  'CLAIMED_SUCCESSFULLY=true'",
              "  Start-Sleep -Milliseconds 800",
              "  if ($lockStream) { $lockStream.Unlock(0,1); $lockStream.Dispose() }",
              "} catch {",
              "  'PROPAGATED=' + $_.Exception.Message",
              "}",
            ];
            promises.push(runVisualLockSimulationAsync(contenderDir, lines, "Run-AwardPingVisualSnapshots.ps1"));
          }

          await new Promise((r) => setTimeout(r, 1500));
          writeFileSync(signalPath, "go", "utf8");

          const results = await Promise.all(promises);
          const claimedCount = results.filter((r) => r.stdout.includes("CLAIMED_SUCCESSFULLY=true")).length;
          // Any "Skipping this launch." at all counts as a silent skip -
          // the byte-lock message and the legacy-preflight message alike.
          // Once one contender has claimed and written the real sentinel
          // format, a legacy misclassification of that content would show
          // up here as a bogus legacy skip.
          const skippedCount = results.filter((r) => r.stdout.includes("Skipping this launch.")).length;
          const legacySkippedCount = results.filter((r) => r.stdout.includes("(legacy lock)")).length;
          const propagatedCount = results.filter((r) => r.stdout.includes("PROPAGATED=")).length;
          const nonzeroCount = results.filter((r) => r.status !== 0).length;

          const fullDiagnostics = results
            .map((r, i) => `--- contender ${i} (status=${r.status}) ---\nSTDOUT:\n${r.stdout}\nSTDERR:\n${r.stderr}`)
            .join("\n");
          const summary = `round ${roundIndex}: claimed=${claimedCount} skipped=${skippedCount} legacySkipped=${legacySkippedCount} propagated=${propagatedCount} nonzero=${nonzeroCount}\n${fullDiagnostics}`;

          // Operational tradeoff, deliberate and explicit: content-based
          // verification can never prove who holds the byte-range lock,
          // so every losing contender here fails closed (Ambiguous)
          // rather than gracefully skipping - even though the winner is a
          // completely genuine, cooperating AwardPing launch. Exactly one
          // claimant, zero silent skips, zero unexpected PowerShell-level
          // crashes (the script's own try/catch converts the Ambiguous
          // throw into "PROPAGATED=", so nonzero here would indicate a
          // genuinely unexpected failure, not the expected fail-closed
          // outcome).
          expect(nonzeroCount, summary).toBe(0);
          expect(claimedCount, summary).toBe(1);
          expect(propagatedCount, summary).toBe(CONTENDER_COUNT - 1);
          expect(skippedCount, summary).toBe(0);
          expect(legacySkippedCount, summary).toBe(0);
          expect(existsSync(lockPath), summary).toBe(true);
        } finally {
          rmSync(directory, { recursive: true, force: true });
        }
      }

      for (let round = 0; round < ROUNDS; round++) {
        await runRound(round);
      }
    },
    180_000,
  );

  windowsIt(
    "exits the real generated top-level wrapper process itself with a nonzero code on a genuine external byte-lock collision",
    async () => {
      // Every other collision test pastes extracted snippets into a
      // harness script wrapped in its OWN try/catch, which proves the
      // production logic throws but never proves that an uncaught
      // exception actually propagates all the way out of the real,
      // complete, unmodified top-level Run-AwardPingVisualSnapshots.ps1 as
      // written to disk - a nonzero powershell.exe -File exit code, not
      // merely a harness-caught throw.
      const directory = mkdtempSync(join(tmpdir(), "awardping-visual-lock-"));
      try {
        const installRoot = join(directory, "install");
        // The generated script requires node.exe on PATH and a worker
        // script under app\scripts - neither is reached here, since the
        // lock collision happens before either is used, but the
        // preflight checks for both run first and must not themselves
        // throw first and mask the scenario under test.
        mkdirSync(join(installRoot, "app", "scripts"), { recursive: true });
        writeFileSync(join(installRoot, "app", "scripts", "capture-visual-snapshots.mjs"), "// placeholder\n", "utf8");
        visualLockSnippets(installRoot); // writes the real generated scripts
        const realScriptPath = join(installRoot, "Run-AwardPingVisualSnapshots.ps1");
        // Default $ShardCount = 1 -> this exact lock file name.
        const lockPath = join(installRoot, "visual-worker.lock");

        // A genuinely external holder: a SEPARATE powershell.exe process,
        // not a handle opened by this same test process.
        const holderScriptPath = join(directory, "holder.ps1");
        writeFileSync(
          holderScriptPath,
          [
            "$ErrorActionPreference = 'Stop'",
            `$p = '${lockPath.replace(/'/g, "''")}'`,
            "$s = [System.IO.FileStream]::new($p, [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::ReadWrite)",
            "$s.Lock(0, 1)",
            "Start-Sleep -Seconds 8",
            "$s.Unlock(0, 1)",
            "$s.Dispose()",
          ].join("\n"),
          "utf8",
        );
        const holder = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", holderScriptPath], {
          encoding: "utf8",
        });
        try {
          await new Promise((resolvePromise) => setTimeout(resolvePromise, 1500));

          // The real, complete, unmodified top-level script - invoked
          // exactly as it would be by the scheduler, not pasted into a
          // harness.
          const topLevelResult = spawnSync(
            "powershell.exe",
            ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", realScriptPath],
            { encoding: "utf8" },
          );

          expect(
            topLevelResult.status,
            `stdout=${topLevelResult.stdout}\nstderr=${topLevelResult.stderr}`,
          ).not.toBe(0);
          expect(topLevelResult.stdout + topLevelResult.stderr).toContain(
            "Cannot verify who holds the AwardPing visual worker lock",
          );
        } finally {
          // Wait for the holder to actually exit (and release its OS
          // handle) before the outer cleanup tries to remove the
          // directory - killing it does not by itself guarantee the
          // handle is gone yet.
          await new Promise((resolvePromise) => {
            holder.once("exit", () => resolvePromise());
            holder.kill();
          });
        }
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
    30_000,
  );

  // Both propagation paths the reviewer requires, run through the FULL
  // production preflight-plus-acquisition flow (not an isolated snippet
  // that bypasses it), so a regression that only shows up once
  // classification is folded in is not missed.
  function assertAcquisitionFailurePropagates(lockPathSetup) {
    const directory = mkdtempSync(join(tmpdir(), "awardping-visual-lock-"));
    try {
      const installRoot = join(directory, "install");
      mkdirSync(installRoot, { recursive: true });
      const { functions, claim } = visualLockSnippets(installRoot);
      const lockPath = lockPathSetup(directory);
      const lines = [
        ...baseScenarioLines(lockPath, functions),
        "$logPath = Join-Path (Split-Path -Parent $LockPath) 'first.log'",
        "try {",
        claim,
        "  'CLAIMED_SUCCESSFULLY=true'",
        "} catch {",
        "  'PROPAGATED=' + $_.Exception.Message",
        "}",
      ];
      const result = runVisualLockSimulation(directory, lines);

      expect(result.status, `stdout=${result.stdout}\nstderr=${result.stderr}`).toBe(0);
      expect(result.stdout).toContain("PROPAGATED=");
      expect(result.stdout).not.toContain("CLAIMED_SUCCESSFULLY=true");
      expect(result.stdout).not.toContain("AwardPing visual snapshot worker is already running. Skipping this launch.");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }

  windowsIt(
    "propagates an IOException whose native code is not a recognized contention code, instead of a benign skip",
    () => {
      // A missing parent directory makes the initial open throw
      // DirectoryNotFoundException (an IOException) with native code 3
      // (ERROR_PATH_NOT_FOUND), which is caught by its own typed clause
      // and rethrown directly - it must never be classified as
      // contention or Ambiguous.
      assertAcquisitionFailurePropagates((directory) =>
        join(directory, "missing-parent-directory", "shard.lock"),
      );
    },
  );

  windowsIt(
    "propagates the full production behavior for a directory sitting at the lock path, instead of a benign skip",
    () => {
      // A directory at the lock path fails the initial open with an
      // access-denied failure that is not an IOException, so no typed
      // catch intercepts it at all - verified here through the complete
      // claim, not an isolated acquisition-only snippet.
      assertAcquisitionFailurePropagates((directory) => {
        const lockPath = join(directory, "shard-as-directory.lock");
        mkdirSync(lockPath, { recursive: true });
        return lockPath;
      });
    },
  );

  windowsIt("keeps the principal but replaces a legacy trigger with the canonical trigger", () => {
    const restoreXmlFunction = extractPowerShellFunction(
      installer,
      "Get-AwardPingTaskRestoreXml",
      "Restore-AwardPingTasksAfterUpdate",
    );
    const simulation = [
      restoreXmlFunction,
      "$namespace = 'http://schemas.microsoft.com/windows/2004/02/mit/task'",
      "$old = '<Task xmlns=\"' + $namespace + '\"><Principals><Principal id=\"Author\"><UserId>OLD-PRINCIPAL</UserId></Principal></Principals><Triggers><CalendarTrigger><StartBoundary>2026-01-01T01:00:00</StartBoundary></CalendarTrigger></Triggers><Settings><Enabled>true</Enabled></Settings></Task>'",
      "$canonical = '<Task xmlns=\"' + $namespace + '\"><Principals><Principal id=\"Author\"><UserId>NEW-PRINCIPAL</UserId></Principal></Principals><Triggers><CalendarTrigger><StartBoundary>2026-01-01T18:00:00</StartBoundary></CalendarTrigger></Triggers><Settings><Enabled>true</Enabled></Settings></Task>'",
      "function Export-ScheduledTask { param($TaskName, $TaskPath, $ErrorAction); $canonical }",
      "$snapshot = [pscustomobject]@{ TaskName='AwardPing Visual Snapshot Worker Shard 1'; TaskPath='\\'; Xml=$old }",
      "[xml]$result = Get-AwardPingTaskRestoreXml -Snapshot $snapshot -ApplyTaskDefinitionUpdates $true",
      "$ns = [System.Xml.XmlNamespaceManager]::new($result.NameTable)",
      "$ns.AddNamespace('task', $result.DocumentElement.NamespaceURI)",
      "$principal = $result.SelectSingleNode('/task:Task/task:Principals/task:Principal/task:UserId', $ns).InnerText",
      "$trigger = $result.SelectSingleNode('/task:Task/task:Triggers/task:CalendarTrigger/task:StartBoundary', $ns).InnerText",
      "$enabled = $result.SelectSingleNode('/task:Task/task:Settings/task:Enabled', $ns).InnerText",
      "'PRINCIPAL=' + $principal + ' TRIGGER=' + $trigger + ' ENABLED=' + $enabled",
    ].join("\n");
    const result = runPowerShell(simulation);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "PRINCIPAL=OLD-PRINCIPAL TRIGGER=2026-01-01T18:00:00 ENABLED=false",
    );
  });

  windowsIt("rejects every noncanonical managed-task trigger before resume", () => {
    const validator = extractPowerShellFunction(
      installer,
      "Get-AwardPingManagedTaskScheduleProblems",
      "Get-AwardPingInstalledRuntimeProblems",
    );
    const simulation = [
      validator,
      "$script:root = 'C:\\AwardPingWorker'",
      "$script:badTask = ''",
      "$script:lanes = @{",
      "  'AwardPing New Page Review Lane'=@('new_page_review',0,10); 'AwardPing Changed Page Review Lane'=@('changed_page_review',2,10); 'AwardPing Feedback Promotion Lane'=@('feedback_promotion',4,6); 'AwardPing Suppression Lane'=@('suppression',6,6); 'AwardPing Reconciliation Lane'=@('reconciliation',8,6); 'AwardPing Page Audit Lane'=@('page_audit',10,6); 'AwardPing Manual Quarantine Lane'=@('manual_quarantine',12,4); 'AwardPing Nightly Report Lane'=@('nightly_report',14,4)",
      "}",
      "function Test-AwardPingTaskTargetsInstallRoot { param($Task,$InstallRoot); $true }",
      "function Get-ScheduledTask { param($TaskName,$ErrorAction); [pscustomobject]@{ TaskName=$TaskName; TaskPath='\\'; Actions=@() } }",
      "function Export-ScheduledTask {",
      "  param($TaskName,$TaskPath,$ErrorAction)",
      "  $ns = 'http://schemas.microsoft.com/windows/2004/02/mit/task'",
      "  if ($TaskName -like 'AwardPing Visual Snapshot Worker Shard *') {",
      "    $number = [int]($TaskName -replace '^.*Shard ', ''); $index = $number - 1; $hour = if ($TaskName -eq $script:badTask) { 17 } else { 18 }",
      "    $arguments = '-NoProfile -File \"' + $script:root + '\\Run-AwardPingVisualSnapshots.ps1\" -All -ShardCount 3 -ShardIndex ' + $index + ' -RunTrigger scheduled'",
      "    return '<Task xmlns=\"' + $ns + '\"><Triggers><CalendarTrigger><StartBoundary>2026-07-16T' + $hour.ToString('00') + ':00:00</StartBoundary><ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay></CalendarTrigger></Triggers><Actions><Exec><Command>powershell.exe</Command><Arguments>' + $arguments + '</Arguments></Exec></Actions></Task>'",
      "  }",
      "  $lane = $script:lanes[$TaskName]; $arguments = '-NoProfile -File \"' + $script:root + '\\Run-AwardPingDownstreamLane.ps1\" -InstallRoot \"' + $script:root + '\" -Lane ' + $lane[0] + ' -TimeoutMinutes ' + $lane[2]",
      "  return '<Task xmlns=\"' + $ns + '\"><Triggers><TimeTrigger><StartBoundary>2026-07-16T12:' + ([int]$lane[1]).ToString('00') + ':00</StartBoundary><Repetition><Interval>PT15M</Interval><Duration>P3650D</Duration></Repetition></TimeTrigger></Triggers><Actions><Exec><Command>powershell.exe</Command><Arguments>' + $arguments + '</Arguments></Exec></Actions></Task>'",
      "}",
      "$clean = @(Get-AwardPingManagedTaskScheduleProblems -InstallRoot $script:root)",
      "$script:badTask = 'AwardPing Visual Snapshot Worker Shard 2'",
      "$bad = @(Get-AwardPingManagedTaskScheduleProblems -InstallRoot $script:root)",
      "'CLEAN_COUNT=' + $clean.Count",
      "'BAD_COUNT=' + $bad.Count",
      "'BAD=' + ($bad -join ' | ')",
    ].join("\n");
    const result = runPowerShellCommand(simulation);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("CLEAN_COUNT=0");
    expect(result.stdout).toContain("BAD_COUNT=1");
    expect(result.stdout).toContain(
      "noncanonical visual trigger for AwardPing Visual Snapshot Worker Shard 2",
    );
  });

  windowsIt("never enables or starts a task whose XML registration failed", () => {
    const restoreFunction = extractPowerShellFunction(
      installer,
      "Restore-AwardPingTasksAfterUpdate",
      "Invoke-AwardPingTaskSetRollback",
    );
    const simulation = [
      restoreFunction,
      "function Write-Step { param([string]$Message) }",
      "function Get-AwardPingTaskRestoreXml { '<Task />' }",
      "$script:calls = @()",
      "function Register-ScheduledTask { $script:calls += 'register'; throw 'simulated registration failure' }",
      "function Enable-ScheduledTask { $script:calls += 'enable' }",
      "function Disable-ScheduledTask { $script:calls += 'disable' }",
      "function Start-ScheduledTask { $script:calls += 'start' }",
      "function Stop-ScheduledTask { $script:calls += 'stop' }",
      "$snapshot = [pscustomobject]@{ TaskName='AwardPing Test'; TaskPath='\\'; RestoreAfterUpdate=$true; WasEnabled=$true; WasRunning=$true }",
      "try { Restore-AwardPingTasksAfterUpdate -Snapshots @($snapshot) -ApplyTaskDefinitionUpdates $false -RestoreOperationalState $true } catch {}",
      "'CALLS=' + ($script:calls -join ',')",
    ].join("\n");
    const result = runPowerShell(simulation);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("CALLS=register,disable,stop");
    expect(result.stdout).not.toContain("enable");
    expect(result.stdout).not.toContain("start");
  });

  windowsIt("fails closed when a fixed task name belongs to another install root", () => {
    const scopeFunctions = [
      extractPowerShellFunction(
        installer,
        "Test-AwardPingTaskTargetsInstallRoot",
        "Get-AwardPingManagedTaskNames",
      ),
      extractPowerShellFunction(
        installer,
        "Get-AwardPingManagedTaskNames",
        "Get-AwardPingTaskSnapshotKey",
      ),
      extractPowerShellFunction(
        installer,
        "Assert-AwardPingManagedTaskRegistrationScope",
        "Get-AwardPingTaskSnapshotsForUpdate",
      ),
    ].join("\n");
    const simulation = [
      scopeFunctions,
      String.raw`function Get-ScheduledTask { param([string]$TaskName); [pscustomobject]@{ TaskName=$TaskName; TaskPath='\'; Actions=@([pscustomobject]@{ Execute='powershell.exe'; Arguments='-File "D:\OtherAwardPing\Run-AwardPing.ps1"' }) } }`,
      "try { Assert-AwardPingManagedTaskRegistrationScope -InstallRoot 'C:\\AwardPingWorker'; 'UNEXPECTED_SUCCESS' } catch { 'BLOCKED=' + $_.Exception.Message }",
    ].join("\n");
    const result = runPowerShell(simulation);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("BLOCKED=");
    expect(result.stdout).toContain("does not target this install root");
    expect(result.stdout).not.toContain("UNEXPECTED_SUCCESS");
  });

  windowsIt("removes only tasks created by a failed update", () => {
    const cleanupFunctions = [
      extractPowerShellFunction(
        installer,
        "Get-AwardPingManagedTaskNames",
        "Get-AwardPingTaskSnapshotKey",
      ),
      extractPowerShellFunction(
        installer,
        "Get-AwardPingTaskSnapshotKey",
        "Assert-AwardPingManagedTaskRegistrationScope",
      ),
      extractPowerShellFunction(
        installer,
        "Remove-NewAwardPingTasksAfterFailedUpdate",
        "Get-AwardPingRootedActionPaths",
      ),
    ].join("\n");
    const simulation = [
      cleanupFunctions,
      "function Test-AwardPingTaskTargetsInstallRoot { $true }",
      "$script:calls = @()",
      "function Get-ScheduledTask { @([pscustomobject]@{ TaskName='AwardPing Visual Snapshot Worker Shard 1'; TaskPath='\\' }, [pscustomobject]@{ TaskName='AwardPing New Page Review Lane'; TaskPath='\\' }, [pscustomobject]@{ TaskName='AwardPing Concurrent Custom Audit'; TaskPath='\\' }) }",
      "function Disable-ScheduledTask { param($TaskName, $TaskPath, $ErrorAction); $script:calls += 'disable:' + $TaskName }",
      "function Stop-ScheduledTask { param($TaskName, $TaskPath, $ErrorAction); $script:calls += 'stop:' + $TaskName }",
      "function Unregister-ScheduledTask { param($TaskName, $TaskPath, $Confirm, $ErrorAction); $script:calls += 'remove:' + $TaskName }",
      "$initial = [pscustomobject]@{ TaskName='AwardPing Visual Snapshot Worker Shard 1'; TaskPath='\\' }",
      "Remove-NewAwardPingTasksAfterFailedUpdate -InitialSnapshots @($initial) -InstallRoot 'C:\\AwardPingWorker'",
      "'CALLS=' + ($script:calls -join ',')",
    ].join("\n");
    const result = runPowerShell(simulation);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "CALLS=disable:AwardPing New Page Review Lane,stop:AwardPing New Page Review Lane,remove:AwardPing New Page Review Lane",
    );
    expect(result.stdout).not.toContain("AwardPing Concurrent Custom Audit");
  });

  windowsIt("carries the retired monolith enabled state into newly created lanes", () => {
    const finalizationFunctions = [
      extractPowerShellFunction(
        installer,
        "Get-AwardPingManagedTaskNames",
        "Get-AwardPingTaskSnapshotKey",
      ),
      extractPowerShellFunction(
        installer,
        "Get-AwardPingTaskSnapshotKey",
        "Assert-AwardPingManagedTaskRegistrationScope",
      ),
      extractPowerShellFunction(
        installer,
        "Get-AwardPingTaskSnapshotsForFinalization",
        "Get-InstalledAwardPingWorkerProcesses",
      ),
    ].join("\n");
    const simulation = [
      finalizationFunctions,
      "function Test-AwardPingTaskTargetsInstallRoot { $true }",
      "function Get-ScheduledTask { [pscustomobject]@{ TaskName='AwardPing New Page Review Lane'; TaskPath='\\' } }",
      "function Export-ScheduledTask { '<Task />' }",
      "$legacy = [pscustomobject]@{ TaskName='AwardPing Downstream Queue Pipeline'; TaskPath='\\'; WasEnabled=$false; RestoreAfterUpdate=$false }",
      "$migrated = @(Get-AwardPingTaskSnapshotsForFinalization -InitialSnapshots @($legacy) -InstallRoot 'C:\\AwardPingWorker' | Where-Object { $_.TaskName -eq 'AwardPing New Page Review Lane' })[0]",
      "$fresh = @(Get-AwardPingTaskSnapshotsForFinalization -InitialSnapshots @() -InstallRoot 'C:\\AwardPingWorker' | Where-Object { $_.TaskName -eq 'AwardPing New Page Review Lane' })[0]",
      "'MIGRATED=' + $migrated.WasEnabled + ' FRESH=' + $fresh.WasEnabled",
    ].join("\n");
    const result = runPowerShell(simulation);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("MIGRATED=False FRESH=True");
  });

  windowsIt("carries the retired visual snapshot worker's enabled state into newly created shards", () => {
    const finalizationFunctions = [
      extractPowerShellFunction(
        installer,
        "Get-AwardPingManagedTaskNames",
        "Get-AwardPingTaskSnapshotKey",
      ),
      extractPowerShellFunction(
        installer,
        "Get-AwardPingTaskSnapshotKey",
        "Assert-AwardPingManagedTaskRegistrationScope",
      ),
      extractPowerShellFunction(
        installer,
        "Get-AwardPingTaskSnapshotsForFinalization",
        "Get-InstalledAwardPingWorkerProcesses",
      ),
    ].join("\n");
    const simulation = [
      finalizationFunctions,
      "function Test-AwardPingTaskTargetsInstallRoot { $true }",
      "function Get-ScheduledTask { [pscustomobject]@{ TaskName='AwardPing Visual Snapshot Worker Shard 1'; TaskPath='\\' } }",
      "function Export-ScheduledTask { '<Task />' }",
      "$legacy = [pscustomobject]@{ TaskName='AwardPing Visual Snapshot Worker'; TaskPath='\\'; WasEnabled=$false; RestoreAfterUpdate=$false }",
      "$migrated = @(Get-AwardPingTaskSnapshotsForFinalization -InitialSnapshots @($legacy) -InstallRoot 'C:\\AwardPingWorker' | Where-Object { $_.TaskName -eq 'AwardPing Visual Snapshot Worker Shard 1' })[0]",
      "$fresh = @(Get-AwardPingTaskSnapshotsForFinalization -InitialSnapshots @() -InstallRoot 'C:\\AwardPingWorker' | Where-Object { $_.TaskName -eq 'AwardPing Visual Snapshot Worker Shard 1' })[0]",
      "'MIGRATED=' + $migrated.WasEnabled + ' FRESH=' + $fresh.WasEnabled",
    ].join("\n");
    const result = runPowerShell(simulation);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("MIGRATED=False FRESH=True");
  });

  windowsIt("restores the exact old app and root wrappers after a post-switch failure", () => {
    const rollbackFunctions = [
      extractPowerShellFunction(installer, "Switch-ToStagedAwardPingApp", "Get-AwardPingManagedRootRuntimeNames"),
      extractPowerShellFunction(installer, "Get-AwardPingManagedRootRuntimeNames", "New-AwardPingRootRuntimeSnapshot"),
      extractPowerShellFunction(installer, "New-AwardPingRootRuntimeSnapshot", "Restore-AwardPingRootRuntimeSnapshot"),
      extractPowerShellFunction(installer, "Restore-AwardPingRootRuntimeSnapshot", "Restore-AwardPingAppAfterFailedUpdate"),
      extractPowerShellFunction(installer, "Restore-AwardPingAppAfterFailedUpdate", "Write-EnvFile"),
    ].join("\n");
    const simulation = [
      rollbackFunctions,
      "function Remove-DirectoryWithRetry { param([string]$Path); Remove-Item -LiteralPath $Path -Recurse -Force -ErrorAction Stop }",
      "$root = Join-Path ([System.IO.Path]::GetTempPath()) ('awardping-installer-rollback-' + [guid]::NewGuid().ToString('N'))",
      "$app = Join-Path $root 'app'; $stage = Join-Path $root 'stage'; $backup = Join-Path $root 'backup'; $failed = Join-Path $root 'failed'; $snapshotPath = Join-Path $root 'runtime-snapshot'",
      "New-Item -ItemType Directory -Path $app,$stage -Force | Out-Null",
      "Set-Content -LiteralPath (Join-Path $app '.env.worker.local') -Value 'old-env'",
      "Set-Content -LiteralPath (Join-Path $app 'package.json') -Value '{\"version\":\"old\"}'",
      "Set-Content -LiteralPath (Join-Path $app 'generation.txt') -Value 'old-app'",
      "Set-Content -LiteralPath (Join-Path $stage '.env.worker.local') -Value 'new-env'",
      "Set-Content -LiteralPath (Join-Path $stage 'package.json') -Value '{\"version\":\"new\"}'",
      "Set-Content -LiteralPath (Join-Path $stage 'generation.txt') -Value 'new-app'",
      "Set-Content -LiteralPath (Join-Path $root 'Run-AwardPingVisualSnapshots.ps1') -Value 'old-wrapper'",
      "$snapshot = New-AwardPingRootRuntimeSnapshot -InstallRoot $root -SnapshotDirectory $snapshotPath",
      "Switch-ToStagedAwardPingApp -CurrentAppDir $app -StagingAppDir $stage -BackupAppDir $backup",
      "Set-Content -LiteralPath (Join-Path $root 'Run-AwardPingVisualSnapshots.ps1') -Value 'new-wrapper'",
      "Set-Content -LiteralPath (Join-Path $root 'Show-AwardPingVisualStatus.ps1') -Value 'new-only-wrapper'",
      "Restore-AwardPingAppAfterFailedUpdate -CurrentAppDir $app -BackupAppDir $backup -FailedAppDir $failed",
      "Restore-AwardPingRootRuntimeSnapshot -InstallRoot $root -Snapshot $snapshot -Token 'test'",
      "'APP=' + (Get-Content -LiteralPath (Join-Path $app 'generation.txt') -Raw).Trim()",
      "'WRAPPER=' + (Get-Content -LiteralPath (Join-Path $root 'Run-AwardPingVisualSnapshots.ps1') -Raw).Trim()",
      "'NEW_ONLY_EXISTS=' + (Test-Path -LiteralPath (Join-Path $root 'Show-AwardPingVisualStatus.ps1'))",
      "Remove-Item -LiteralPath $root -Recurse -Force",
    ].join("\n");
    const result = runPowerShell(simulation);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("APP=old-app");
    expect(result.stdout).toContain("WRAPPER=old-wrapper");
    expect(result.stdout).toContain("NEW_ONLY_EXISTS=False");
  });

  windowsIt("validates a complete root snapshot before changing any wrapper", () => {
    const rollbackFunctions = [
      extractPowerShellFunction(installer, "Get-AwardPingManagedRootRuntimeNames", "New-AwardPingRootRuntimeSnapshot"),
      extractPowerShellFunction(installer, "New-AwardPingRootRuntimeSnapshot", "Restore-AwardPingRootRuntimeSnapshot"),
      extractPowerShellFunction(installer, "Restore-AwardPingRootRuntimeSnapshot", "Restore-AwardPingAppAfterFailedUpdate"),
    ].join("\n");
    const simulation = [
      rollbackFunctions,
      "$root = Join-Path ([System.IO.Path]::GetTempPath()) ('awardping-wrapper-failclosed-' + [guid]::NewGuid().ToString('N'))",
      "$snapshotPath = Join-Path $root 'snapshot'; New-Item -ItemType Directory -Path $root -Force | Out-Null",
      "$wrapper = Join-Path $root 'Run-AwardPingVisualSnapshots.ps1'; Set-Content -LiteralPath $wrapper -Value 'old-wrapper'",
      "$snapshot = New-AwardPingRootRuntimeSnapshot -InstallRoot $root -SnapshotDirectory $snapshotPath",
      "Set-Content -LiteralPath $wrapper -Value 'new-wrapper'",
      "$entry = @($snapshot.Entries | Where-Object { $_.Name -eq 'Run-AwardPingVisualSnapshots.ps1' })[0]",
      "Set-Content -LiteralPath $entry.SnapshotPath -Value 'corrupt-snapshot'",
      "try { Restore-AwardPingRootRuntimeSnapshot -InstallRoot $root -Snapshot $snapshot -Token 'test'; 'UNEXPECTED_SUCCESS' } catch { 'BLOCKED=' + $_.Exception.Message }",
      "'CURRENT=' + (Get-Content -LiteralPath $wrapper -Raw).Trim()",
      "Remove-Item -LiteralPath $root -Recurse -Force",
    ].join("\n");
    const result = runPowerShell(simulation);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("BLOCKED=");
    expect(result.stdout).toContain("CURRENT=new-wrapper");
    expect(result.stdout).not.toContain("UNEXPECTED_SUCCESS");
  });

  it("registers every permanent task disabled until fresh-install or update validation commits", () => {
    expect(installer).toContain("Register-VisualSnapshotTask -InstallRoot $InstallRoot -RegisterDisabled $true");
    expect(installer).toContain("Register-DownstreamLaneTasks `");
    expect(installer).toContain("-RegisterDisabled $true");
    expect(installer).toContain("if ($RegisterDisabled) { $settings.Enabled = $false }");
    expect(downstream).not.toContain("Register-ScheduledTask");
    expect(installer).not.toContain("Register-DownstreamQueuePipeline");
    expect(installer).toContain(
      '[string]$_.TaskName -eq "AwardPing Downstream Queue Pipeline"',
    );
    expect(installer).toContain("WasEnabled = $wasEnabled");
  });

  it("runs the optional capture/R2 smoke test before recurring tasks can be enabled", () => {
    const mainStart = installer.indexOf("$packageRoot = Resolve-Path");
    const registrationIndex = installer.indexOf(
      "Register-DownstreamLaneTasks `",
      mainStart,
    );
    const smokeIndex = installer.indexOf(
      'Write-Step "Running one-page visual snapshot test before enabling recurring tasks"',
      registrationIndex,
    );
    const restoreIndex = installer.indexOf(
      "Restore-AwardPingTasksAfterUpdate `",
      smokeIndex,
    );
    const outerCatchIndex = installer.indexOf("} catch {", restoreIndex);

    expect(registrationIndex).toBeGreaterThan(mainStart);
    expect(smokeIndex).toBeGreaterThan(registrationIndex);
    expect(restoreIndex).toBeGreaterThan(smokeIndex);
    expect(outerCatchIndex).toBeGreaterThan(restoreIndex);
    expect(installer).toContain(
      "The one-page visual snapshot test failed while recurring tasks were disabled.",
    );
    expect(
      installer.split("Running one-page visual snapshot test before enabling recurring tasks")
        .length - 1,
    ).toBe(1);
  });

  it("retires catch-up watchdogs and the startup supervisor from the permanent task set", () => {
    expect(existsSync(startupSupervisorPath)).toBe(false);
    expect(installer).not.toContain("Register-BaselineFactsWatchdog -InstallRoot");
    expect(installer).not.toContain("Register-StartupSupervisorTask -InstallRoot");
    const cleanup = extractPowerShellFunction(
      installer,
      "Remove-LegacySourceTask",
      "Get-AwardPingRetiredArtifactProblems",
    );
    const retirementValidation = extractPowerShellFunction(
      installer,
      "Get-AwardPingRetiredArtifactProblems",
      "Register-VisualSnapshotTask",
    );
    const retiredArtifacts = extractPowerShellFunction(
      installer,
      "Get-AwardPingRetiredArtifactRelativePaths",
      "Remove-LegacySourceTask",
    );
    expect(cleanup).toContain('[string]$_.TaskName -like "AwardPing*"');
    expect(cleanup).toContain('[string]$_.TaskName -notin $managedTaskNames');
    expect(cleanup).toContain("Get-AwardPingRetiredArtifactRelativePaths");
    expect(cleanup).toContain("Remove-Item -LiteralPath $legacyPath -Force -ErrorAction Stop");
    expect(cleanup).toContain('"AwardPing Startup Supervisor.vbs"');
    expect(retiredArtifacts).toContain('"Start-AwardPingOnBoot.ps1"');
    expect(retirementValidation).toContain('[string]$_.TaskName -notin $managedTaskNames');
    expect(retirementValidation).toContain("Get-AwardPingRetiredArtifactRelativePaths");
    expect(installer).toContain('"app\\scripts\\run-local-source-worker.mjs"');
    expect(installer).toContain('"Watch-AwardPingBaselineCompletion.ps1"');
    expect(installer).toContain('"baseline-facts-worker.lock"');
    expect(installer).toContain('"Run-AwardPingDownstreamQueues.ps1"');
    expect(installer).toContain('"downstream-queue-pipeline.lock"');
    const managedTaskNames = extractPowerShellFunction(
      installer,
      "Get-AwardPingManagedTaskNames",
      "Get-AwardPingTaskSnapshotKey",
    );
    expect(managedTaskNames).not.toContain("AwardPing Downstream Queue Pipeline");
    expect(installer).toContain("RestoreAfterUpdate = [string]$task.TaskName -in @(Get-AwardPingManagedTaskNames)");
    expect(installer).toContain("Retired AwardPing artifacts remain after cleanup");
    expect(installer).toContain("retired-artifact cleanup was incomplete");
    expect(installer).toContain("$strictRetirementCommitted = $true");
    expect(installer).toContain(
      "-TaskSnapshots @($finalizationSnapshots | Where-Object { $_.RestoreAfterUpdate })",
    );
    const registrationScope = extractPowerShellFunction(
      installer,
      "Assert-AwardPingManagedTaskRegistrationScope",
      "Suspend-AwardPingStartupLauncherForUpdate",
    );
    const startupSuspend = extractPowerShellFunction(
      installer,
      "Suspend-AwardPingStartupLauncherForUpdate",
      "Complete-AwardPingStartupLauncherUpdate",
    );
    expect(registrationScope).not.toContain("AwardPing Startup Supervisor.vbs");
    expect(startupSuspend).toContain('launcherContent.IndexOf("$normalizedRoot\\"');
    expect(startupSuspend.indexOf("return [pscustomobject]@{ WasPresent = $false")).toBeLessThan(
      startupSuspend.indexOf("Move-Item -LiteralPath $originalPath"),
    );
  });

  it("validates installed wrappers, action targets, app scripts, and dependencies before resume", () => {
    expect(installer).toContain("Get-AwardPingInstalledRuntimeProblems");
    expect(installer).toContain(
      "Get-AwardPingManagedTaskScheduleProblems -InstallRoot $InstallRoot",
    );
    expect(installer).toContain("noncanonical trigger count");
    expect(installer).toContain("noncanonical lane trigger");
    expect(installer).toContain("noncanonical visual trigger");
    expect(installer).toContain("Get-AwardPingRootedActionPaths");
    expect(installer).toContain("invalid PowerShell action script");
    expect(installer).toContain("missing action/runtime path");
    expect(installer).toContain("missing worker runtime dependency");
    expect(installer).toContain("installed runtime hash mismatch");
    const validationIndex = installer.indexOf("$runtimeProblems = @(");
    const restoreIndex = installer.indexOf(
      "Restore-AwardPingTasksAfterUpdate",
      validationIndex,
    );
    expect(validationIndex).toBeGreaterThan(0);
    expect(restoreIndex).toBeGreaterThan(validationIndex);
  });

  it("validates the immutable visual-evidence runtime closure and native crop dependency", () => {
    for (const relativePath of [
      "scripts\\lib\\expansion-state-descriptor-canonicalization.mjs",
      "scripts\\lib\\expansion-state-isolation.mjs",
      "scripts\\lib\\visible-text-geometry.mjs",
      "scripts\\lib\\visual-event-localization.mjs",
      "scripts\\lib\\visual-snapshot-history.mjs",
      "scripts\\lib\\visual-review-queue.mjs",
      "scripts\\lib\\visual-baseline-promotion.mjs",
      "scripts\\lib\\visual-change-publication.mjs",
      "scripts\\lib\\visual-event-evidence.mjs",
      "scripts\\read-event-visual-evidence-coverage.mjs",
      "scripts\\lib\\event-visual-evidence-coverage.mjs",
      "scripts\\backfill-visual-event-evidence.mjs",
      "scripts\\lib\\visual-event-evidence-backfill.mjs",
      "scripts\\lib\\snapshot-localization.mjs",
      "scripts\\lib\\monitoring-promotion-matcher-bundle.mjs",
      "scripts\\sync-manual-quarantine-registry.mjs",
      "scripts\\lib\\manual-quarantine.mjs",
      "scripts\\lib\\award-monitoring-policy.mjs",
      "scripts\\lib\\change-event-sweep-state.mjs",
      "scripts\\lib\\admin-review-state-guard.mjs",
      "scripts\\lib\\source-quality.mjs",
      "scripts\\lib\\source-ai-review-status.mjs",
      "src\\lib\\change-event-suppression.ts",
      "src\\lib\\award-monitoring-policy.ts",
      "src\\lib\\source-quality.ts",
      "src\\lib\\source-ai-review-status.ts",
      "src\\lib\\source-url-policy.ts",
      "scripts\\supabase-service-client.mjs",
      "scripts\\run-downstream-lane.mjs",
      "scripts\\process-new-page-review-lane.mjs",
      "scripts\\lib\\gemini-spend-ledger.mjs",
      "scripts\\lib\\gemini-batch-support.mjs",
      "scripts\\lib\\paid-visual-review-policy.mjs",
      "scripts\\lib\\r2-baseline-rehydration.mjs",
      "scripts\\lib\\legacy-r2-retained-projection-provenance.mjs",
      "scripts\\lib\\r2-capture-artifact-bindings.mjs",
      "scripts\\lib\\local-baseline-evidence.mjs",
      "scripts\\lib\\award-fact-reconciliation.mjs",
      "scripts\\lib\\source-backfill-intake.mjs",
      "scripts\\lib\\source-intake.mjs",
      "scripts\\lib\\source-intake-provider-binding.mjs",
      "scripts\\lib\\initial-document-recovery.mjs",
      "scripts\\lib\\stage1-baseline-activation-guard.mjs",
      "scripts\\lib\\stage1-baseline-source-disposition.mjs",
      "scripts\\lib\\stage1-evidence-schema-upgrade.mjs",
      "scripts\\lib\\stage1-evidence-schema-upgrade-validation.mjs",
      "scripts\\lib\\stage1-evidence-schema-upgrade-reviewed-apply-plan.mjs",
      "scripts\\lib\\stage1-evidence-schema-upgrade-reviewed-apply-audit.mjs",
      "scripts\\lib\\stage1-evidence-schema-upgrade-completed-authority.mjs",
      "scripts\\lib\\stage1-evidence-schema-upgrade-reviewed-apply-execution.mjs",
      "scripts\\lib\\stage1-evidence-schema-upgrade-reviewed-source-authority.mjs",
      "scripts\\lib\\stage1-evidence-schema-upgrade-reviewed-recovery-plan.mjs",
      "scripts\\lib\\stage1-evidence-schema-upgrade-reviewed-recovery-execution.mjs",
      "scripts\\lib\\stage1-evidence-schema-upgrade-reviewed-recovery-worker.mjs",
      "scripts\\lib\\stage1-evidence-schema-upgrade-reviewed-recovery-runtime.mjs",
      "scripts\\stage1-evidence-schema-upgrade-reviewed-recovery.mjs",
      "scripts\\lib\\stage1-evidence-schema-upgrade-schwarzman-pdf-recovery.mjs",
      "scripts\\lib\\stage1-evidence-schema-upgrade-beinecke-faq-legacy-geometry.mjs",
      "scripts\\lib\\stage1-evidence-schema-upgrade-pre-1fc005c-legacy-geometry.mjs",
      "scripts\\lib\\stage1-evidence-schema-upgrade-legacy-empty-expansion.mjs",
      "scripts\\lib\\stage1-evidence-schema-upgrade-transaction.mjs",
      "scripts\\lib\\stage1-evidence-schema-upgrade-commit.mjs",
      "scripts\\lib\\stage1-evidence-schema-upgrade-mutation-accounting.mjs",
      "scripts\\lib\\stage1-evidence-schema-upgrade-r2-binding.mjs",
      "scripts\\lib\\stage1-evidence-schema-upgrade-quarantine.mjs",
      "scripts\\lib\\visual-snapshot-latest-only-reconciliation.mjs",
      "scripts\\lib\\visual-snapshot-pointer-reconciliation.mjs",
      "scripts\\lib\\visual-baseline-retained-projection-identity.mjs",
      "scripts\\evaluate-public-page-audit-canaries.mjs",
    ]) {
      expect(installer.split(`"${relativePath}"`).length - 1).toBeGreaterThanOrEqual(2);
    }
    expect(installer).toContain('"sharp",');
  });

  it("hash-validates every Stage 1, reconciliation, and source-backfill runtime dependency", () => {
    const runtimeValidation = extractPowerShellFunction(
      installer,
      "Get-AwardPingInstalledRuntimeProblems",
      "Get-AwardPingTaskRestoreXml",
    );
    const hashPairStart = runtimeValidation.indexOf("$hashPairs = @()");
    expect(hashPairStart).toBeGreaterThan(0);
    const requiredPathValidation = runtimeValidation.slice(0, hashPairStart);
    const hashPairValidation = runtimeValidation.slice(hashPairStart);

    for (const relativePath of [
      "scripts\\lib\\stage1-baseline-activation-guard.mjs",
      "scripts\\lib\\stage1-baseline-source-disposition.mjs",
      "scripts\\lib\\stage1-evidence-schema-upgrade.mjs",
      "scripts\\lib\\stage1-evidence-schema-upgrade-validation.mjs",
      "scripts\\lib\\stage1-evidence-schema-upgrade-reviewed-apply-plan.mjs",
      "scripts\\lib\\stage1-evidence-schema-upgrade-reviewed-apply-audit.mjs",
      "scripts\\lib\\stage1-evidence-schema-upgrade-completed-authority.mjs",
      "scripts\\lib\\stage1-evidence-schema-upgrade-reviewed-apply-execution.mjs",
      "scripts\\lib\\stage1-evidence-schema-upgrade-reviewed-source-authority.mjs",
      "scripts\\lib\\stage1-evidence-schema-upgrade-reviewed-recovery-plan.mjs",
      "scripts\\lib\\stage1-evidence-schema-upgrade-reviewed-recovery-execution.mjs",
      "scripts\\lib\\stage1-evidence-schema-upgrade-reviewed-recovery-worker.mjs",
      "scripts\\lib\\stage1-evidence-schema-upgrade-reviewed-recovery-runtime.mjs",
      "scripts\\stage1-evidence-schema-upgrade-reviewed-recovery.mjs",
      "scripts\\lib\\stage1-evidence-schema-upgrade-schwarzman-pdf-recovery.mjs",
      "scripts\\lib\\stage1-evidence-schema-upgrade-beinecke-faq-legacy-geometry.mjs",
      "scripts\\lib\\stage1-evidence-schema-upgrade-pre-1fc005c-legacy-geometry.mjs",
      "scripts\\lib\\stage1-evidence-schema-upgrade-legacy-empty-expansion.mjs",
      "scripts\\lib\\stage1-evidence-schema-upgrade-transaction.mjs",
      "scripts\\lib\\stage1-evidence-schema-upgrade-commit.mjs",
      "scripts\\lib\\stage1-evidence-schema-upgrade-mutation-accounting.mjs",
      "scripts\\lib\\stage1-evidence-schema-upgrade-r2-binding.mjs",
      "scripts\\lib\\stage1-evidence-schema-upgrade-quarantine.mjs",
      "scripts\\lib\\visual-snapshot-latest-only-reconciliation.mjs",
      "scripts\\lib\\award-fact-reconciliation.mjs",
      "scripts\\lib\\source-backfill-intake.mjs",
      "scripts\\lib\\source-intake-provider-binding.mjs",
    ]) {
      expect(requiredPathValidation).toContain(`"${relativePath}"`);
      expect(hashPairValidation).toContain(`"${relativePath}"`);
    }
  });

  windowsIt("removes inherited and unrelated access from the worker secret file", () => {
    const aclFunctions = installer.slice(
      installer.indexOf("function ConvertTo-AwardPingSecurityIdentifier {"),
      installer.indexOf("\nfunction Get-AwardPingSourceRevision {"),
    );
    const simulation = [
      aclFunctions,
      "$path = Join-Path ([System.IO.Path]::GetTempPath()) ('awardping-worker-env-acl-' + [guid]::NewGuid().ToString('N'))",
      "try {",
      "  Set-Content -LiteralPath $path -Value 'SUPABASE_SERVICE_ROLE_KEY=not-a-real-secret'",
      "  $acl = Get-Acl -LiteralPath $path",
      "  $everyone = [System.Security.Principal.SecurityIdentifier]::new('S-1-1-0')",
      "  $unapprovedRule = [System.Security.AccessControl.FileSystemAccessRule]::new($everyone, [System.Security.AccessControl.FileSystemRights]::ReadAndExecute, [System.Security.AccessControl.AccessControlType]::Allow)",
      "  [void]$acl.AddAccessRule($unapprovedRule)",
      "  Set-Acl -LiteralPath $path -AclObject $acl",
      "  Set-AwardPingWorkerEnvFileAcl -Path $path -TaskSnapshots @()",
      "  $secured = Get-Acl -LiteralPath $path",
      "  $rules = @($secured.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))",
      "  $everyoneRules = @($rules | Where-Object { $_.IdentityReference.Value -eq 'S-1-1-0' })",
      "  $problems = @(Get-AwardPingWorkerEnvAclProblems -Path $path -TaskSnapshots @())",
      "  'PROTECTED=' + $secured.AreAccessRulesProtected + ' EVERYONE=' + $everyoneRules.Count + ' PROBLEMS=' + $problems.Count",
      "} finally {",
      "  Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue",
      "}",
    ].join("\n");

    const directory = mkdtempSync(join(tmpdir(), "awardping-worker-acl-test-"));
    const scriptPath = join(directory, "verify-acl.ps1");
    writeFileSync(scriptPath, simulation, "utf8");
    try {
      const result = spawnSync(
        "powershell.exe",
        ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
        { encoding: "utf8" },
      );
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("PROTECTED=True EVERYONE=0 PROBLEMS=0");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
    expect(installer).toContain(
      "Get-AwardPingWorkerEnvAclProblems -Path $Path -TaskSnapshots $TaskSnapshots",
    );
  });

  it("makes interactive-only task reliability an explicit durable acceptance", () => {
    expect(installer).toContain("[switch]$AcceptInteractiveTaskLogon");
    expect(installer).toContain("worker-operational-mode.json");
    expect(installer).toContain('operational_mode = "interactive_logon_required"');
    expect(installer).toContain("-AcceptInteractiveTaskLogon only after explicitly accepting");
    expect(installer).toContain(
      "interactive Scheduled Tasks lack a documented logged-in-operator acceptance",
    );
    expect(installerDocs).toContain("cannot run after the operator signs out");
    expect(installerDocs).toContain("-AcceptInteractiveTaskLogon");
    expect(installerDocs).toMatch(/not a\s+claim of logged-off unattended service/);
  });

  windowsIt("rejects an operational acceptance marker with an unapproved reader", () => {
    const acceptanceFunctions = installer.slice(
      installer.indexOf("function Test-AwardPingInteractiveLogonAcceptance {"),
      installer.indexOf("\nfunction Get-AwardPingTaskSnapshotKey {"),
    );
    const aclFunctions = installer.slice(
      installer.indexOf("function ConvertTo-AwardPingSecurityIdentifier {"),
      installer.indexOf("\nfunction Get-AwardPingSourceRevision {"),
    );
    const simulation = [
      aclFunctions,
      acceptanceFunctions,
      "$root = Join-Path ([System.IO.Path]::GetTempPath()) ('awardping-worker-mode-' + [guid]::NewGuid().ToString('N'))",
      "try {",
      "  New-Item -ItemType Directory -Path $root -Force | Out-Null",
      "  Write-AwardPingInteractiveLogonAcceptance -InstallRoot $root -SourceRevision ('a' * 40)",
      "  $validBefore = Test-AwardPingInteractiveLogonAcceptance -InstallRoot $root",
      "  $path = Join-Path $root 'worker-operational-mode.json'",
      "  & icacls.exe $path /grant '*S-1-1-0:(R)' | Out-Null",
      "  if ($LASTEXITCODE -ne 0) { throw 'Could not add the test-only unapproved ACL entry.' }",
      "  $validAfter = Test-AwardPingInteractiveLogonAcceptance -InstallRoot $root",
      "  'BEFORE=' + $validBefore + ' AFTER=' + $validAfter",
      "} finally {",
      "  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue",
      "}",
    ].join("\n");
    const directory = mkdtempSync(join(tmpdir(), "awardping-worker-mode-test-"));
    const scriptPath = join(directory, "verify-mode.ps1");
    writeFileSync(scriptPath, simulation, "utf8");
    try {
      const result = spawnSync(
        "powershell.exe",
        ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
        { encoding: "utf8" },
      );
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("BEFORE=True AFTER=False");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  windowsIt("requires a complete syntactically valid R2 configuration before tasks resume", () => {
    const validator = extractPowerShellFunction(
      installer,
      "Test-R2WorkerConfiguration",
      "Read-R2WorkerConfiguration",
    );
    const result = runPowerShell([
      validator,
      "$blank = Test-R2WorkerConfiguration -Bucket 'awardping-snapshots' -AccountId '' -Endpoint '' -AccessKeyId '' -SecretAccessKey ''",
      "$badEndpoint = Test-R2WorkerConfiguration -Bucket 'awardping-snapshots' -AccountId '' -Endpoint 'http://example.test' -AccessKeyId 'key' -SecretAccessKey 'secret'",
      "$valid = Test-R2WorkerConfiguration -Bucket 'awardping-snapshots' -AccountId ('a' * 32) -Endpoint '' -AccessKeyId 'key' -SecretAccessKey 'secret'",
      'Write-Output "BLANK=$($blank.Ok) BAD_ENDPOINT=$($badEndpoint.Ok) VALID=$($valid.Ok)"',
    ].join("\n"));

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("BLANK=False BAD_ENDPOINT=False VALID=True");
    expect(installer).toContain("$r2Configuration = Read-R2WorkerConfiguration");
    expect(installer).toContain("invalid worker R2 configuration");
    expect(installer).toContain('Read-WorkerEnvValues -Path $workerEnvPath');
    expect(installer).toContain("Copy-AwardPingMutableAppState -CurrentAppDir $appDir -StagingAppDir $stagingAppDir");
    expect(installer).not.toContain("Update-only mode: enter R2");
  });

  it("limits forced process shutdown to command lines rooted in the installed worker", () => {
    expect(installer).toContain("Get-InstalledAwardPingWorkerProcesses");
    expect(installer).toContain("$normalizedRoot\\app\\scripts\\");
    expect(installer).toContain("$normalizedRoot\\Run-AwardPing");
    expect(installer).toContain("Stop-Process -Id $process.ProcessId -Force");
    expect(installer).not.toMatch(/Get-Process[^\n|]*\|[^\n]*Stop-Process/i);
    expect(installer).toContain('$rootPrefix = "$normalizedRoot\\"');
    expect(installer).toContain("Test-AwardPingTaskTargetsInstallRoot -Task $_ -InstallRoot $InstallRoot");
    expect(installer).toContain("Unregister-ScheduledTask -TaskName $task.TaskName -TaskPath $taskPath");
  });

  it("installs eight isolated downstream lanes with bounded locks, stagger, and timeouts", () => {
    const registrationStart = installer.indexOf("function Register-DownstreamLaneTasks {");
    const registrationEnd = installer.indexOf("\n$packageRoot = Resolve-Path", registrationStart);
    const registration = installer.slice(registrationStart, registrationEnd);
    expect(registrationStart).toBeGreaterThan(0);
    expect(registrationEnd).toBeGreaterThan(registrationStart);
    const definitions = [
      ["new_page_review", "AwardPing New Page Review Lane", 0, 10, 12],
      ["changed_page_review", "AwardPing Changed Page Review Lane", 2, 10, 12],
      ["feedback_promotion", "AwardPing Feedback Promotion Lane", 4, 6, 8],
      ["suppression", "AwardPing Suppression Lane", 6, 6, 8],
      ["reconciliation", "AwardPing Reconciliation Lane", 8, 6, 8],
      ["page_audit", "AwardPing Page Audit Lane", 10, 6, 8],
      ["manual_quarantine", "AwardPing Manual Quarantine Lane", 12, 4, 6],
      ["nightly_report", "AwardPing Nightly Report Lane", 14, 4, 6],
    ];

    for (const [key, taskName, stagger, timeout, taskTimeout] of definitions) {
      expect(registration).toContain(
        `Key = "${key}"; TaskName = "${taskName}"; StaggerMinutes = ${stagger}; TimeoutMinutes = ${timeout}; ExecutionTimeLimitMinutes = ${taskTimeout}`,
      );
      expect(installer.split(`"${taskName}"`).length - 1).toBeGreaterThanOrEqual(3);
    }
    expect(registration).toContain("-RepetitionInterval (New-TimeSpan -Minutes 15)");
    expect(registration).toContain("$quarterStartMinute");
    expect(registration).toContain("-TimeoutMinutes $($lane.TimeoutMinutes)");
    expect(registration).toContain("-ExecutionTimeLimit (New-TimeSpan -Minutes $lane.ExecutionTimeLimitMinutes)");
    expect(registration).toContain("This lane never submits pages to Gemini.");

    expect(downstream).toContain('$LockPath = Join-Path $InstallRoot "downstream-lane-$Lane.lock"');
    expect(downstream).toContain("[System.IO.FileMode]::CreateNew");
    expect(downstream).toContain("[System.IO.FileShare]::None");
    expect(downstream).toContain('scripts\\run-downstream-lane.mjs');
    expect(downstream).toContain('"--lane=$Lane"');
    expect(downstream).toContain('"--time-budget-ms=$timeBudgetMs"');
    expect(downstream).toContain("$process.WaitForExit($TimeoutMinutes * 60 * 1000)");
    expect(downstream).toContain("$processHandle = $process.Handle");
    expect(downstream).toContain("$process.Refresh()");
    expect(downstream).toContain("$exitCode = [int]$process.ExitCode");
    expect(downstream).toContain("taskkill.exe");
    expect(downstream).toContain("exit $exitCode");

    expect(downstreamLaneRunner).toContain("page_audit:");
    expect(downstreamLaneRunner).toContain('script: "scripts/evaluate-public-page-audit-canaries.mjs"');
    expect(downstreamLaneRunner).not.toMatch(
      /page_audit:\s*{[\s\S]*?script:\s*"scripts\/process-page-audit-batch\.mjs"/,
    );
    expect(sourceIntakeWorker).toContain('positiveInt(args["poll-batch-limit"], 25)');
    expect(sourceIntakeWorker).toContain('positiveInt(args["time-budget-ms"], 15 * 60_000)');
    expect(sourceIntakeWorker).toContain(': ["pending", "queued"];');
    expect(sourceIntakeWorker).toContain('.slice(0, pollBatchLimit)');
    expect(sourceIntakeWorker).toContain('if (!hasTimeBudget("reconcile")) break;');
    expect(sourceIntakeWorker).toContain('time_budget_exhausted: report.time_budget_exhausted');
    expect(sourceIntakeWorker).toContain('if (isTimeBudgetExhaustion(error))');
    expect(sourceIntakeWorker).toContain('deadlineLimited && isAbortTimeout(error)');
    expect(sourceIntakeWorker).toContain('void finishHardBudgetStop();');
    expect(sourceIntakeWorker).toContain('async function finishHardBudgetStop()');
    expect(sourceIntakeWorker).toContain('stale_matching_failed_closed_operator_retry_required');
    expect(sourceIntakeWorker).toContain('await touchSubmittedBatchRows(batchName)');
    expect(sourceIntakeWorker).toContain('Source intake capture only accepts pending or queued requests.');
    expect(maintenanceRunner).toContain('"--status=pending,queued"');
    expect(maintenanceRunner).not.toContain('"--status=pending,queued,failed"');
    expect(sourceIntakeWorker).toContain('async function claimIdleRequest(row)');
    expect(sourceIntakeWorker).toContain('query = withObservedUpdatedAt(query, row.updated_at)');
    expect(sourceIntakeWorker).toContain('async function claimSubmittedResponse(row, batchName)');
    expect(sourceIntakeWorker).toContain('extractGeminiBatchInlineResponses(job)');
    expect(sourceIntakeWorker).toContain('geminiBatchInlineResponseMap(');
    expect(sourceIntakeWorker).toContain('geminiInlineError(responseItem)');
    expect(sourceIntakeWorker).not.toContain('job?.response?.responses || job?.metadata?.responses');
    expect(sourceIntakeWorker).toContain('.eq("worker_run_id", workerRunId)');
    expect(sourceIntakeWorker).toContain('if (!apply) return;\n  const { error } = await supabase');
    expect(sourceIntakeWorker).toContain('report.errors.length || report.failed > 0 || report.submission_claims_lost_after_batch_create > 0');
    expect(captureWorker).toContain('acquireFileLock(join(reportDir, "visual-nightly-report.lock"))');
    expect(nightlyReporter).toContain('acquireFileLock(join(reportDir, "visual-nightly-report.lock"))');
  });

  windowsIt("preserves a completed child process exit code for Task Scheduler", () => {
    const result = runPowerShell([
      '$ErrorActionPreference = "Stop"',
      '$process = Start-Process -FilePath (Get-Command powershell.exe).Source -ArgumentList @("-NoProfile", "-Command", "exit 7") -WindowStyle Hidden -PassThru',
      '$processHandle = $process.Handle',
      '$completed = $process.WaitForExit(10000)',
      'if (-not $completed) { throw "The controlled child did not exit." }',
      '$process.WaitForExit()',
      '$process.Refresh()',
      '$exitCode = [int]$process.ExitCode',
      'Write-Output $exitCode',
    ].join("\n"));

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("7");
  });

  windowsIt("returns and logs a real downstream wrapper child failure", () => {
    const installRoot = mkdtempSync(join(tmpdir(), "awardping-lane-wrapper-"));
    const appScripts = join(installRoot, "app", "scripts");
    const logDir = join(installRoot, "logs");
    mkdirSync(appScripts, { recursive: true });
    mkdirSync(logDir, { recursive: true });
    writeFileSync(
      join(appScripts, "run-downstream-lane.mjs"),
      'console.error("CONTROLLED_LANE_FAILURE");\nprocess.exitCode = 7;\n',
      "utf8",
    );

    try {
      const result = spawnSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          downstreamPath,
          "-InstallRoot",
          installRoot,
          "-Lane",
          "manual_quarantine",
          "-TimeoutMinutes",
          "2",
        ],
        { encoding: "utf8", timeout: 30_000 },
      );
      const runLogName = readdirSync(logDir).find((name) =>
        /^awardping-downstream-manual_quarantine-.*\.log$/.test(name),
      );

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(7);
      expect(runLogName).toBeTruthy();
      expect(readFileSync(join(logDir, runLogName), "utf8")).toContain(
        "DOWNSTREAM_LANE_EXIT lane=manual_quarantine exit_code=7",
      );
    } finally {
      rmSync(installRoot, { recursive: true, force: true });
    }
  });

  windowsIt("bounds downstream logs without deleting outside the verified log directory", () => {
    const retentionFunctions = [
      extractPowerShellFunction(
        downstream,
        "Test-DownstreamLogPathWithinDirectory",
        "Remove-DownstreamLogFile",
      ),
      extractPowerShellFunction(
        downstream,
        "Remove-DownstreamLogFile",
        "Invoke-DownstreamLogRetention",
      ),
      extractPowerShellFunction(
        downstream,
        "Invoke-DownstreamLogRetention",
        "Rotate-DownstreamLaneSummaryLog",
      ),
      extractPowerShellFunction(
        downstream,
        "Rotate-DownstreamLaneSummaryLog",
        "Write-LaneLog",
      ),
      extractPowerShellFunction(
        downstream,
        "Write-LaneLog",
        "Test-LaneLockActive",
      ),
    ].join("\n");
    const simulation = [
      retentionFunctions,
      "$root = Join-Path ([System.IO.Path]::GetTempPath()) ('awardping-log-retention-' + [guid]::NewGuid().ToString('N'))",
      "$LogDir = Join-Path $root 'logs'; New-Item -ItemType Directory -Path $LogDir -Force | Out-Null",
      "$SummaryLog = Join-Path $LogDir 'awardping-downstream-new_page_review.log'",
      "$outside = Join-Path $root 'outside.log'; Set-Content -LiteralPath $outside -Value 'keep'",
      "1..4 | ForEach-Object { $path = Join-Path $LogDir ('awardping-downstream-new_page_review-20260716-12000' + $_ + '-001-' + $_ + '.log'); Set-Content -LiteralPath $path -Value $_; (Get-Item -LiteralPath $path).LastWriteTimeUtc = [DateTime]::UtcNow.AddMinutes($_) }",
      "$old = Join-Path $LogDir 'awardping-downstream-new_page_review-20260701-120000-001-9.log'; Set-Content -LiteralPath $old -Value 'old'; (Get-Item -LiteralPath $old).LastWriteTimeUtc = [DateTime]::UtcNow.AddDays(-20)",
      "$temp = Join-Path $LogDir 'awardping-downstream-new_page_review-20260701-120000-001-9.stdout.tmp'; Set-Content -LiteralPath $temp -Value 'old-temp'; (Get-Item -LiteralPath $temp).LastWriteTimeUtc = [DateTime]::UtcNow.AddDays(-2)",
      "Invoke-DownstreamLogRetention -MaxRunLogFiles 2 -MaxRunLogAgeDays 14 -MaxTemporaryLogFiles 1 -MaxTemporaryLogAgeHours 24",
      "try { Remove-DownstreamLogFile -Path $outside; 'UNEXPECTED_OUTSIDE_DELETE' } catch { 'OUTSIDE_BLOCKED=' + $_.Exception.Message }",
      "Set-Content -LiteralPath $SummaryLog -Value ('x' * 2048)",
      "Rotate-DownstreamLaneSummaryLog -MaxBytes 1024",
      "Write-LaneLog -Message 'new-summary'",
      "$runCount = @(Get-ChildItem -LiteralPath $LogDir -File | Where-Object { $_.Name -match '^awardping-downstream-new_page_review-\\d{8}-\\d{6}-\\d{3}-\\d+\\.log$' }).Count",
      "'RUN_COUNT=' + $runCount",
      "'OLD_EXISTS=' + (Test-Path -LiteralPath $old)",
      "'TEMP_EXISTS=' + (Test-Path -LiteralPath $temp)",
      "'OUTSIDE_EXISTS=' + (Test-Path -LiteralPath $outside)",
      "'SUMMARY_EXISTS=' + (Test-Path -LiteralPath $SummaryLog)",
      "'PREVIOUS_EXISTS=' + (Test-Path -LiteralPath ($SummaryLog + '.previous.log'))",
      "Remove-Item -LiteralPath $root -Recurse -Force",
    ].join("\n");

    const result = runPowerShell(simulation);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("RUN_COUNT=2");
    expect(result.stdout).toContain("OLD_EXISTS=False");
    expect(result.stdout).toContain("TEMP_EXISTS=False");
    expect(result.stdout).toContain("OUTSIDE_BLOCKED=");
    expect(result.stdout).toContain("OUTSIDE_EXISTS=True");
    expect(result.stdout).toContain("SUMMARY_EXISTS=True");
    expect(result.stdout).toContain("PREVIOUS_EXISTS=True");
    expect(result.stdout).not.toContain("UNEXPECTED_OUTSIDE_DELETE");
  });

  it("seals the installed source revision and live app identity URL", () => {
    expect(installer).toContain("Get-AwardPingSourceRevision -SourceRoot $sourceRoot");
    expect(installer).toContain("AWARDPING_WORKER_REVISION=$SourceRevision");
    expect(installer).toContain("NEXT_PUBLIC_APP_URL=$AppUrl");
    expect(installer).toContain('"AWARDPING_WORKER_REVISION" = $SourceRevision');
    expect(installer).toContain('"NEXT_PUBLIC_APP_URL" = $AppUrl');
    expect(installer).toContain("invalid AWARDPING_WORKER_REVISION");
    expect(installer).toContain("invalid NEXT_PUBLIC_APP_URL");
    expect(installer).toContain(
      "installed AWARDPING_WORKER_REVISION does not equal the requested source commit",
    );
    expect(installer).toContain(
      "installed NEXT_PUBLIC_APP_URL does not equal the requested production app URL",
    );
    expect(installer).toContain("status --porcelain --untracked-files=all");
    expect(installer).toContain("Refusing to label dirty or uncommitted worker code");
    expect(installer).toContain('Join-Path $manifestRoot ".awardping-worker-revision"');
    expect(installer).toContain('"scripts\\process-monitoring-feedback-promotions.mjs"');
    expect(installer).toContain('"scripts\\sync-manual-quarantine-registry.mjs"');
    expect(installer).toContain('"scripts\\lib\\manual-quarantine.mjs"');
    expect(installer).toContain(
      '"scripts\\lib\\monitoring-feedback-promotion-verification.mjs"',
    );
    expect(installer).toContain("durable manual-quarantine registry");
    expect(installerDocs).toContain("AWARDPING_WORKER_REVISION");
    expect(installerDocs).toContain("NEXT_PUBLIC_APP_URL");
    expect(installerDocs).toContain("AwardPing Feedback Promotion Lane");
    expect(installerDocs).toContain("sync-manual-quarantine-registry.mjs");
    expect(installerDocs).toContain("refuses a dirty git worktree");
    expect(installer).not.toContain("AWARDPING_GEMINI_API_DAILY_COST_CAP_USD=15");
    expect(installer).not.toContain('"AWARDPING_GEMINI_API_DAILY_COST_CAP_USD" = "15"');
  });

  windowsIt("replaces a stale installed app URL with the requested release URL", () => {
    const updateFunction = extractPowerShellFunction(
      installer,
      "Update-ExistingEnvFileDefaults",
      "Write-UninstallScript",
    );
    const simulation = [
      updateFunction,
      "$path = Join-Path ([System.IO.Path]::GetTempPath()) ('awardping-env-' + [guid]::NewGuid().ToString('N'))",
      "Set-Content -LiteralPath $path -Value \"NEXT_PUBLIC_APP_URL=https://old.example.com`r`nAWARDPING_WORKER_REVISION=0000000000000000000000000000000000000000`r`nAWARDPING_GEMINI_API_DAILY_COST_CAP_USD=15`r`nAWARDPING_DISCOVERY_ONBOARDING_BATCH_ID=do-not-print-poison`r`nAWARDPING_DISCOVERY_INTENT=historical_onboarding`r`nAWARDPING_VISUAL_REVIEW_MODE=none`r`nAWARDPING_INTERPRET_VISUAL_CHANGES=false`r`nAWARDPING_LOCALIZATION_REPAIR=true`r`nAWARDPING_FORCE_R2_SNAPSHOT_REFRESH=true`r`nAWARDPING_RESET_PREVIOUS_SNAPSHOT=true`r`n\"",
      "Update-ExistingEnvFileDefaults -Path $path -AppUrl 'https://awardping.vercel.app' -SourceRevision '1111111111111111111111111111111111111111'",
      "Get-Content -LiteralPath $path -Raw",
      "Remove-Item -LiteralPath $path -Force",
    ].join("\n");

    const result = runPowerShell(simulation);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "NEXT_PUBLIC_APP_URL=https://awardping.vercel.app",
    );
    expect(result.stdout).not.toContain("NEXT_PUBLIC_APP_URL=https://old.example.com");
    expect(result.stdout).toContain(
      "AWARDPING_WORKER_REVISION=1111111111111111111111111111111111111111",
    );
    expect(result.stdout).not.toContain("AWARDPING_GEMINI_API_DAILY_COST_CAP_USD");
    expect(result.stdout).not.toContain("do-not-print-poison");
    for (const key of [
      "AWARDPING_DISCOVERY_ONBOARDING_BATCH_ID",
      "AWARDPING_DISCOVERY_INTENT",
      "AWARDPING_VISUAL_REVIEW_MODE",
      "AWARDPING_INTERPRET_VISUAL_CHANGES",
      "AWARDPING_LOCALIZATION_REPAIR",
      "AWARDPING_FORCE_R2_SNAPSHOT_REFRESH",
      "AWARDPING_RESET_PREVIOUS_SNAPSHOT",
    ]) {
      expect(result.stdout).not.toContain(key);
    }
  });

  windowsIt("refuses to seal a dirty git source as the prior commit", () => {
    const gitPath = spawnSync("where.exe", ["git.exe"], { encoding: "utf8" })
      .stdout.split(/\r?\n/)
      .map((value) => value.trim())
      .find(Boolean);
    expect(gitPath).toBeTruthy();
    const quotedGitPath = String(gitPath).replace(/'/g, "''");
    const functions = [
      `$script:gitPath = '${quotedGitPath}'`,
      "function Get-CommandPath { param([string]$Command) return $script:gitPath }",
      extractPowerShellFunction(
        installer,
        "Get-AwardPingSourceRevision",
        "Complete-AwardPingStartupLauncherUpdate",
      ),
    ].join("\n");
    const simulation = [
      functions,
      "$root = Join-Path ([System.IO.Path]::GetTempPath()) ('awardping-dirty-revision-' + [guid]::NewGuid().ToString('N'))",
      "New-Item -ItemType Directory -Path $root -Force | Out-Null",
      "& $script:gitPath -C $root init --quiet",
      "& $script:gitPath -C $root config user.email 'worker-test@awardping.local'",
      "& $script:gitPath -C $root config user.name 'AwardPing Test'",
      "$file = Join-Path $root 'worker.mjs'; Set-Content -LiteralPath $file -Value 'committed'",
      "& $script:gitPath -C $root add worker.mjs; & $script:gitPath -C $root commit --quiet -m initial",
      "$clean = Get-AwardPingSourceRevision -SourceRoot $root",
      "Set-Content -LiteralPath $file -Value 'dirty'",
      "try { Get-AwardPingSourceRevision -SourceRoot $root; 'UNEXPECTED_SUCCESS' } catch { 'BLOCKED=' + $_.Exception.Message }",
      "'CLEAN=' + $clean",
      "Remove-Item -LiteralPath $root -Recurse -Force",
    ].join("\n");
    const result = runPowerShell(simulation);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/CLEAN=[0-9a-f]{40}/);
    expect(result.stdout).toContain("BLOCKED=Refusing to label dirty or uncommitted worker code");
    expect(result.stdout).not.toContain("UNEXPECTED_SUCCESS");
  });

  windowsIt("labels a worker source nested in an unrelated repository from its manifest, never the enclosing HEAD", () => {
    const gitPath = spawnSync("where.exe", ["git.exe"], { encoding: "utf8" })
      .stdout.split(/\r?\n/)
      .map((value) => value.trim())
      .find(Boolean);
    expect(gitPath).toBeTruthy();
    const quotedGitPath = String(gitPath).replace(/'/g, "''");
    const functions = [
      `$script:gitPath = '${quotedGitPath}'`,
      "function Get-CommandPath { param([string]$Command) return $script:gitPath }",
      extractPowerShellFunction(
        installer,
        "Get-AwardPingSourceRevision",
        "Complete-AwardPingStartupLauncherUpdate",
      ),
    ].join("\n");
    // A clean outer repository whose ignored child holds an extracted worker
    // package. The child has no .git of its own, so only its packaged manifest
    // may label it; the outer HEAD belongs to an unrelated repository.
    const simulation = [
      functions,
      "$outer = Join-Path ([System.IO.Path]::GetTempPath()) ('awardping-nested-revision-' + [guid]::NewGuid().ToString('N'))",
      "$child = Join-Path $outer 'worker-package'",
      "New-Item -ItemType Directory -Path $child -Force | Out-Null",
      "& $script:gitPath -C $outer init --quiet",
      "& $script:gitPath -C $outer config user.email 'worker-test@awardping.local'",
      "& $script:gitPath -C $outer config user.name 'AwardPing Test'",
      "Set-Content -LiteralPath (Join-Path $outer '.gitignore') -Value 'worker-package/'",
      "Set-Content -LiteralPath (Join-Path $outer 'README.md') -Value 'unrelated outer repository'",
      "& $script:gitPath -C $outer add .gitignore README.md; & $script:gitPath -C $outer commit --quiet -m outer",
      "$outerHead = ((& $script:gitPath -C $outer rev-parse HEAD) | Select-Object -First 1).Trim()",
      "Set-Content -LiteralPath (Join-Path $child 'worker.mjs') -Value 'packaged worker'",
      "$manifest = Join-Path $child '.awardping-worker-revision'",
      "Set-Content -LiteralPath $manifest -Value ('a' * 40)",
      "$withManifest = Get-AwardPingSourceRevision -SourceRoot $child",
      "Remove-Item -LiteralPath $manifest -Force",
      "try { $leaked = Get-AwardPingSourceRevision -SourceRoot $child; 'UNEXPECTED_SUCCESS=' + $leaked } catch { 'BLOCKED=' + $_.Exception.Message }",
      "'OUTER=' + $outerHead",
      "'WITH_MANIFEST=' + $withManifest",
      "Remove-Item -LiteralPath $outer -Recurse -Force",
    ].join("\n");
    const result = runPowerShell(simulation);
    expect(result.status).toBe(0);
    const outerHead = result.stdout.match(/OUTER=([0-9a-f]{40})/)?.[1];
    expect(outerHead).toBeTruthy();
    expect(result.stdout).toContain(`WITH_MANIFEST=${"a".repeat(40)}`);
    expect(result.stdout).not.toContain(`WITH_MANIFEST=${outerHead}`);
    expect(result.stdout).toContain("BLOCKED=Could not determine the exact source git commit");
    expect(result.stdout).not.toContain("UNEXPECTED_SUCCESS");
  });

  it("documents the complete update command instead of manual app-file copying", () => {
    expect(installerDocs).toContain("Install-AwardPingWorker.ps1\" -UpdateOnly");
    expect(installerDocs).toContain("apply and verify its Supabase migrations");
    expect(installerDocs).toContain("/api/monitoring-policy-identity");
    expect(installerDocs).toContain("AwardPing Suppression Lane");
    expect(installerDocs).toContain("complete staged app");
    expect(installerDocs).toContain("workspace catch-up");
    expect(installerDocs).toContain("Cloudflare R2 account ID");
    expect(installerDocs).toContain("preserves the existing R2 credentials");
    expect(installerDocs).toMatch(/Do not\r?\ncopy individual files/);
  });

  it("wires the three 6 PM shards into scheduled cohort reporting", () => {
    expect(installer).toContain("-ShardIndex $shardIndex -RunTrigger scheduled");
    expect(installer).toContain('"--run-trigger"');
    expect(installer).toContain('`$RunTrigger');
    expect(installer).toContain('`$workerArgs += "--discovery-mode=true"');
    expect(installer).toContain('`$workerArgs += "--discovery-intent=live_recurring"');
    expect(installer).toContain('`$workerArgs += "--discovery-onboarding-batch-id="');
    expect(installer).toContain('"--localization-repair=false"');
    expect(installer).toContain('"--reset-previous-snapshot=false"');
    expect(installer).toContain('"--force-r2-snapshot-refresh=false"');
    expect(installer).toContain('"--visual-review-mode=batch"');
    expect(installer).toContain('"--interpret-visual-changes=true"');
    expect(installer).toContain('"--r2-snapshot-sync=true"');
    expect(installer).toContain("scripts\\lib\\visual-capture-run-report.mjs");
    expect(installer).toContain("scripts\\lib\\visual-nightly-run-contract.mjs");
    expect(installer).toContain("scripts\\report-visual-nightly.mjs");
    expect(installer).toContain("visual-nightly-report-latest.json");
    expect(installer).toContain("Failures / loaded sources");
    expect(installerDocs).toContain("6 PM Capture Reports");
    expect(installerDocs).toContain("newest attempt for each shard");
    expect(maintenanceRunner).toContain('"--run-trigger=maintenance"');
    expect(maintenanceRunner).toContain("--run-cohort-id=${maintenanceRun?.id");
    const nightlyWriterStart = captureWorker.indexOf("async function maybeWriteNightlyVisualReport");
    const nightlyWriterEnd = captureWorker.indexOf("function startRunHeartbeat", nightlyWriterStart);
    const nightlyWriter = captureWorker.slice(nightlyWriterStart, nightlyWriterEnd);
    expect(nightlyWriter.indexOf("try {")).toBeLessThan(nightlyWriter.indexOf("await acquireFileLock"));
    expect(nightlyWriter).toContain("releaseLock?.()");
  });

  it("keeps every obsolete standalone installer and watchdog fail-closed", () => {
    for (const source of [
      overnightInstaller,
      baselineCompletionWatchdog,
      baselineFactsWatchdog,
      baselineFactsRunner,
      sourceQualityRunner,
    ]) {
      expect(source).toContain("is retired and cannot");
      expect(source).toContain("Install-AwardPingWorker.ps1");
      expect(source).not.toContain("Register-ScheduledTask");
      expect(source).not.toContain("Start-ScheduledTask");
      expect(source).not.toContain("Start-Process");
    }
  });

  windowsIt("returns a nonzero retirement error from every obsolete entrypoint", () => {
    for (const path of [
      overnightInstallerPath,
      baselineCompletionWatchdogPath,
      baselineFactsWatchdogPath,
      baselineFactsRunnerPath,
      sourceQualityRunnerPath,
    ]) {
      const result = spawnSync(
        "powershell.exe",
        ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path],
        { encoding: "utf8" },
      );
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toContain("is retired and cannot");
    }
  });
});
