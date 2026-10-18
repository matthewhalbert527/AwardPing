import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const installerPath = join(root, "installer/windows/Install-AwardPingScraplingRuntime.ps1");
const installer = readFileSync(installerPath, "utf8");
const requirements = readFileSync(join(root, "scripts/scrapling/requirements.txt"));
const requirementsHash = createHash("sha256").update(requirements).digest("hex");
const fixtures = [];
const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "awardping-scrapling-installer-test-"));
  fixtures.push(directory);
  return directory;
}

function run(script, timeout = 30000) {
  const source = `$ErrorActionPreference = 'Stop'\n. ${quote(installerPath)}\n${script}`;
  return spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(source, "utf16le").toString("base64")], {
    encoding: "utf8", timeout, maxBuffer: 4 * 1024 * 1024,
  });
}

function result(script, timeout) {
  const output = run(script, timeout);
  expect(output.error, `${output.stdout}\n${output.stderr}`).toBeUndefined();
  expect(output.status, `${output.stdout}\n${output.stderr}`).toBe(0);
  return JSON.parse(output.stdout.trim());
}

afterEach(() => {
  for (const directory of fixtures.splice(0)) {
    const absolute = resolve(directory);
    if (!absolute.startsWith(resolve(tmpdir()) + sep) || !basename(absolute).startsWith("awardping-scrapling-installer-test-")) {
      throw new Error("Refusing cleanup outside the test-owned temp fixture");
    }
    rmSync(absolute, { recursive: true, force: true });
  }
});

describe("Scrapling runtime installer static contract", () => {
  it("pins by exact raw requirements hash and has no live worker activation commands", () => {
    expect(installer).toContain("'scrapling-' + $requirements.Sha256");
    expect(installer).toContain("[IO.FileMode]::CreateNew");
    expect(installer).toContain("'--no-deps'");
    expect(installer).toContain("'--only-binary=:all:'");
    expect(installer).toContain("'--no-input'");
    expect(installer).toContain("'PIP_CONFIG_FILE'] = 'NUL'");
    expect(installer).toContain("'--copies'");
    expect(installer).not.toMatch(/Register-ScheduledTask|Set-ScheduledTask|Stop-ScheduledTask|\.env\.worker\.local|Read-Host|Set-Content/);
    expect(installer.match(/Remove-Item/g)).toHaveLength(1);
    expect(installer).toContain("Remove-Item -LiteralPath $lockPath -ErrorAction Stop");
    expect(installer).not.toMatch(/Remove-Item[^\n]*-Recurse/);
  });

  it("keeps dependency-check and exact-version verification separate from pip installation", () => {
    expect(installer).toContain("'check') -Phase 'Dependency check'");
    expect(installer).toContain("$property.Value -cne $Requirements.Pins[$name]");
    expect(installer).toContain("Assert-APSFileInventory -Expected $receipt.files");
    expect(installer).toContain("Assert-APSFileInventory -Expected $receipt.base_files");
  });
});

