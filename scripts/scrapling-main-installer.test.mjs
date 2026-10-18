import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const integration = join(root, "installer/windows/AwardPingScraplingIntegration.ps1");
const installer = readFileSync(join(root, "installer/windows/Install-AwardPingWorker.ps1"), "utf8");
const requirements = readFileSync(join(root, "scripts/scrapling/requirements.txt"));
const hash = value => createHash("sha256").update(value).digest("hex");
const requirementsHash = hash(requirements);
const quote = value => `'${String(value).replaceAll("'", "''")}'`;
const fixtures = [];
function fixture() {
  const path = mkdtempSync(join(tmpdir(), "awardping-scrapling-integration-test-"));
  fixtures.push(path);
  return path;
}
function run(script) {
  const source = `$ErrorActionPreference = 'Stop'\n. ${quote(integration)}\n${script}`;
  return spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(source, "utf16le").toString("base64")], { encoding: "utf8", timeout: 45000, maxBuffer: 4 * 1024 * 1024 });
}
function result(script) {
  const output = run(script);
  expect(output.error, output.stderr).toBeUndefined();
  expect(output.status, `${output.stdout}\n${output.stderr}`).toBe(0);
  return JSON.parse(output.stdout.trim());
}
afterEach(() => {
  for (const directory of fixtures.splice(0)) {
    const absolute = resolve(directory);
    if (!absolute.startsWith(resolve(tmpdir()) + sep) || !basename(absolute).startsWith("awardping-scrapling-integration-test-")) throw new Error("Unsafe fixture cleanup");
    rmSync(absolute, { recursive: true, force: true });
  }
});

describe("main installer opt-in wiring", () => {
  it("stages runtime and manifest before pausing tasks, and verifies before task restore", () => {
    const update = installer.slice(installer.indexOf('if ($UpdateOnly) {', installer.indexOf('$strictRetirementCommitted = $false')));
    expect(update.indexOf("Initialize-AwardPingScraplingInstallation")).toBeGreaterThan(update.indexOf("Install-Dependencies -AppDir $stagingAppDir"));
    expect(update.indexOf("Initialize-AwardPingScraplingInstallation")).toBeLessThan(update.indexOf("$taskSnapshots = @("));
    expect(update.indexOf("Set-AwardPingScraplingEnvironment")).toBeLessThan(update.indexOf("Switch-ToStagedAwardPingApp"));
    expect(installer).toContain("if ($EnableScrapling) {");
    expect(installer.match(/Initialize-AwardPingScraplingInstallation -InstallRoot/g)).toHaveLength(2);
    expect(installer).toContain("Assert-AwardPingScraplingInstalledConfiguration -InstallRoot $InstallRoot -AppDir $AppDir -WorkerEnv $workerEnv");
    expect(installer).toContain("Get-AwardPingScraplingRuntimeRelativePaths");
    expect(installer).toContain("Restore-AwardPingAppAfterFailedUpdate");
  });
});

