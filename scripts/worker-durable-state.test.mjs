import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { spawnSync } from "./test-support/bounded-test-process.mjs";
import { removeTestDirectory } from "./test-support/temp-directory.mjs";

const installer = resolve(import.meta.dirname, "../installer/windows/Install-AwardPingWorker.ps1");
const quote = value => `'${value.replaceAll("'", "''")}'`;
const imports = `
  $ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'
  $tokens=$null;$errors=$null
  $ast=[Management.Automation.Language.Parser]::ParseFile(${quote(installer)},[ref]$tokens,[ref]$errors)
  if(@($errors).Count){throw 'Installer parse failed'}
  foreach($name in @('Copy-AwardPingMutableAppState','Switch-ToStagedAwardPingApp','Remove-DirectoryWithRetry','Restore-AwardPingAppAfterFailedUpdate','Assert-AwardPingNodeRuntime','Get-AwardPingTaskRestoreXml')) {
    $definition=$ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name},$true)
    . ([scriptblock]::Create($definition.Extent.Text))
  }
`;
function run(script) {
  const source = imports + script;
  const output = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(source, "utf16le").toString("base64")], { encoding: "utf8", timeout: 20000 });
  expect(output.error, `${output.stdout}\n${output.stderr}`).toBeUndefined();
  expect(output.status, `${output.stdout}\n${output.stderr}`).toBe(0);
  return output.stdout;
}

