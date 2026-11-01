import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { spawnSync, stopTestChildren } from "./test-support/bounded-test-process.mjs";
import { parseProgramTextArgs } from "./program-text-worker.mjs";

const root = resolve(import.meta.dirname, "..");
const installer = join(root, "installer/windows/Install-AwardPingWorker.ps1");
const fixtures = [];
const quote = value => `'${String(value).replaceAll("'", "''")}'`;
function fixture() {
  const path = mkdtempSync(join(tmpdir(), "awardping-program-text-installer-"));
  fixtures.push(path);
  return path;
}
function nativeEnv() {
  const windowsRoot = realpathSync(process.env.SystemRoot);
  const modules = realpathSync(join(windowsRoot, "System32/WindowsPowerShell/v1.0/Modules"));
  if (!modules.toLowerCase().startsWith(windowsRoot.toLowerCase() + sep)) throw new Error("Unexpected module directory");
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== "psmodulepath"));
  return { ...env, PSModulePath: modules };
}
function run(script, timeout = 45000) {
  return spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    { encoding: "utf8", env: nativeEnv(), timeout });
}
function definitions(names) {
  return `
    $ErrorActionPreference = 'Stop'
    $errors = $null; $tokens = $null
    $ast = [Management.Automation.Language.Parser]::ParseFile(${quote(installer)}, [ref]$tokens, [ref]$errors)
    if (@($errors).Count) { throw ($errors | Out-String) }
    foreach ($name in @(${names.map(quote).join(",")})) {
      $definition = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $true)
      if (-not $definition) { throw "Missing function $name" }
      . ([scriptblock]::Create($definition.Extent.Text))
    }
  `;
}
afterEach(async () => {
  await stopTestChildren();
  for (const path of fixtures.splice(0)) {
    if (dirname(resolve(path)) !== resolve(tmpdir()) || !basename(path).startsWith("awardping-program-text-installer-")) throw new Error("Unsafe fixture cleanup");
    rmSync(path, { recursive: true, force: true });
  }
});

