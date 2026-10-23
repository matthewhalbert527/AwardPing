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
function run(script) {
  return spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    { encoding: "utf8", env: nativeEnv(), timeout: 45000 });
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
      [pscustomobject]@{ files=$files; positive=$positive; cases=$cases } | ConvertTo-Json -Depth 5
    `);
    expect(result.status, result.stderr).toBe(0);
    const value = JSON.parse(result.stdout);
    expect(value.files).toHaveLength(14);
    expect(value.files).toContain("config\\program-text-monitoring.json");
    expect(value.files).toContain("scripts\\program-text-worker.mjs");
    expect(value.files).toContain("scripts\\program-text-ocr-windows.ps1");
    expect(value.files).toContain("scripts\\lib\\gemini-worker-policy.mjs");
    expect(value.files).toContain("scripts\\lib\\lane-failure-receipt.mjs");
    for (const row of value.cases) {
      expect(value.positive.some(problem => problem.includes(row.target))).toBe(false);
      expect(row.changed).toContain(`installed runtime hash mismatch: ${row.target}`);
    }
  }, 60000);

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

  it("protects and validates the archive before writing its environment binding", () => {
    const path = fixture(), env = join(path, "worker.env");
    writeFileSync(env, "INERT_FIXTURE=yes\r\n");
    const result = run(`${definitions(["ConvertTo-AwardPingSecurityIdentifier", "Get-AwardPingWorkerEnvAllowedSecurityIdentifiers", "Get-AwardPingProgramTextArchiveProblems", "Set-AwardPingProgramTextEnvironment"])}
      Set-AwardPingProgramTextEnvironment -Path ${quote(env)} -InstallRoot ${quote(path)} -TaskSnapshots @()
      $archive = Join-Path ${quote(path)} 'runtime\\program-text-archive'
      $positive = @(Get-AwardPingProgramTextArchiveProblems -Path $archive -TaskSnapshots @())
      [IO.File]::WriteAllText((Join-Path $archive 'inert.txt'), 'fixture')
      $inherited = @((Get-Acl -LiteralPath (Join-Path $archive 'inert.txt')).Access | Where-Object IsInherited).Count
      $acl = Get-Acl -LiteralPath $archive
      $everyone = [Security.Principal.SecurityIdentifier]::new('S-1-1-0')
      [void]$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($everyone, 'Read', 'Allow'))
      [IO.Directory]::SetAccessControl($archive, $acl)
      $tampered = @(Get-AwardPingProgramTextArchiveProblems -Path $archive -TaskSnapshots @())
      [pscustomobject]@{ positive=$positive; inherited=$inherited; tampered=$tampered; protected=(Get-Acl -LiteralPath $archive).AreAccessRulesProtected } | ConvertTo-Json -Depth 4
    `);
    expect(result.status, result.stderr).toBe(0);
    const value = JSON.parse(result.stdout);
    expect(value.positive).toEqual([]);
    expect(value.inherited).toBeGreaterThan(0);
    expect(value.protected).toBe(true);
    expect(value.tampered.join(" ")).toContain("unapproved SID S-1-1-0");
    expect(readFileSync(env, "utf8")).toBe(`INERT_FIXTURE=yes\r\nAWARDPING_PROGRAM_TEXT_ARCHIVE=${join(path, "runtime/program-text-archive")}\r\n`);
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
