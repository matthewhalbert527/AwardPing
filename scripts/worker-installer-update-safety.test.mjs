import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
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

  it("restores exact task XML on failure and merges new task actions with old schedules on success", () => {
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
    expect(installer).toContain('/task:Task/task:Triggers');
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

  const windowsIt = (name, test) =>
    (process.platform === "win32" ? it : it.skip)(name, test, 20_000);

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
      "scripts\\lib\\source-quality.mjs",
      "scripts\\lib\\source-ai-review-status.mjs",
      "src\\lib\\change-event-suppression.ts",
      "src\\lib\\award-monitoring-policy.ts",
      "src\\lib\\source-quality.ts",
      "src\\lib\\source-ai-review-status.ts",
      "src\\lib\\source-url-policy.ts",
      "scripts\\supabase-service-client.mjs",
      "scripts\\run-downstream-lane.mjs",
      "scripts\\lib\\gemini-spend-ledger.mjs",
      "scripts\\lib\\gemini-batch-support.mjs",
      "scripts\\lib\\r2-baseline-rehydration.mjs",
      "scripts\\lib\\source-intake.mjs",
      "scripts\\evaluate-public-page-audit-canaries.mjs",
    ]) {
      expect(installer.split(`"${relativePath}"`).length - 1).toBeGreaterThanOrEqual(2);
    }
    expect(installer).toContain('"sharp",');
  });

  it("requires a complete syntactically valid R2 configuration before tasks resume", () => {
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
      "Set-Content -LiteralPath $path -Value \"NEXT_PUBLIC_APP_URL=https://old.example.com`r`nAWARDPING_WORKER_REVISION=0000000000000000000000000000000000000000`r`nAWARDPING_GEMINI_API_DAILY_COST_CAP_USD=15`r`n\"",
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
    expect(installer).toContain("scripts\\lib\\visual-capture-run-report.mjs");
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
