import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const integration = join(root, "installer/windows/AwardPingScraplingIntegration.ps1");
const helperPaths = [
  "scripts/lib/source-html-evidence.mjs",
  "scripts/lib/source-html-review-contract.mjs",
  "scripts/lib/source-html-worker-state.mjs",
  "scripts/lib/source-intake-request-scope.mjs",
];
const quote = value => `'${String(value).replaceAll("'", "''")}'`;
const fixtures = [];
function windowsPowerShellFixtureEnv() {
  // Do not inherit a PowerShell 7 module path into the native Windows PS5 child.
  // This affects only this fixture process; native Get-FileHash remains real.
  const windowsRoot = realpathSync(process.env.SystemRoot);
  const modules = realpathSync(join(windowsRoot, "System32/WindowsPowerShell/v1.0/Modules"));
  if (!modules.toLowerCase().startsWith(windowsRoot.toLowerCase() + sep)) throw new Error("Unexpected native module location");
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toLowerCase() !== "psmodulepath"));
  return { ...env, PSModulePath: modules };
}
afterEach(() => {
  for (const path of fixtures.splice(0)) {
    const absolute = resolve(path);
    if (dirname(absolute) !== resolve(tmpdir()) || !basename(absolute).startsWith("awardping-source-html-installer-")) {
      throw new Error("Unsafe test-owned fixture cleanup");
    }
    rmSync(absolute, { recursive: true, force: true });
  }
});

const installerPaths = [join(root, "installer/windows/Install-AwardPingWorker.ps1")];
const frozenInstaller = join(root, "tmp/release-date-card-20260908/installer/windows/Install-AwardPingWorker.ps1");
if (existsSync(frozenInstaller) && frozenInstaller !== installerPaths[0]) installerPaths.push(frozenInstaller);

describe.skipIf(process.platform !== "win32")("source-only and bounded-intake installer helper integrity", () => {
  for (const [index, installer] of installerPaths.entries()) {
    it(`requires exact helper bytes using the actual ${index ? "a68 isolated" : "current"} runtime guard`, () => {
      const directory = mkdtempSync(join(tmpdir(), "awardping-source-html-installer-"));
      fixtures.push(directory);
      const source = join(directory, "source"), app = join(directory, "worker/app");
      for (const path of helperPaths) for (const destination of [source, app]) {
        const target = join(destination, path);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, readFileSync(join(root, path)));
      }
      // Import only the real guard definition and integration function list.
      // Native file existence/SHA-256 operations remain real. Unrelated task,
      // dependency and scheduler checks are stubbed; no installer main runs.
      const script = `
        $ErrorActionPreference = 'Stop'
        . ${quote(integration)}
        $parseErrors = $null; $tokens = $null
        $ast = [System.Management.Automation.Language.Parser]::ParseFile(${quote(installer)}, [ref]$tokens, [ref]$parseErrors)
        if (@($parseErrors).Count) { throw 'Installer fixture failed to parse' }
        $definition = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Get-AwardPingInstalledRuntimeProblems' }, $true)
        if (-not $definition) { throw 'Actual runtime guard is missing' }
        . ([scriptblock]::Create($definition.Extent.Text))
        function Get-AwardPingRootedActionPaths { return @() }
        function Get-MissingWorkerRuntimeDependencies { return @() }
        function Get-AwardPingInteractiveTaskNames { return @() }
        function Get-AwardPingManagedTaskScheduleProblems { return @() }
        $helperPaths = @(${helperPaths.map(path => quote(path.replaceAll("/", "\\"))).join(", ")})
        $listed = @(Get-AwardPingScraplingRuntimeRelativePaths)
        $positive = @(Get-AwardPingInstalledRuntimeProblems -InstallRoot ${quote(join(directory, "worker"))} -AppDir ${quote(app)} -AppSourceRoot ${quote(source)} -TaskSnapshots @() -RequireManagedRuntime $true)
        $cases = @()
        foreach ($relative in $helperPaths) {
          $target = Join-Path ${quote(app)} $relative
          $original = [IO.File]::ReadAllBytes($target)
          $held = $target + '.held'
          try {
            Move-Item -LiteralPath $target -Destination $held -ErrorAction Stop
            $missing = @(Get-AwardPingInstalledRuntimeProblems -InstallRoot ${quote(join(directory, "worker"))} -AppDir ${quote(app)} -AppSourceRoot ${quote(source)} -TaskSnapshots @() -RequireManagedRuntime $true)
          } finally {
            if (Test-Path -LiteralPath $held) { Move-Item -LiteralPath $held -Destination $target -ErrorAction Stop }
          }
          try {
            [IO.File]::WriteAllText($target, 'tampered inert fixture; never executed')
            $changed = @(Get-AwardPingInstalledRuntimeProblems -InstallRoot ${quote(join(directory, "worker"))} -AppDir ${quote(app)} -AppSourceRoot ${quote(source)} -TaskSnapshots @() -RequireManagedRuntime $true)
          } finally { [IO.File]::WriteAllBytes($target, $original) }
          $cases += [pscustomobject]@{ relative = $relative; target = $target; missing = $missing; changed = $changed }
        }
        $legacy = @(Get-AwardPingInstalledRuntimeProblems -InstallRoot ${quote(join(directory, "worker"))} -AppDir ${quote(app)} -AppSourceRoot ${quote(source)} -TaskSnapshots @() -RequireManagedRuntime $false)
        [pscustomobject]@{ listed = $listed; positive = $positive; cases = $cases; legacy = $legacy } | ConvertTo-Json -Depth 6
      `;
      const output = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
        { encoding: "utf8", timeout: 45000, maxBuffer: 8 * 1024 * 1024, env: windowsPowerShellFixtureEnv() });
      expect(output.error, output.stderr).toBeUndefined();
      expect(output.status, `${output.stdout}\n${output.stderr}`).toBe(0);
      const result = JSON.parse(output.stdout);
      expect(result.cases).toHaveLength(helperPaths.length);
      for (const relative of helperPaths) {
        const windowsPath = relative.replaceAll("/", "\\");
        expect(result.listed.filter(path => path === windowsPath)).toHaveLength(1);
        expect(result.positive.filter(problem => problem.includes(windowsPath))).toEqual([]);
        expect(result.legacy.filter(problem => problem.includes(windowsPath))).toEqual([]);
        const row = result.cases.find(value => value.relative === windowsPath);
        expect(row.target.startsWith(resolve(directory) + sep)).toBe(true);
        expect(row.missing).toContain(`missing action/runtime path: ${row.target}`);
        expect(row.missing.some(problem => problem.startsWith("cannot verify installed runtime hash:") && problem.endsWith(`-> ${row.target}`))).toBe(true);
        expect(row.changed).toContain(`installed runtime hash mismatch: ${row.target}`);
      }
    }, 60000);
  }
});