describe.skipIf(process.platform !== "win32")("durable worker history (isolated fixtures only)", () => {
  it("requires a supported Node version and actual SQLite import before worker staging", () => {
    const output = run(`
      $script:version='v22.12.0';$script:sqliteCode=0;$script:probes=0
      function Invoke-NodeFixture {
        if($args[0] -eq '--version') { $global:LASTEXITCODE=0; $script:version }
        else { $script:probes++; $global:LASTEXITCODE=$script:sqliteCode }
      }
      try { Assert-AwardPingNodeRuntime -NodePath Invoke-NodeFixture; throw 'UNEXPECTED' } catch { 'OLD='+$_.Exception.Message }
      $script:version='v22.13.0';Assert-AwardPingNodeRuntime -NodePath Invoke-NodeFixture
      $script:version='v23.0.0';$script:sqliteCode=1
      try { Assert-AwardPingNodeRuntime -NodePath Invoke-NodeFixture; throw 'UNEXPECTED' } catch { 'IMPORT='+$_.Exception.Message }
      Assert-AwardPingNodeRuntime -NodePath ${quote(process.execPath)}
      'PROBES='+$script:probes
    `);
    expect(output).toContain("OLD=AwardPing requires Node.js 22.13");
    expect(output).toContain("IMPORT=This Node.js runtime cannot use built-in SQLite");
    expect(output).toContain("PROBES=2");
  }, 30000);

  it("keeps the old principal and newly scheduled report action during updates", () => {
    const output = run(`
      $ns='http://schemas.microsoft.com/windows/2004/02/mit/task'
      $old='<Task xmlns="'+$ns+'"><Principals><Principal><UserId>OLD</UserId></Principal></Principals><Settings><Enabled>true</Enabled></Settings><Actions><Exec><Arguments>-Lane nightly_report</Arguments></Exec></Actions></Task>'
      $new='<Task xmlns="'+$ns+'"><Principals><Principal><UserId>NEW</UserId></Principal></Principals><Settings><Enabled>false</Enabled></Settings><Actions><Exec><Arguments>-Lane nightly_report -RunTrigger scheduled</Arguments></Exec></Actions></Task>'
      function Export-ScheduledTask { $new }
      $snapshot=[pscustomobject]@{TaskName='AwardPing Coverage Report';TaskPath='\\';Xml=$old}
      Get-AwardPingTaskRestoreXml -Snapshot $snapshot -ApplyTaskDefinitionUpdates $true
    `);
    expect(output).toContain("<UserId>OLD</UserId>");
    expect(output).toContain("-Lane nightly_report -RunTrigger scheduled");
    expect(output).toContain("<Enabled>false</Enabled>");
  }, 30000);

  it("renames history once, shares new writes across updates and deletes app trees without traversing junctions", () => {
    const directory = mkdtempSync(join(tmpdir(), "awardping-durable-state-"));
    try {
      const app = join(directory, "app"), stage = join(directory, "stage"), next = join(directory, "next");
      mkdirSync(join(app, "reports/nested"), { recursive: true }); mkdirSync(stage); mkdirSync(next);
      writeFileSync(join(app, ".env.worker.local"), "FIXTURE_ONLY=yes\n");
      const source = join(app, "reports/nested/history.json"); writeFileSync(source, '{"history":"preserved"}');
      const originalInode = statSync(source).ino;
      const output = run(`
        $InstallRoot=${quote(directory)}
        Copy-AwardPingMutableAppState -CurrentAppDir ${quote(app)} -StagingAppDir ${quote(stage)}
        Switch-ToStagedAwardPingApp -CurrentAppDir ${quote(app)} -StagingAppDir ${quote(stage)} -BackupAppDir ${quote(join(directory, "backup"))}
        [IO.File]::WriteAllText(${quote(join(app, "reports/new.json"))},'new-history')
        Remove-DirectoryWithRetry -Path ${quote(join(directory, "backup"))}
        Copy-AwardPingMutableAppState -CurrentAppDir ${quote(app)} -StagingAppDir ${quote(next)}
        Remove-DirectoryWithRetry -Path ${quote(next)}
        'LINK='+(Get-Item -LiteralPath ${quote(join(app, "reports"))}).LinkType
        'HISTORY='+[IO.File]::ReadAllText(${quote(join(directory, "data/reports/nested/history.json"))})
        'NEW='+[IO.File]::ReadAllText(${quote(join(directory, "data/reports/new.json"))})
      `);
      expect(output).toContain("LINK=Junction"); expect(output).toContain('HISTORY={"history":"preserved"}'); expect(output).toContain("NEW=new-history");
      expect(statSync(join(directory, "data/reports/nested/history.json")).ino).toBe(originalInode);
      expect(readFileSync(join(app, "reports/new.json"), "utf8")).toBe("new-history");
    } finally { removeTestDirectory(directory, "awardping-durable-state-"); }
  }, 30000);

  it("preflights every target and refuses conflicting history before moving any directory", () => {
    const directory = mkdtempSync(join(tmpdir(), "awardping-durable-conflict-"));
    try {
      const app = join(directory, "app"), stage = join(directory, "stage");
      mkdirSync(join(app, "reports"), { recursive: true }); mkdirSync(join(stage, "tmp"), { recursive: true });
      writeFileSync(join(app, ".env.worker.local"), "fixture\n"); writeFileSync(join(app, "reports/keep.txt"), "retained");
      const output = run(`
        try { Copy-AwardPingMutableAppState -CurrentAppDir ${quote(app)} -StagingAppDir ${quote(stage)}; throw 'UNEXPECTED' } catch { 'BLOCKED='+$_.Exception.Message }
        'DATA='+(Test-Path -LiteralPath ${quote(join(directory, "data"))})
        'CONTENT='+[IO.File]::ReadAllText(${quote(join(app, "reports/keep.txt"))})
      `);
      expect(output).toContain("Staged app unexpectedly contains mutable history"); expect(output).toContain("DATA=False"); expect(output).toContain("CONTENT=retained");
    } finally { removeTestDirectory(directory, "awardping-durable-conflict-"); }
  }, 30000);

  it("rejects a staged directory outside the installation before copying the environment", () => {
    const directory = mkdtempSync(join(tmpdir(), "awardping-durable-outside-"));
    try {
      const app = join(directory, "worker/app"), stage = join(directory, "outside");
      mkdirSync(app, { recursive: true }); mkdirSync(stage); writeFileSync(join(app, ".env.worker.local"), "fixture\n");
      expect(run(`try { Copy-AwardPingMutableAppState -CurrentAppDir ${quote(app)} -StagingAppDir ${quote(stage)}; throw 'UNEXPECTED' } catch { $_.Exception.Message }`)).toContain("sibling app directories");
    } finally { removeTestDirectory(directory, "awardping-durable-outside-"); }
  }, 30000);
});