describe.skipIf(process.platform !== "win32")("Scrapling runtime installer temp-only behavior", () => {
  it("parses on Windows PowerShell and dot-sourcing performs no installation", () => {
    const directory = fixture();
    const parsed = result(`
      $errors = $null; $tokens = $null
      $null = [System.Management.Automation.Language.Parser]::ParseFile(${quote(installerPath)}, [ref]$tokens, [ref]$errors)
      [pscustomobject]@{ errors = @($errors).Count; defined = [bool](Get-Command Install-AwardPingScraplingRuntime); items = @(Get-ChildItem -LiteralPath ${quote(directory)}).Count } | ConvertTo-Json
    `);
    expect(parsed).toEqual({ errors: 0, defined: true, items: 0 });
  });

  it("rejects ambiguous, broad, traversing, device and alternate-stream paths", () => {
    const invalid = ["", "relative", "C:relative", "C:\\", "\\\\server\\share\\worker", "\\\\?\\C:\\worker", "C:\\temp\\..\\worker", "C:\\temp\\.\\worker", "C:\\temp\\worker:stream", "C:\\temp\\worker*", "C:\\temp\\NUL", "C:\\temp\\worker.", "C:\\temp\\worker "];
    const parsed = result(`
      $values = @(${invalid.map(quote).join(",")})
      $rejected = @($values | ForEach-Object { try { $null = Assert-APSInstallRoot -Path $_; $false } catch { $true } })
      $rejected | ConvertTo-Json -Compress
    `);
    expect(parsed).toEqual(invalid.map(() => true));
  });

  it("preserves the exact requirements bytes/hash and rejects non-pins and duplicate aliases", () => {
    const directory = fixture();
    const good = join(directory, "requirements.txt");
    writeFileSync(good, requirements);
    const badContents = ["scrapling>=0.4.15\n", "scrapling==0.4.15\n-r other.txt\n", "scrapling==0.4.15; python_version > '3.9'\n", "scrapling==0.4.15\nfoo_bar==1\nfoo-bar==1\n", "scrapling @ https://example.com/a.whl\n", "scrapling==0.4.*\n", "foo==1\n"];
    const bad = badContents.map((content, index) => {
      const path = join(directory, `bad-${index}.txt`); writeFileSync(path, content); return path;
    });
    const parsed = result(`
      $good = Get-APSRequirements -Path ${quote(good)}
      $bad = @(${bad.map(quote).join(",")})
      [pscustomobject]@{ hash = $good.Sha256; scrapling = $good.Pins['scrapling']; count = $good.Pins.Count; rejected = @($bad | ForEach-Object { try { $null = Get-APSRequirements -Path $_; $false } catch { $true } }) } | ConvertTo-Json -Depth 5
    `);
    expect(parsed.hash).toBe(requirementsHash);
    expect(parsed.scrapling).toBe("0.4.15");
    expect(parsed.count).toBe(22);
    expect(parsed.rejected).toEqual(bad.map(() => true));
  });

  it("rejects junctions in an installation ancestor and inside a runtime", () => {
    const directory = fixture();
    const outside = join(directory, "outside");
    const runtime = join(directory, "runtime");
    mkdirSync(outside); mkdirSync(runtime);
    const junction = join(directory, "junction");
    const nested = join(runtime, "nested");
    symlinkSync(outside, junction, "junction"); symlinkSync(outside, nested, "junction");
    const parsed = result(`
      $ancestorRejected = $false; $treeRejected = $false
      try { $null = Resolve-APSLocalPath -Path ${quote(join(junction, "new"))} -Directory } catch { $ancestorRejected = $true }
      try { $null = Get-APSRuntimeInventory -Root ${quote(runtime)} } catch { $treeRejected = $true }
      [pscustomobject]@{ ancestorRejected = $ancestorRejected; treeRejected = $treeRejected } | ConvertTo-Json
    `);
    expect(parsed).toEqual({ ancestorRejected: true, treeRejected: true });
    expect(readdirSync(outside)).toEqual([]);
  });

  it("detects changed, missing and extra retained files while excluding only generated bytecode", () => {
    const directory = fixture();
    writeFileSync(join(directory, "package.py"), "original");
    const parsed = result(`
      $root = ${quote(directory)}
      $initial = @(Get-APSRuntimeInventory -Root $root)
      $null = New-Item -ItemType Directory -Path (Join-Path $root '__pycache__')
      [IO.File]::WriteAllText((Join-Path $root '__pycache__\\package.cpython-312.pyc'), 'generated')
      Assert-APSFileInventory -Expected $initial -Actual @(Get-APSRuntimeInventory -Root $root)
      [IO.File]::WriteAllText((Join-Path $root 'package.py'), 'changed')
      $changed = $false
      try { Assert-APSFileInventory -Expected $initial -Actual @(Get-APSRuntimeInventory -Root $root) } catch { $changed = $true }
      [IO.File]::WriteAllText((Join-Path $root 'package.py'), 'original')
      [IO.File]::WriteAllText((Join-Path $root 'extra.py'), 'extra')
      $extra = $false
      try { Assert-APSFileInventory -Expected $initial -Actual @(Get-APSRuntimeInventory -Root $root) } catch { $extra = $true }
      $missing = $false
      try { Assert-APSFileInventory -Expected $initial -Actual @() } catch { $missing = $true }
      [pscustomobject]@{ changed = $changed; extra = $extra; missing = $missing } | ConvertTo-Json
    `);
    expect(parsed).toEqual({ changed: true, extra: true, missing: true });
  });

  it("fails on wrong or unexpected package versions and dependency-check errors without an install", () => {
    const directory = fixture();
    const runtime = join(directory, "runtime");
    mkdirSync(join(runtime, "Scripts"), { recursive: true });
    writeFileSync(join(runtime, "Scripts/python.exe"), "inert fixture");
    writeFileSync(join(runtime, "pyvenv.cfg"), "include-system-site-packages = false\n");
    const parsed = result(`
      $root = ${quote(runtime)}
      function Get-APSPythonInfo { return [pscustomobject]@{ prefix = $root; base_prefix = ${quote(directory)}; version = @(3,12,14) } }
      $script:packages = '{"scrapling":"0.4.15","pip":"24.0"}'
      $script:failCheck = $false
      $script:failImport = $false
      $script:importCalls = 0
      function Invoke-APSProcess {
        param($Executable, $Arguments, $Phase, $TimeoutSeconds)
        if ($Phase -eq 'Dependency check') { if ($script:failCheck) { throw 'Dependency failure fixture' }; return '' }
        if ($Phase -eq 'Package version verification') { return $script:packages }
        if ($Phase -eq 'Scrapling native import verification') {
          $script:importCalls += 1
          if ($TimeoutSeconds -ne 30 -or $Arguments[-1] -notmatch 'from scrapling.fetchers import DynamicFetcher') { throw 'Invalid import smoke check' }
          if ($script:failImport) { throw 'Sensitive native DLL error fixture' }
          return ''
        }
        throw 'Unexpected subprocess phase'
      }
      $requirements = [pscustomobject]@{ Pins = [ordered]@{ scrapling = '0.4.15' } }
      $valid = Test-APSRuntimePython -RuntimeRoot $root -Requirements $requirements
      $script:packages = '{"scrapling":"0.4.14","pip":"24.0"}'
      $wrong = ''; try { $null = Test-APSRuntimePython -RuntimeRoot $root -Requirements $requirements } catch { $wrong = $_.Exception.Message }
      $script:packages = '{"scrapling":"0.4.15","extra-package":"1"}'
      $extra = ''; try { $null = Test-APSRuntimePython -RuntimeRoot $root -Requirements $requirements } catch { $extra = $_.Exception.Message }
      $script:packages = '{"pip":"24.0"}'
      $missing = ''; try { $null = Test-APSRuntimePython -RuntimeRoot $root -Requirements $requirements } catch { $missing = $_.Exception.Message }
      $script:failCheck = $true
      $failed = ''; try { $null = Test-APSRuntimePython -RuntimeRoot $root -Requirements $requirements } catch { $failed = $_.Exception.Message }
      $script:failCheck = $false; $script:failImport = $true
      $script:packages = '{"scrapling":"0.4.15","pip":"24.0"}'
      $importFailed = ''; try { $null = Test-APSRuntimePython -RuntimeRoot $root -Requirements $requirements } catch { $importFailed = $_.Exception.Message }
      [pscustomobject]@{ valid = $valid.Python; wrong = $wrong; extra = $extra; missing = $missing; failed = $failed; importFailed = $importFailed; importCalls = $script:importCalls } | ConvertTo-Json
    `);
    expect(parsed.valid).toBe(join(runtime, "Scripts/python.exe"));
    expect(parsed.wrong).toContain("Pinned package version mismatch");
    expect(parsed.missing).toContain("Pinned package version mismatch");
    expect(parsed.extra).toContain("Unexpected package");
    expect(parsed.failed).toBe("Dependency failure fixture");
    expect(parsed.importCalls).toBe(2);
    expect(parsed.importFailed).toContain("Scrapling native import verification failed");
    expect(parsed.importFailed).toContain("no runtime was activated");
    expect(parsed.importFailed).not.toContain("Sensitive native DLL error fixture");
  });

  it("round-trips native arguments, isolates Python/pip configuration and does not expose child errors", () => {
    const args = ["space here", 'literal "quotation"', "trailing\\", "", "éclair", "backslash\\\"quote"];
    const parsed = result(`
      $env:PYTHONPATH = 'test-secret-marker'; $env:PIP_INDEX_URL = 'test-secret-marker'
      $code = 'process.stdout.write(JSON.stringify({args:process.argv.slice(1),path:process.env.PYTHONPATH??null,index:process.env.PIP_INDEX_URL??null,config:process.env.PIP_CONFIG_FILE}))'
      $value = Invoke-APSProcess -Executable ${quote(process.execPath)} -Arguments (@('-e', $code) + @(${args.map(quote).join(",")})) -Phase 'Argument fixture' -TimeoutSeconds 10
      $failed = ''
      try { $null = Invoke-APSProcess -Executable ${quote(process.execPath)} -Arguments @('-e', 'console.error("test-secret-marker");process.exit(5)') -Phase 'Failure fixture' -TimeoutSeconds 10 } catch { $failed = $_.Exception.Message }
      [pscustomobject]@{ value = ($value | ConvertFrom-Json); failed = $failed } | ConvertTo-Json -Depth 5
    `);
    expect(parsed.value).toEqual({ args, path: null, index: null, config: "NUL" });
    expect(parsed.failed).toContain("exit 5");
    expect(parsed.failed).not.toContain("test-secret-marker");
  });

  it("times out and confirms termination of the exact spawned process tree", () => {
    const directory = fixture();
    const pidPath = join(directory, "pid.txt");
    const code = `require('node:fs').writeFileSync(${JSON.stringify(pidPath)},String(process.pid));setInterval(()=>{},1000)`;
    const parsed = result(`
      $message = ''
      try { $null = Invoke-APSProcess -Executable ${quote(process.execPath)} -Arguments @('-e', ${quote(code)}) -Phase 'Timeout fixture' -TimeoutSeconds 1 } catch { $message = $_.Exception.Message }
      $childId = [int](Get-Content -LiteralPath ${quote(pidPath)})
      [pscustomobject]@{ message = $message; running = [bool](Get-Process -Id $childId -ErrorAction SilentlyContinue) } | ConvertTo-Json
    `);
    expect(parsed.message).toContain("child process tree was stopped");
    expect(parsed.running).toBe(false);
  });

  it("preserves incomplete runtimes and stale locks without invoking Python or pip", () => {
    const directory = fixture();
    const install = join(directory, "worker");
    const source = join(directory, "source");
    const runtimeParent = join(install, "runtime");
    const runtime = join(runtimeParent, `scrapling-${requirementsHash}`);
    mkdirSync(runtime, { recursive: true });
    mkdirSync(join(source, "scripts/scrapling"), { recursive: true });
    writeFileSync(join(source, "scripts/scrapling/requirements.txt"), requirements);
    writeFileSync(join(runtime, "preserve.txt"), "unfinished");
    const parsed = result(`
      function Invoke-APSProcess { throw 'MUST_NOT_EXECUTE' }
      $message = ''
      try { $null = Install-AwardPingScraplingRuntime -InstallRoot ${quote(install)} -SourceRoot ${quote(source)} } catch { $message = $_.Exception.Message }
      [pscustomobject]@{ message = $message; locks = @(Get-ChildItem -LiteralPath ${quote(runtimeParent)} -Filter '*.lock' -Force).Count } | ConvertTo-Json
    `);
    expect(parsed.message).not.toContain("MUST_NOT_EXECUTE");
    expect(parsed.message).toContain("does not exist");
    expect(parsed.locks).toBe(0);
    expect(readFileSync(join(runtime, "preserve.txt"), "utf8")).toBe("unfinished");
    const lock = join(runtimeParent, `.scrapling-${requirementsHash}.install.lock`);
    writeFileSync(lock, "owned elsewhere");
    const refused = run(`Install-AwardPingScraplingRuntime -InstallRoot ${quote(install)} -SourceRoot ${quote(source)}`);
    expect(refused.status).not.toBe(0);
    expect(readFileSync(lock, "utf8")).toBe("owned elsewhere");
  });

  it("creates a receipt, verifies exact reuse, and fails before execution on tampering (mocked package install)", () => {
    const directory = fixture();
    const install = join(directory, "worker");
    const source = join(directory, "source");
    const base = join(directory, "base-python.exe");
    mkdirSync(install); mkdirSync(join(source, "scripts/scrapling"), { recursive: true });
    writeFileSync(base, "mock base Python; never executed");
    writeFileSync(join(source, "scripts/scrapling/requirements.txt"), requirements);
    const parsed = result(`
      $script:operations = @()
      function Find-APSPython { return [pscustomobject]@{ Path = ${quote(base)}; Info = [pscustomobject]@{ version = @(3,12,14); base_prefix = ${quote(directory)}; prefix = ${quote(directory)} } } }
      function Invoke-APSProcess {
        param($Executable, $Arguments, $Phase, $TimeoutSeconds)
        $script:operations += $Phase
        if ($Phase -eq 'Virtual environment creation') {
          $destination = $Arguments[-1]
          $null = New-Item -ItemType Directory -Path (Join-Path $destination 'Scripts')
          [IO.File]::WriteAllText((Join-Path $destination 'Scripts\\python.exe'), 'mock venv Python; never executed')
          [IO.File]::WriteAllText((Join-Path $destination 'pyvenv.cfg'), 'include-system-site-packages = false')
        }
        return ''
      }
      function Test-APSRuntimePython {
        param($RuntimeRoot, $Requirements)
        $script:operations += 'Verified fixture'
        return [pscustomobject]@{ Python = (Join-Path $RuntimeRoot 'Scripts\\python.exe'); Info = [pscustomobject]@{ version = @(3,12,14) }; Versions = $Requirements.Pins }
      }
      $first = Install-AwardPingScraplingRuntime -InstallRoot ${quote(install)} -SourceRoot ${quote(source)} -PythonExecutable ${quote(base)}
      $initialReceipt = Get-APSSha256 $first.ReceiptPath
      $second = Install-AwardPingScraplingRuntime -InstallRoot ${quote(install)} -SourceRoot ${quote(source)} -PythonExecutable ${quote(base)}
      $beforeTamper = $script:operations.Count
      [IO.File]::WriteAllText(${quote(base)}, 'changed base Python')
      $baseMessage = ''
      try { $null = Install-AwardPingScraplingRuntime -InstallRoot ${quote(install)} -SourceRoot ${quote(source)} } catch { $baseMessage = $_.Exception.Message }
      [IO.File]::WriteAllText(${quote(base)}, 'mock base Python; never executed')
      [IO.File]::WriteAllText($first.PythonExecutable, 'tampered')
      $message = ''
      try { $null = Install-AwardPingScraplingRuntime -InstallRoot ${quote(install)} -SourceRoot ${quote(source)} } catch { $message = $_.Exception.Message }
      [pscustomobject]@{ first = $first; second = $second; receiptUnchanged = ($initialReceipt -ceq (Get-APSSha256 $first.ReceiptPath)); operations = $script:operations; executedAfterTamper = ($script:operations.Count -ne $beforeTamper); message = $message; baseMessage = $baseMessage } | ConvertTo-Json -Depth 8
    `);
    expect(parsed.first.Reused).toBe(false);
    expect(parsed.second.Reused).toBe(true);
    expect(parsed.first.RequirementsSha256).toBe(requirementsHash);
    expect(parsed.first.RuntimeRoot).toBe(join(install, "runtime", `scrapling-${requirementsHash}`));
    expect(parsed.first.ReceiptSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(parsed.first.ReceiptSha256).toBe(parsed.second.ReceiptSha256);
    expect(parsed.receiptUnchanged).toBe(true);
    expect(parsed.operations).toEqual(["Virtual environment creation", "Pinned dependency installation", "Verified fixture", "Verified fixture"]);
    expect(parsed.executedAfterTamper).toBe(false);
    expect(parsed.message).toContain("integrity verification failed");
    expect(parsed.baseMessage).toContain("integrity verification failed");
    expect(existsSync(parsed.first.ReceiptPath)).toBe(true);
  });
});
