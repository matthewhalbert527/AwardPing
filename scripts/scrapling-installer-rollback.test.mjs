import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { spawnSync } from "./test-support/bounded-test-process.mjs";
import { removeTestDirectory } from "./test-support/temp-directory.mjs";

const root = resolve(import.meta.dirname, "..");
const integration = join(root, "installer/windows/AwardPingScraplingIntegration.ps1");
const installer = join(root, "installer/windows/Install-AwardPingWorker.ps1");
const requirements = readFileSync(join(root, "scripts/scrapling/requirements.txt"));
const hash = value => createHash("sha256").update(value).digest("hex");
const quote = value => `'${String(value).replaceAll("'", "''")}'`;

function treeHashes(directory) {
  return Object.fromEntries(readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile()).map(entry => {
      const path = join(entry.parentPath, entry.name);
      return [path.slice(directory.length + 1), hash(readFileSync(path))];
    }).sort(([a], [b]) => a.localeCompare(b)));
}

describe.skipIf(process.platform !== "win32")("Scrapling staged update rollback (temporary files only)", () => {
  for (const previouslyEnabled of [false, true]) {
    it(`restores exact ${previouslyEnabled ? "previously enabled" : "legacy"} app/env/binding after the candidate receipt fails verification`, () => {
      const directory = mkdtempSync(join(tmpdir(), "awardping-scrapling-rollback-"));
      const install = join(directory, "worker");
      const app = join(install, "app");
      const stage = join(install, "stage");
      const runtime = join(install, "runtime", `scrapling-${hash(requirements)}`);
      const python = join(runtime, "Scripts/python.exe");
      const receipt = join(runtime, "runtime-receipt.json");
      const manifest = join(directory, "reviewed.json");
      try {
        mkdirSync(join(app, "reports"), { recursive: true });
        mkdirSync(join(stage, "scripts/scrapling"), { recursive: true });
        mkdirSync(join(runtime, "Scripts"), { recursive: true });
        writeFileSync(python, "inert fixture, never executed");
        writeFileSync(receipt, "inert receipt fixture");
        writeFileSync(join(app, "package.json"), '{"version":"old-release"}');
        writeFileSync(join(stage, "package.json"), '{"version":"candidate-release"}');
        writeFileSync(join(stage, "scripts/scrapling/requirements.txt"), requirements);
        writeFileSync(join(app, "reports/retained.json"), '{"keep":"history"}');
        writeFileSync(join(app, ".env.worker.local"), "FIXTURE_ONLY=keep\n" + (previouslyEnabled ? "AWARDPING_SCRAPLING_MANIFEST=old-manifest\nAWARDPING_SCRAPLING_PYTHON=old-python\n" : ""));
        if (previouslyEnabled) {
          writeFileSync(join(app, ".awardping-scrapling-manifest.json"), "old reviewed manifest bytes\n");
          writeFileSync(join(app, ".awardping-scrapling-runtime.json"), "old binding bytes\n");
        }
        writeFileSync(manifest, '{"fixture":"new reviewed manifest"}\n');
        const original = treeHashes(app);
        const manifestHash = hash(readFileSync(manifest));
        const receiptHash = hash(readFileSync(receipt));
        // Import definitions only. Never execute the installer entrypoint, a
        // package install, Python, Task Scheduler, credentials, or a worker.
        // Manifest semantics and real pinned runtime checks have separate suites.
        const source = `
          $ErrorActionPreference = 'Stop'
          . ${quote(integration)}
          $tokens = $null; $parseErrors = $null
          $ast = [System.Management.Automation.Language.Parser]::ParseFile(${quote(installer)}, [ref]$tokens, [ref]$parseErrors)
          if (@($parseErrors).Count) { throw 'Installer parse failed' }
          foreach ($name in @('Copy-AwardPingMutableAppState', 'Switch-ToStagedAwardPingApp', 'Restore-AwardPingAppAfterFailedUpdate')) {
            $definition = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $true)
            . ([scriptblock]::Create($definition.Extent.Text))
          }
          function Test-AwardPingScraplingManifest {
            param($AppDir, $Path, $ExpectedSha256)
            if ((Get-APSSha256 $Path) -cne $ExpectedSha256) { throw 'Manifest fixture hash mismatch' }
            return [pscustomobject]@{ source_count = 1 }
          }
          function Install-AwardPingScraplingRuntime {
            return [pscustomobject]@{ PythonExecutable = ${quote(python)}; RuntimeRoot = ${quote(runtime)}; RequirementsSha256 = ${quote(hash(requirements))}; ReceiptPath = ${quote(receipt)}; ReceiptSha256 = ${quote(receiptHash)}; Reused = $true }
          }
          function Remove-DirectoryWithRetry {
            param([string]$Path)
            if ([IO.Path]::GetFullPath($Path) -cne ${quote(join(install, "failed"))}) { throw 'Unexpected fixture cleanup target' }
            Remove-Item -LiteralPath $Path -Recurse -Force -ErrorAction Stop
          }
          $binding = Initialize-AwardPingScraplingInstallation -InstallRoot ${quote(install)} -AppDir ${quote(stage)} -ManifestPath ${quote(manifest)} -ManifestSha256 ${quote(manifestHash)}
          Copy-AwardPingMutableAppState -CurrentAppDir ${quote(app)} -StagingAppDir ${quote(stage)}
          Set-AwardPingScraplingEnvironment -Path ${quote(join(stage, ".env.worker.local"))} -FinalAppDir ${quote(app)} -Binding $binding
          Switch-ToStagedAwardPingApp -CurrentAppDir ${quote(app)} -StagingAppDir ${quote(stage)} -BackupAppDir ${quote(join(install, "backup"))}
          $envValues = @{ AWARDPING_SCRAPLING_MANIFEST = ${quote(join(app, ".awardping-scrapling-manifest.json"))}; AWARDPING_SCRAPLING_PYTHON = ${quote(python)} }
          Assert-AwardPingScraplingInstalledConfiguration -InstallRoot ${quote(install)} -AppDir ${quote(app)} -WorkerEnv $envValues
          $stagedEnv = [IO.File]::ReadAllText(${quote(join(app, ".env.worker.local"))})
          $candidateManifest = Get-APSSha256 ${quote(join(app, ".awardping-scrapling-manifest.json"))}
          [IO.File]::WriteAllText(${quote(receipt)}, 'changed receipt')
          $failure = ''; try { Assert-AwardPingScraplingInstalledConfiguration -InstallRoot ${quote(install)} -AppDir ${quote(app)} -WorkerEnv $envValues } catch { $failure = $_.Exception.Message }
          if (-not $failure) { throw 'Expected candidate verification to fail' }
          Restore-AwardPingAppAfterFailedUpdate -CurrentAppDir ${quote(app)} -BackupAppDir ${quote(join(install, "backup"))} -FailedAppDir ${quote(join(install, "failed"))}
          [pscustomobject]@{ candidateManifest = $candidateManifest; stagedEnv = $stagedEnv; failure = $failure } | ConvertTo-Json
        `;
        const output = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(source, "utf16le").toString("base64")], { timeout: 30000 });
        expect(output.error, output.stderr).toBeUndefined();
        expect(output.status, `${output.stdout}\n${output.stderr}`).toBe(0);
        const result = JSON.parse(output.stdout);
        expect(result.candidateManifest).toBe(manifestHash);
        expect(result.stagedEnv).toContain(`AWARDPING_SCRAPLING_MANIFEST=${join(app, ".awardping-scrapling-manifest.json")}`);
        expect(result.stagedEnv).toContain("FIXTURE_ONLY=keep");
        expect(result.failure).toContain("runtime binding");
        expect(treeHashes(app)).toEqual(original);
        expect(existsSync(python)).toBe(true);
        expect(existsSync(receipt)).toBe(true);
        expect(existsSync(join(install, "backup"))).toBe(false);
        expect(existsSync(join(install, "failed"))).toBe(false);
      } finally { removeTestDirectory(directory, "awardping-scrapling-rollback-"); }
    }, 45000);
  }
});