describe.skipIf(process.platform !== "win32")("program text installer boundaries", () => {
  it("requires and hash-compares every text runtime file using the actual installer guard", () => {
    const path = fixture(), source = join(path, "source"), app = join(path, "worker/app");
    const result = run(`${definitions(["Get-AwardPingProgramTextRuntimeRelativePaths", "Get-AwardPingInstalledRuntimeProblems"])}
      function Get-AwardPingRootedActionPaths { return @() }
      function Get-MissingWorkerRuntimeDependencies { return @() }
      function Get-AwardPingInteractiveTaskNames { return @() }
      function Get-AwardPingManagedTaskScheduleProblems { return @() }
      function Get-AwardPingScraplingRuntimeRelativePaths { return @() }
      $files = @(Get-AwardPingProgramTextRuntimeRelativePaths)
      foreach ($relative in $files) {
        foreach ($destination in @(${quote(source)}, ${quote(app)})) {
          $target = Join-Path $destination $relative
          [void](New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target))
          Copy-Item -LiteralPath (Join-Path ${quote(root)} $relative) -Destination $target
        }
      }
      $positive = @(Get-AwardPingInstalledRuntimeProblems -InstallRoot ${quote(join(path, "worker"))} -AppDir ${quote(app)} -AppSourceRoot ${quote(source)} -TaskSnapshots @() -RequireManagedRuntime $true)
      $cases = @()
      foreach ($relative in $files) {
        $target = Join-Path ${quote(app)} $relative
        $original = [IO.File]::ReadAllBytes($target)
        try {
          [IO.File]::WriteAllText($target, 'inert tamper fixture; never executed')
          $changed = @(Get-AwardPingInstalledRuntimeProblems -InstallRoot ${quote(join(path, "worker"))} -AppDir ${quote(app)} -AppSourceRoot ${quote(source)} -TaskSnapshots @() -RequireManagedRuntime $true)
        } finally { [IO.File]::WriteAllBytes($target, $original) }
        $cases += [pscustomobject]@{ relative=$relative; target=$target; changed=$changed }
      }
      $decisionTarget = ${quote(join(app, "scripts/lib/program-text-deterministic-no-change.mjs"))}
      $decisionBytes = [IO.File]::ReadAllBytes($decisionTarget)
      try {
        [IO.File]::Delete($decisionTarget)
        $missingDecision = @(Get-AwardPingInstalledRuntimeProblems -InstallRoot ${quote(join(path, "worker"))} -AppDir ${quote(app)} -AppSourceRoot ${quote(source)} -TaskSnapshots @() -RequireManagedRuntime $true)
      } finally { [IO.File]::WriteAllBytes($decisionTarget, $decisionBytes) }
      [pscustomobject]@{ files=$files; positive=$positive; cases=$cases; decisionTarget=$decisionTarget; missingDecision=$missingDecision } | ConvertTo-Json -Depth 5
    `, 120000);
    expect(result.status, result.stderr).toBe(0);
    const value = JSON.parse(result.stdout);
    expect(value.files).toHaveLength(47);
    expect(value.files).toContain("scripts\\lib\\program-text-canonical-url-admission.mjs");
    for (const relative of ["scripts\\lib\\program-text-collection-quality.mjs", "scripts\\lib\\program-text-smart-guide-profiles.mjs",
      "scripts\\lib\\program-text-smart-guide-reviewed-model.mjs", "scripts\\lib\\program-text-smart-body-link.mjs"]) expect(value.files).toContain(relative);
    for (const relative of ["scripts\\lib\\program-text-capture-contract.mjs", "scripts\\lib\\program-text-artifacts.mjs",
      "scripts\\lib\\program-text-publisher-json.mjs", "scripts\\lib\\program-text-smart-publisher-json.mjs",
      "scripts\\lib\\program-text-smart-kb-publisher-json.mjs", "scripts\\lib\\program-text-smart-kb-reviewed-model.mjs",
      "scripts\\lib\\program-text-source-raw-anchor.mjs", "scripts\\scrapling\\html_document.py",
      "scripts\\lib\\scrapling-capture.mjs", "scripts\\scrapling\\collector.py", "scripts\\scrapling\\smart_publisher_json.py"]) expect(value.files).toContain(relative);
    expect(value.files).toContain("scripts\\lib\\program-text-public-drive-pdf.mjs");
    expect(value.files).toContain("scripts\\lib\\program-text-public-drive-transport.mjs");
    expect(value.files).toContain("scripts\\prepare-program-text-source-proof.mjs");
    expect(value.files).toContain("scripts\\lib\\program-text-source-access.mjs");
    expect(value.files).toContain("config\\program-text-monitoring.json");
    expect(value.files).toContain("scripts\\program-text-worker.mjs");
    expect(value.files).toContain("scripts\\program-text-ocr-windows.ps1");
    expect(value.files).toContain("scripts\\lib\\program-text-deterministic-no-change.mjs");
    expect(value.files).toContain("scripts\\lib\\gemini-worker-policy.mjs");
    expect(value.files).toContain("scripts\\lib\\lane-failure-receipt.mjs");
    expect(value.missingDecision).toContain(`missing action/runtime path: ${value.decisionTarget}`);
    for (const row of value.cases) {
      expect(value.positive.some(problem => problem.includes(row.target))).toBe(false);
      expect(row.changed).toContain(`installed runtime hash mismatch: ${row.target}`);
    }
  }, 180000);

  it("generates parsable text launchers and propagates a failing collection once, without retry", () => {
    const path = fixture(), app = join(path, "app");
    mkdirSync(join(app, "scripts"), { recursive: true });
    writeFileSync(join(app, "scripts/program-text-worker.mjs"), 'process.stdout.write("FIXTURE_ARGS="+JSON.stringify(process.argv.slice(2))+"\\n"); process.exitCode=7;');
    const generated = run(`${definitions(["Write-LauncherScripts"])}
      Write-LauncherScripts -InstallRoot ${quote(path)}
      foreach ($file in @(Get-ChildItem -LiteralPath ${quote(path)} -Filter '*.ps1')) {
        $parseErrors = $null; $tokens = $null
        [void][Management.Automation.Language.Parser]::ParseFile($file.FullName, [ref]$tokens, [ref]$parseErrors)
        if (@($parseErrors).Count) { throw ($parseErrors | Out-String) }
      }
      'PARSED'
    `);
    expect(generated.status, generated.stderr).toBe(0);
    expect(generated.stdout).toContain("PARSED");
    const wrapper = join(path, "Run-AwardPingVisualSnapshots.ps1");
    const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", wrapper,
      "-All", "-Limit", "50000", "-WebConcurrency", "3", "-ShardCount", "3", "-ShardIndex", "1", "-RunTrigger", "scheduled"],
    { encoding: "utf8", env: nativeEnv(), timeout: 45000 });
    expect(result.status, result.stderr).toBe(7);
    const invocations = result.stdout.split(/\r?\n/).filter(line => line.startsWith("FIXTURE_ARGS="));
    expect(invocations).toHaveLength(1);
    const args = JSON.parse(invocations[0].slice("FIXTURE_ARGS=".length));
    expect(args).toEqual(["--mode=collect", "--apply=true", "--env", ".env.worker.local", "--limit", "50000",
      "--domain-delay-ms", "1500", "--shard-count", "3", "--shard-index", "1", "--run-trigger", "scheduled"]);
    expect(parseProgramTextArgs(args)).toMatchObject({ mode: "collect", apply: true, shardCount: 3, shardIndex: 1 });
    const source = readFileSync(wrapper, "utf8");
    expect(source).not.toMatch(/--(?:discovery|screenshot|visual-review|localization|r2-snapshot|interpret-visual)/);
    expect(source).toContain("[int]$MaxRestarts = 0");
    const status = readFileSync(join(path, "Show-AwardPingVisualStatus.ps1"), "utf8");
    expect(status).toContain('"--mode=report"');
    expect(status).not.toContain("--apply");
  }, 60000);

  it("protects and validates both private roots with fresh DACLs before writing environment bindings", () => {
    const path = fixture(), env = join(path, "worker.env");
    writeFileSync(env, "INERT_FIXTURE=yes\r\n");
    const result = run(`${definitions(["ConvertTo-AwardPingSecurityIdentifier", "Get-AwardPingWorkerEnvAllowedSecurityIdentifiers", "Get-AwardPingProgramTextArchiveProblems", "New-AwardPingPrivateDirectoryAcl", "Initialize-AwardPingPrivateDataRoot", "Set-AwardPingProgramTextEnvironment"])}
      function Get-AwardPingDailyCoverageBoundaryUtc { [DateTimeOffset]'2026-11-01T23:30:00Z' }
      Set-AwardPingProgramTextEnvironment -Path ${quote(env)} -InstallRoot ${quote(path)} -TaskSnapshots @()
      $archive = Join-Path ${quote(path)} 'runtime\\program-text-archive'
      $positive = @(Get-AwardPingProgramTextArchiveProblems -Path $archive -TaskSnapshots @())
      $data = Join-Path ${quote(path)} 'data'
      $dataPositive = @(Get-AwardPingProgramTextArchiveProblems -Path $data -TaskSnapshots @())
      [IO.File]::WriteAllText((Join-Path $archive 'inert.txt'), 'fixture')
      $inherited = @((Get-Acl -LiteralPath (Join-Path $archive 'inert.txt')).Access | Where-Object IsInherited).Count
      $acl = Get-Acl -LiteralPath $archive
      $everyone = [Security.Principal.SecurityIdentifier]::new('S-1-1-0')
      [void]$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($everyone, 'Read', 'Allow'))
      [IO.Directory]::SetAccessControl($archive, $acl)
      $tampered = @(Get-AwardPingProgramTextArchiveProblems -Path $archive -TaskSnapshots @())
      [pscustomobject]@{ positive=$positive; dataPositive=$dataPositive; inherited=$inherited; tampered=$tampered; protected=(Get-Acl -LiteralPath $archive).AreAccessRulesProtected; dataProtected=(Get-Acl -LiteralPath $data).AreAccessRulesProtected } | ConvertTo-Json -Depth 4
    `);
    expect(result.status, result.stderr).toBe(0);
    const value = JSON.parse(result.stdout);
    expect(value.positive).toEqual([]);
    expect(value.dataPositive).toEqual([]);
    expect(value.inherited).toBeGreaterThan(0);
    expect(value.protected).toBe(true);
    expect(value.dataProtected).toBe(true);
    expect(value.tampered.join(" ")).toContain("unapproved SID S-1-1-0");
    expect(readFileSync(env, "utf8")).toBe(`INERT_FIXTURE=yes\r\nAWARDPING_PROGRAM_TEXT_ARCHIVE=${join(path, "runtime/program-text-archive")}\r\nAWARDPING_WORKER_DATA_ROOT=${join(path, "data")}\r\nAWARDPING_COLLECTION_ANCHOR_MINUTE_UTC=1380\r\n`);
  }, 60000);

  it("secures moved history descendants and preserves their bytes on repeated updates", () => {
    const path = fixture(), app = join(path, "app"), stage = join(path, "stage"), env = join(stage, ".env.worker.local");
    mkdirSync(app); mkdirSync(stage); writeFileSync(join(app, ".env.worker.local"), "INERT_FIXTURE=yes\r\n");
    const result = run(`${definitions(["ConvertTo-AwardPingSecurityIdentifier", "Get-AwardPingWorkerEnvAllowedSecurityIdentifiers", "Get-AwardPingProgramTextArchiveProblems", "New-AwardPingPrivateDirectoryAcl", "Initialize-AwardPingPrivateDataRoot", "Set-AwardPingProgramTextEnvironment", "Copy-AwardPingMutableAppState"])}
      function Get-AwardPingDailyCoverageBoundaryUtc { [DateTimeOffset]'2026-11-01T23:30:00Z' }
      $entries = @(Get-AwardPingWorkerEnvAllowedSecurityIdentifiers -TaskSnapshots @())
      $legacyAcl = New-AwardPingPrivateDirectoryAcl -AllowedEntries $entries
      $everyone = [Security.Principal.SecurityIdentifier]::new('S-1-1-0')
      $inheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
      [void]$legacyAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($everyone, 'Read', $inheritance, [Security.AccessControl.PropagationFlags]::None, 'Allow'))
      [IO.Directory]::SetAccessControl(${quote(app)}, $legacyAcl)
      $oldDirectory = Join-Path ${quote(app)} 'reports\\nested'
      [void][IO.Directory]::CreateDirectory($oldDirectory)
      $oldFile = Join-Path $oldDirectory 'retained.json'
      [IO.File]::WriteAllText($oldFile, 'retained history bytes')
      $beforeHash = (Get-FileHash -LiteralPath $oldFile -Algorithm SHA256).Hash
      $beforeForeign = @((Get-Acl -LiteralPath $oldFile).Access | Where-Object { $_.IsInherited -and $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -eq 'S-1-1-0' }).Count
      $data = Initialize-AwardPingPrivateDataRoot -InstallRoot ${quote(path)} -TaskSnapshots @()
      $beforeMove = @(Get-AwardPingProgramTextArchiveProblems -Path $data -TaskSnapshots @())
      Copy-AwardPingMutableAppState -CurrentAppDir ${quote(app)} -StagingAppDir ${quote(stage)}
      Set-AwardPingProgramTextEnvironment -Path ${quote(env)} -InstallRoot ${quote(path)} -TaskSnapshots @()
      $after = @()
      foreach ($relative in @('data', 'data\\reports', 'data\\reports\\nested', 'data\\reports\\nested\\retained.json')) {
        $target = Join-Path ${quote(path)} $relative
        $acl = Get-Acl -LiteralPath $target
        $foreign = @($acl.Access | Where-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -notin $entries.Sid.Value }).Count
        $after += [pscustomobject]@{ relative=$relative; foreign=$foreign }
      }
      # Freshly persisting the root DACL must also repair an existing moved
      # child's inherited foreign rule on a later update, without content writes.
      $dataAcl = Get-Acl -LiteralPath $data
      [void]$dataAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($everyone, 'Read', $inheritance, [Security.AccessControl.PropagationFlags]::None, 'Allow'))
      [IO.Directory]::SetAccessControl($data, $dataAcl)
      Set-AwardPingProgramTextEnvironment -Path ${quote(env)} -InstallRoot ${quote(path)} -TaskSnapshots @()
      $retained = Join-Path $data 'reports\\nested\\retained.json'
      $repairedForeign = @((Get-Acl -LiteralPath $retained).Access | Where-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -notin $entries.Sid.Value }).Count
      [pscustomobject]@{ beforeForeign=$beforeForeign; beforeMove=$beforeMove; after=$after; repairedForeign=$repairedForeign;
        sameBytes=($beforeHash -ceq (Get-FileHash -LiteralPath $retained -Algorithm SHA256).Hash);
        dataProblems=@(Get-AwardPingProgramTextArchiveProblems -Path $data -TaskSnapshots @());
        archiveProblems=@(Get-AwardPingProgramTextArchiveProblems -Path (Join-Path ${quote(path)} 'runtime\\program-text-archive') -TaskSnapshots @()) } | ConvertTo-Json -Depth 5
    `);
    expect(result.status, result.stderr).toBe(0);
    const value = JSON.parse(result.stdout);
    expect(value.beforeForeign).toBeGreaterThan(0);
    expect(value.beforeMove).toEqual([]);
    expect(value.after.every(row => row.foreign === 0)).toBe(true);
    expect(value.repairedForeign).toBe(0);
    expect(value.sameBytes).toBe(true);
    expect(value.dataProblems).toEqual([]);
    expect(value.archiveProblems).toEqual([]);
  }, 60000);

  it("rejects a redirected archive ancestor before creating files or binding the environment", () => {
    const path = fixture(), install = join(path, "worker"), target = join(path, "unrelated"), env = join(path, "worker.env");
    mkdirSync(install); mkdirSync(target);
    writeFileSync(env, "INERT_FIXTURE=unchanged\r\n");
    const result = run(`${definitions(["ConvertTo-AwardPingSecurityIdentifier", "Get-AwardPingWorkerEnvAllowedSecurityIdentifiers", "Get-AwardPingProgramTextArchiveProblems", "Set-AwardPingProgramTextEnvironment"])}
      [void](New-Item -ItemType Junction -Path ${quote(join(install, "runtime"))} -Target ${quote(target)})
      try {
        Set-AwardPingProgramTextEnvironment -Path ${quote(env)} -InstallRoot ${quote(install)} -TaskSnapshots @()
        throw 'UNEXPECTED_SUCCESS'
      } catch {
        if ($_.Exception.Message -notmatch 'reparse point') { throw }
        [pscustomobject]@{ rejected=$true; targetFiles=@(Get-ChildItem -LiteralPath ${quote(target)} -Force).Count } | ConvertTo-Json
      }
    `);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ rejected: true, targetFiles: 0 });
    expect(readFileSync(env, "utf8")).toBe("INERT_FIXTURE=unchanged\r\n");
  }, 60000);
});
