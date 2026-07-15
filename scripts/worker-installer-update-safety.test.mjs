import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const installer = readFileSync(
  resolve(root, "installer", "windows", "Install-AwardPingWorker.ps1"),
  "utf8",
);
const downstream = readFileSync(
  resolve(root, "installer", "windows", "Run-AwardPingDownstreamQueues.ps1"),
  "utf8",
);
const baselineWatchdog = readFileSync(
  resolve(root, "installer", "windows", "Watch-AwardPingBaselineFacts.ps1"),
  "utf8",
);
const startupSupervisor = readFileSync(
  resolve(root, "installer", "windows", "Start-AwardPingOnBoot.ps1"),
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
    expect(suspendIndex).toBeGreaterThan(stagedDependencyIndex);
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

  const windowsIt = process.platform === "win32" ? it : it.skip;

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
      "try { Restore-AwardPingTasksAfterUpdate -Snapshots @($snapshot) -SuppressionSweepLimit 1 -SuppressionSweepBatchSize 1 -ApplyTaskDefinitionUpdates $false -RestoreOperationalState $true } catch {}",
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
      "function Get-ScheduledTask { @([pscustomobject]@{ TaskName='AwardPing Visual Snapshot Worker Shard 1'; TaskPath='\\' }, [pscustomobject]@{ TaskName='AwardPing Downstream Queue Pipeline'; TaskPath='\\' }, [pscustomobject]@{ TaskName='AwardPing Concurrent Custom Audit'; TaskPath='\\' }) }",
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
      "CALLS=disable:AwardPing Downstream Queue Pipeline,stop:AwardPing Downstream Queue Pipeline,remove:AwardPing Downstream Queue Pipeline",
    );
    expect(result.stdout).not.toContain("AwardPing Concurrent Custom Audit");
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
      "Set-Content -LiteralPath (Join-Path $root 'Start-AwardPingOnBoot.ps1') -Value 'new-only-wrapper'",
      "Restore-AwardPingAppAfterFailedUpdate -CurrentAppDir $app -BackupAppDir $backup -FailedAppDir $failed",
      "Restore-AwardPingRootRuntimeSnapshot -InstallRoot $root -Snapshot $snapshot -Token 'test'",
      "'APP=' + (Get-Content -LiteralPath (Join-Path $app 'generation.txt') -Raw).Trim()",
      "'WRAPPER=' + (Get-Content -LiteralPath (Join-Path $root 'Run-AwardPingVisualSnapshots.ps1') -Raw).Trim()",
      "'NEW_ONLY_EXISTS=' + (Test-Path -LiteralPath (Join-Path $root 'Start-AwardPingOnBoot.ps1'))",
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

  it("registers every update task disabled until the task transaction commits", () => {
    expect(installer).toContain("-RegisterDisabled $UpdateOnly");
    expect(installer).toContain("if ($RegisterDisabled) { $settings.Enabled = $false }");
    expect(baselineWatchdog).toContain("[switch]$InstallDisabled");
    expect(baselineWatchdog).toContain("if ($InstallDisabled) { $settings.Enabled = $false }");
    expect(downstream).toContain("[switch]$InstallDisabled");
    expect(downstream).toContain("if ($InstallDisabled) { $settings.Enabled = $false }");
    expect(startupSupervisor).toContain("[switch]$InstallDisabled");
    expect(startupSupervisor).toContain("startup_folder_fallback_deferred_until_update_commit");
    expect(installer).not.toContain("-InstallDisabled:$RegisterDisabled");
    expect(installer).toContain('$startupInstallArguments += "-InstallDisabled"');
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

  it("keeps the retro sweep explicit in the restored task and the hourly execution order", () => {
    expect(installer).toContain("-SuppressionSweepLimit $SuppressionSweepLimit");
    expect(installer).toContain("-SuppressionSweepBatchSize $SuppressionSweepBatchSize");

    const visualIndex = downstream.indexOf('-Name "visual-review-batch"');
    const sweepIndex = downstream.indexOf('-Name "change-event-suppression-sweep"');
    const reconciliationIndex = downstream.indexOf('-Name "award-reconciliation"');
    const auditIndex = downstream.indexOf('-Name "page-audit-batch"');
    const nightlyReportIndex = downstream.indexOf('-Name "visual-nightly-report"');
    expect(sweepIndex).toBeGreaterThan(visualIndex);
    expect(reconciliationIndex).toBeGreaterThan(sweepIndex);
    expect(auditIndex).toBeGreaterThan(reconciliationIndex);
    expect(nightlyReportIndex).toBeGreaterThan(0);
    expect(visualIndex).toBeGreaterThan(nightlyReportIndex);
    expect(downstream).toContain('scripts\\report-visual-nightly.mjs');
    expect(downstream).toContain('$nightlyReportExit -eq 0');
    expect(captureWorker).toContain('acquireFileLock(join(reportDir, "visual-nightly-report.lock"))');
    expect(nightlyReporter).toContain('acquireFileLock(join(reportDir, "visual-nightly-report.lock"))');
  });

  it("documents the complete update command instead of manual app-file copying", () => {
    expect(installerDocs).toContain("Install-AwardPingWorker.ps1\" -UpdateOnly");
    expect(installerDocs).toContain("Apply and verify its Supabase migrations");
    expect(installerDocs).toContain("change-event-suppression-sweep");
    expect(installerDocs).toContain("complete staged app");
    expect(installerDocs).toContain("workspace catch-up");
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

  it("publishes the overnight policy bundle as a quiesced rollback transaction", () => {
    expect(overnightInstaller).toContain(
      'config\\award-monitoring-policy.json',
    );
    expect(overnightInstaller).toContain(
      'config\\award-decision-memory.json',
    );
    expect(overnightInstaller).toContain("Publish-StagedFileAtomically");
    expect(overnightInstaller).toContain("[System.IO.File]::Replace");
    expect(overnightInstaller).toContain("Get-OvernightTaskSnapshot");
    expect(overnightInstaller).toContain("Suspend-OvernightTaskForUpdate");
    expect(overnightInstaller).toContain("New-OvernightBundleSnapshot");
    expect(overnightInstaller).toContain("Restore-OvernightBundleSnapshot");
    expect(overnightInstaller).toContain("Restore-OvernightTaskAfterFailure");
    const removeEntryIndex = overnightInstaller.indexOf(
      "foreach ($entryPath in @($targetRunner, $runNowBatPath))",
    );
    const stopIndex = overnightInstaller.indexOf(
      "Wait-ForInstalledOvernightProcessesToStop",
      removeEntryIndex,
    );
    const publishIndex = overnightInstaller.indexOf(
      "Publish-StagedFileAtomically",
      stopIndex,
    );
    expect(removeEntryIndex).toBeGreaterThan(0);
    expect(stopIndex).toBeGreaterThan(removeEntryIndex);
    expect(publishIndex).toBeGreaterThan(stopIndex);
  });

  windowsIt("restores every overnight bundle file after a partial publish", () => {
    const bundleFunctions = [
      extractPowerShellFunction(overnightInstaller, "Publish-StagedFileAtomically", "Test-OvernightTaskTargetsInstallRoot"),
      extractPowerShellFunction(overnightInstaller, "New-OvernightBundleSnapshot", "Remove-OvernightBundleTargets"),
      extractPowerShellFunction(overnightInstaller, "Remove-OvernightBundleTargets", "Restore-OvernightBundleSnapshot"),
      extractPowerShellFunction(overnightInstaller, "Restore-OvernightBundleSnapshot", "Get-OvernightBundleProblems"),
    ].join("\n");
    const simulation = [
      bundleFunctions,
      "$root = Join-Path ([System.IO.Path]::GetTempPath()) ('awardping-overnight-rollback-' + [guid]::NewGuid().ToString('N'))",
      "$stage = Join-Path $root 'stage'; $snapshotDir = Join-Path $root 'snapshot'; New-Item -ItemType Directory -Path $root,$stage -Force | Out-Null",
      "$oldA = Join-Path $root 'a.json'; $oldB = Join-Path $root 'b.mjs'; $newOnly = Join-Path $root 'new.ps1'",
      "$stageA = Join-Path $stage 'a.json'; $stageB = Join-Path $stage 'b.mjs'; $stageNew = Join-Path $stage 'new.ps1'",
      "Set-Content -LiteralPath $oldA -Value 'old-a'; Set-Content -LiteralPath $oldB -Value 'old-b'",
      "Set-Content -LiteralPath $stageA -Value 'new-a'; Set-Content -LiteralPath $stageB -Value 'new-b'; Set-Content -LiteralPath $stageNew -Value 'new-only'",
      "$entries = @([pscustomobject]@{DestinationPath=$oldA},[pscustomobject]@{DestinationPath=$oldB},[pscustomobject]@{DestinationPath=$newOnly})",
      "$snapshot = New-OvernightBundleSnapshot -Entries $entries -SnapshotDirectory $snapshotDir",
      "Remove-OvernightBundleTargets -Entries $entries",
      "Publish-StagedFileAtomically -StagedPath $stageA -DestinationPath $oldA -Token 'test'",
      "Publish-StagedFileAtomically -StagedPath $stageNew -DestinationPath $newOnly -Token 'test'",
      "Restore-OvernightBundleSnapshot -Snapshot $snapshot -Token 'test'",
      "'A=' + (Get-Content -LiteralPath $oldA -Raw).Trim()",
      "'B=' + (Get-Content -LiteralPath $oldB -Raw).Trim()",
      "'NEW_ONLY_EXISTS=' + (Test-Path -LiteralPath $newOnly)",
      "Remove-Item -LiteralPath $root -Recurse -Force",
    ].join("\n");
    const result = runPowerShell(simulation);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("A=old-a");
    expect(result.stdout).toContain("B=old-b");
    expect(result.stdout).toContain("NEW_ONLY_EXISTS=False");
  });

  windowsIt("blocks an overnight task-name collision from another install root", () => {
    const collisionFunctions = [
      extractPowerShellFunction(overnightInstaller, "Test-OvernightTaskTargetsInstallRoot", "Get-OvernightTaskSnapshot"),
      extractPowerShellFunction(overnightInstaller, "Get-OvernightTaskSnapshot", "Get-DisabledScheduledTaskXml"),
    ].join("\n");
    const simulation = [
      collisionFunctions,
      String.raw`function Get-ScheduledTask { [pscustomobject]@{ TaskName='AwardPing Overnight Source Quality Pass'; TaskPath='\'; Actions=@([pscustomobject]@{ Execute='powershell.exe'; Arguments='-File "D:\OtherAwardPing\Run-AwardPingOvernightSourceQuality.ps1"' }); State='Ready' } }`,
      "try { Get-OvernightTaskSnapshot -TaskName 'AwardPing Overnight Source Quality Pass' -InstallRoot 'C:\\AwardPingWorker'; 'UNEXPECTED_SUCCESS' } catch { 'BLOCKED=' + $_.Exception.Message }",
    ].join("\n");
    const result = runPowerShell(simulation);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("BLOCKED=");
    expect(result.stdout).toContain("not the AwardPing overnight task for this install root");
    expect(result.stdout).not.toContain("UNEXPECTED_SUCCESS");
  });
});