describe.skipIf(process.platform !== "win32")("Scrapling main installer temp-only behavior", () => {
  it("parses both scripts without activating main and preserves caller parameters when sourced", () => {
    const parsed = result(`
      $InstallRoot = 'C:\\preserve-this-root'; $SourceRoot = 'C:\\preserve-source'; $PythonExecutable = 'C:\\preserve-python.exe'
      . ${quote(integration)}
      $errors = $null; $tokens = $null
      $null = [System.Management.Automation.Language.Parser]::ParseFile(${quote(join(root, "installer/windows/Install-AwardPingWorker.ps1"))}, [ref]$tokens, [ref]$errors)
      [pscustomobject]@{ errors = @($errors).Count; install = $InstallRoot; source = $SourceRoot; python = $PythonExecutable } | ConvertTo-Json
    `);
    expect(parsed).toEqual({ errors: 0, install: "C:\\preserve-this-root", source: "C:\\preserve-source", python: "C:\\preserve-python.exe" });
  });

  it("requires and hash-checks the collector's retained browser projection script", () => {
    const files = result("ConvertTo-Json -InputObject @(Get-AwardPingScraplingRuntimeRelativePaths)");
    expect(files).toContain("scripts\\scrapling\\visible-document.js");
    expect(files).toContain("scripts\\lib\\scrapling-runtime-binding.mjs");
    expect(files).toContain("scripts\\lib\\pdf-text-coverage.mjs");
    expect(files).toContain("scripts\\lib\\rendered-html-comparison.mjs");
    expect(files).toContain("scripts\\lib\\structured-html-content.mjs");
    const validation = installer.slice(installer.indexOf("function Get-AwardPingInstalledRuntimeProblems {"), installer.indexOf("function Get-AwardPingTaskRestoreXml {"));
    expect(validation.match(/Get-AwardPingScraplingRuntimeRelativePaths/g)).toHaveLength(2);
    expect(validation).toContain("$requiredPaths += @(Get-AwardPingScraplingRuntimeRelativePaths");
    expect(validation).toContain("Source = Join-Path $AppSourceRoot $relativePath; Target = Join-Path $AppDir $relativePath");
  });

  it("validates the new candidate import closure even when disabled without requiring it in legacy rollback", () => {
    const parsed = result(`
      $parseErrors = $null; $tokens = $null
      $ast = [System.Management.Automation.Language.Parser]::ParseFile(${quote(join(root, "installer/windows/Install-AwardPingWorker.ps1"))}, [ref]$tokens, [ref]$parseErrors)
      $definition = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Get-AwardPingInstalledRuntimeProblems' }, $true)
      . ([scriptblock]::Create($definition.Extent.Text))
      $script:dependencyCalls = 0
      $script:dependencies = @(Get-AwardPingScraplingRuntimeRelativePaths)
      function Get-AwardPingScraplingRuntimeRelativePaths { $script:dependencyCalls += 1; return $script:dependencies }
      function Get-AwardPingRootedActionPaths { return @() }
      function Get-MissingWorkerRuntimeDependencies { return @() }
      function Get-AwardPingInteractiveTaskNames { return @() }
      function Get-AwardPingManagedTaskScheduleProblems { return @() }
      function Test-Path { return $false }
      $legacyProblems = @(Get-AwardPingInstalledRuntimeProblems -InstallRoot 'C:\\worker' -AppDir 'C:\\worker\\app' -TaskSnapshots @() -RequireManagedRuntime $false)
      $legacyCalls = $script:dependencyCalls
      $candidateProblems = @(Get-AwardPingInstalledRuntimeProblems -InstallRoot 'C:\\worker' -AppDir 'C:\\worker\\app' -TaskSnapshots @() -RequireManagedRuntime $true)
      [pscustomobject]@{ legacyCalls = $legacyCalls; candidateCalls = $script:dependencyCalls; legacyProblems = $legacyProblems; candidateProblems = $candidateProblems } | ConvertTo-Json -Depth 3
    `);
    expect(parsed.legacyCalls).toBe(0);
    expect(parsed.candidateCalls).toBe(1);
    expect(parsed.legacyProblems.join("\n")).not.toMatch(/scrapling|rendered-html|structured-html|visible-document/);
    expect(parsed.candidateProblems.join("\n")).toContain("scripts\\scrapling\\visible-document.js");
    expect(parsed.candidateProblems.join("\n")).toContain("scripts\\lib\\rendered-html-comparison.mjs");
    expect(parsed.candidateProblems.join("\n")).toContain("scripts\\lib\\scrapling-runtime-binding.mjs");
    expect(parsed.candidateProblems.join("\n")).toContain("scripts\\lib\\pdf-text-coverage.mjs");
    expect(parsed.legacyProblems.join("\n")).not.toContain("scripts\\lib\\pdf-text-coverage.mjs");
    expect(installer).toContain("-RequireManagedRuntime $false)");
  });

  it("defaults off and refuses partial, implicit or inherited configuration", () => {
    const parsed = result(`
      Assert-AwardPingScraplingOptIn -Enabled $false
      $errors = @()
      foreach ($options in @(
        @{ Enabled = $false; ManifestPath = 'C:\\manifest.json' },
        @{ Enabled = $false; PythonExecutable = 'C:\\python.exe' },
        @{ Enabled = $false; ExistingEnv = @{ AWARDPING_SCRAPLING_MANIFEST = 'old' } },
        @{ Enabled = $true; ManifestPath = 'C:\\manifest.json' },
        @{ Enabled = $true; ManifestPath = 'C:\\manifest.json'; ManifestSha256 = 'bad' }
      )) { try { Assert-AwardPingScraplingOptIn @options; $errors += $false } catch { $errors += $true } }
      Assert-AwardPingScraplingOptIn -Enabled $true -ManifestPath 'C:\\manifest.json' -ManifestSha256 ${quote("a".repeat(64))}
      ConvertTo-Json -InputObject $errors
    `);
    expect(parsed).toEqual([true, true, true, true, true]);
  });

  it("uses the real offline source-manifest validator and exact raw hash", () => {
    const directory = fixture();
    const path = join(directory, "reviewed.json");
    const ids = Array.from({ length: 25 }, (_, i) => `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`);
    const manifest = { schema: "awardping.scrapling-source-manifest.v1", profile: "scrapling-evidence-v1", reviewed_at: "2026-10-15T12:00:00Z", award_ids: ids, sources: [{ id: "10000000-0000-0000-0000-000000000001", award_id: ids[0], url: "https://example.edu/rules", kind: "html", roles: ["eligibility"] }] };
    const bytes = JSON.stringify(manifest);
    writeFileSync(path, bytes);
    const parsed = result(`
      $valid = Test-AwardPingScraplingManifest -AppDir ${quote(root)} -Path ${quote(path)} -ExpectedSha256 ${quote(hash(bytes))}
      $failed = ''; try { Test-AwardPingScraplingManifest -AppDir ${quote(root)} -Path ${quote(path)} -ExpectedSha256 ${quote("a".repeat(64))} } catch { $failed = $_.Exception.Message }
      [pscustomobject]@{ valid = $valid; failed = $failed } | ConvertTo-Json
    `);
    expect(parsed.valid).toMatchObject({ source_count: 1, award_count: 25 });
    expect(parsed.failed).toContain("reviewed file/hash");
    manifest.sources[0].url = "http://127.0.0.1/";
    const invalid = JSON.stringify(manifest);
    writeFileSync(path, invalid);
    const rejected = run(`Test-AwardPingScraplingManifest -AppDir ${quote(root)} -Path ${quote(path)} -ExpectedSha256 ${quote(hash(invalid))}`);
    expect(rejected.status).not.toBe(0);
    expect(rejected.stderr).toContain("Scrapling manifest verification failed");
  }, 30000);

  it("stages exact manifest and receipt bindings, refuses tampering and never overwrites them", () => {
    const directory = fixture();
    const install = join(directory, "worker");
    const app = join(install, "app");
    const runtime = join(install, "runtime", `scrapling-${requirementsHash}`);
    const python = join(runtime, "Scripts/python.exe");
    const receiptPath = join(runtime, "runtime-receipt.json");
    const sourceManifest = join(directory, "reviewed.json");
    mkdirSync(join(app, "scripts/scrapling"), { recursive: true });
    mkdirSync(join(runtime, "Scripts"), { recursive: true });
    writeFileSync(join(app, "scripts/scrapling/requirements.txt"), requirements);
    writeFileSync(python, "inert fixture; never executed");
    writeFileSync(receiptPath, "inert receipt fixture");
    writeFileSync(sourceManifest, '{"fixture":true}\n');
    const manifestHash = hash(readFileSync(sourceManifest));
    const receiptHash = hash(readFileSync(receiptPath));
    const parsed = result(`
      $script:runtimeCalls = 0
      function Install-AwardPingScraplingRuntime {
        $script:runtimeCalls += 1
        return [pscustomobject]@{ PythonExecutable = ${quote(python)}; RuntimeRoot = ${quote(runtime)}; RequirementsSha256 = ${quote(requirementsHash)}; ReceiptPath = ${quote(receiptPath)}; ReceiptSha256 = ${quote(receiptHash)}; Reused = $true }
      }
      function Test-AwardPingScraplingManifest {
        param($AppDir, $Path, $ExpectedSha256)
        if ((Get-APSSha256 $Path) -cne $ExpectedSha256) { throw 'Manifest fixture hash mismatch' }
        return [pscustomobject]@{ source_count = 1 }
      }
      $binding = Initialize-AwardPingScraplingInstallation -InstallRoot ${quote(install)} -AppDir ${quote(app)} -ManifestPath ${quote(sourceManifest)} -ManifestSha256 ${quote(manifestHash)}
      $envValues = @{ AWARDPING_SCRAPLING_MANIFEST = (Join-Path ${quote(app)} '.awardping-scrapling-manifest.json'); AWARDPING_SCRAPLING_PYTHON = ${quote(python)} }
      Assert-AwardPingScraplingInstalledConfiguration -InstallRoot ${quote(install)} -AppDir ${quote(app)} -WorkerEnv $envValues
      $overwritten = $false
      try { $null = Initialize-AwardPingScraplingInstallation -InstallRoot ${quote(install)} -AppDir ${quote(app)} -ManifestPath ${quote(sourceManifest)} -ManifestSha256 ${quote(manifestHash)} } catch { $overwritten = $true }
      [IO.File]::WriteAllText(${quote(receiptPath)}, 'changed receipt')
      $tamper = ''; try { Assert-AwardPingScraplingInstalledConfiguration -InstallRoot ${quote(install)} -AppDir ${quote(app)} -WorkerEnv $envValues } catch { $tamper = $_.Exception.Message }
      [pscustomobject]@{ binding = $binding; refusedOverwrite = $overwritten; tamper = $tamper; runtimeCalls = $script:runtimeCalls } | ConvertTo-Json
    `);
    expect(parsed.binding).toEqual({ schema: "awardping.scrapling-installation.v1", manifest_sha256: manifestHash, source_count: 1, requirements_sha256: requirementsHash, python_executable: python, runtime_root: runtime, receipt_path: receiptPath, receipt_sha256: receiptHash });
    expect(parsed.refusedOverwrite).toBe(true);
    expect(parsed.tamper).toContain("runtime binding");
    expect(parsed.runtimeCalls).toBe(2);
    expect(readFileSync(join(app, ".awardping-scrapling-manifest.json"), "utf8")).toBe(readFileSync(sourceManifest, "utf8"));
    expect(existsSync(python)).toBe(true);
  });

  it("keeps legacy environment untouched, sets only two opt-in keys and rejects unsafe path syntax", () => {
    const directory = fixture();
    const envPath = join(directory, ".env.worker.local");
    const original = "SECRET_FIXTURE=keep-me\nUNRELATED=keep-too\nAWARDPING_SCRAPLING_MANIFEST=old\nAWARDPING_SCRAPLING_PYTHON=old\n";
    writeFileSync(envPath, original);
    const parsed = result(`
      Set-AwardPingScraplingEnvironment -Path ${quote(envPath)} -FinalAppDir 'C:\\worker\\app' -Binding $null
      $before = [IO.File]::ReadAllText(${quote(envPath)})
      Set-AwardPingScraplingEnvironment -Path ${quote(envPath)} -FinalAppDir 'C:\\worker\\app' -Binding ([pscustomobject]@{python_executable = 'C:\\worker\\runtime\\python.exe'})
      $after = [IO.File]::ReadAllText(${quote(envPath)})
      $failed = $false; try { Set-AwardPingScraplingEnvironment -Path ${quote(envPath)} -FinalAppDir 'C:\\worker#bad\\app' -Binding ([pscustomobject]@{python_executable = 'safe'}) } catch { $failed = $true }
      [pscustomobject]@{ before = $before; after = $after; failed = $failed } | ConvertTo-Json
    `);
    expect(parsed.before).toBe(original);
    expect(parsed.after).toContain("SECRET_FIXTURE=keep-me\nUNRELATED=keep-too");
    expect(parsed.after.match(/AWARDPING_SCRAPLING_MANIFEST=/g)).toHaveLength(1);
    expect(parsed.after.match(/AWARDPING_SCRAPLING_PYTHON=/g)).toHaveLength(1);
    expect(parsed.after).toContain("AWARDPING_SCRAPLING_MANIFEST=C:\\worker\\app\\.awardping-scrapling-manifest.json");
    expect(parsed.failed).toBe(true);
  });

  it("keeps an existing installation intact when runtime preparation fails", () => {
    const directory = fixture();
    const install = join(directory, "worker");
    const stage = join(install, ".app-update-fixture");
    const app = join(install, "app");
    mkdirSync(stage, { recursive: true }); mkdirSync(app);
    writeFileSync(join(app, "keep.txt"), "current app");
    const parsed = result(`
      function Test-AwardPingScraplingManifest { return [pscustomobject]@{ source_count = 1 } }
      function Install-AwardPingScraplingRuntime { throw 'native import fixture failure' }
      $failed = ''; try { $null = Initialize-AwardPingScraplingInstallation -InstallRoot ${quote(install)} -AppDir ${quote(stage)} -ManifestPath 'unused' -ManifestSha256 ${quote("a".repeat(64))} } catch { $failed = $_.Exception.Message }
      [pscustomobject]@{ failed = $failed; files = @(Get-ChildItem -LiteralPath ${quote(stage)} -Force).Count } | ConvertTo-Json
    `);
    expect(parsed.failed).toBe("native import fixture failure");
    expect(parsed.files).toBe(0);
    expect(readFileSync(join(app, "keep.txt"), "utf8")).toBe("current app");
  });
});
