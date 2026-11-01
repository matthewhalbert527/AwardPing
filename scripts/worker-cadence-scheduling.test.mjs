import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import { spawnSync, stopTestChildren } from "./test-support/bounded-test-process.mjs";

afterEach(stopTestChildren);
const installer = readFileSync(resolve(import.meta.dirname, "../installer/windows/Install-AwardPingWorker.ps1"), "utf8");
const start = installer.indexOf("function Get-AwardPingDailyCoverageBoundaryUtc {");
const end = installer.indexOf("\nfunction Get-AwardPingManagedTaskScheduleProblems {", start);
const helper = installer.slice(start, end);
const fixture = [
  "$ErrorActionPreference='Stop'",
  helper,
  "$script:boundary='2026-07-16T18:00:00-05:00';$script:bad='';$script:days=1",
  "function Test-AwardPingTaskTargetsInstallRoot { param($Task,$InstallRoot);$true }",
  "function Get-ScheduledTask { param($TaskName,$ErrorAction);if($script:bad -eq 'missing' -and $TaskName -like '* 2'){return};[pscustomobject]@{TaskName=$TaskName;TaskPath='\\'} }",
  "function Export-ScheduledTask {",
  " param($TaskName,$TaskPath,$ErrorAction)",
  " $b=$script:boundary;$kind='CalendarTrigger';$extra='';$days=$script:days",
  " if($TaskName -like '* 2'){switch($script:bad){'mismatch'{$b='2026-07-16T17:00:00-05:00'} 'zone'{$b='2026-07-16T18:00:00'} 'interval'{$days=2} 'repetition'{$extra='<Repetition><Interval>PT1H</Interval></Repetition>'} 'kind'{$kind='TimeTrigger'} 'duplicate'{$extra='</CalendarTrigger><CalendarTrigger>'}}}",
  " '<Task xmlns=\"http://schemas.microsoft.com/windows/2004/02/mit/task\"><Triggers><'+$kind+'><StartBoundary>'+$b+'</StartBoundary><ScheduleByDay><DaysInterval>'+$days+'</DaysInterval></ScheduleByDay>'+$extra+'</'+$kind+'></Triggers></Task>'",
  "}",
].join("\n");

function run(script) {
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", fixture + "\n" + script], { encoding: "utf8" });
  expect(result.status, result.stderr || result.stdout).toBe(0);
  expect(result.stderr).toBe("");
  return result.stdout;
}

describe("downstream schedule cadence", () => {
  (process.platform === "win32" ? it : it.skip)("derives the daily UTC report from real collector offsets through DST and midnight", () => {
    const cases = [
      ["2026-07-16T18:00:00-05:00", "2026-07-16T22:00:00Z", "2026-07-16T23:30:00Z"],
      ["2026-12-01T18:00:00-06:00", "2026-12-01T23:50:00Z", "2026-12-02T00:30:00Z"],
      ["2026-12-01T18:00:00-06:00", "2026-12-02T00:31:00Z", "2026-12-03T00:30:00Z"],
      ["2026-10-31T18:00:00-05:00", "2026-11-01T06:30:00Z", "2026-11-01T23:30:00Z"],
      ["2026-10-31T18:50:00-05:00", "2026-10-31T23:55:00Z", "2026-11-01T00:20:00Z"],
      ["2026-07-16T18:00:00-05:00", "2026-07-16T23:29:45Z", "2026-07-17T23:30:00Z"],
    ];
    const script = cases.map(([boundary, now], n) => `$script:boundary='${boundary}';$value=Get-AwardPingDailyCoverageBoundaryUtc -InstallRoot 'C:\\Fixture' -NowUtc ([DateTimeOffset]'${now}');'CASE${n}='+$value.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'")`).join("\n");
    const output = run(script);
    cases.forEach(([, , expected], n) => expect(output).toContain(`CASE${n}=${expected}`));
  }, 20_000);

  (process.platform === "win32" ? it : it.skip)("rejects inconsistent, missing or non-daily collector triggers", () => {
    const cases = ["mismatch", "zone", "interval", "repetition", "kind", "duplicate", "missing"];
    const output = run(cases.map(name => `$script:bad='${name}';try{$null=Get-AwardPingDailyCoverageBoundaryUtc -InstallRoot 'C:\\Fixture';'UNEXPECTED:${name}'}catch{'REJECTED:${name}'}`).join("\n"));
    expect(output).not.toContain("UNEXPECTED");
    cases.forEach(name => expect(output).toContain(`REJECTED:${name}`));
  }, 20_000);

  (process.platform === "win32" ? it : it.skip)("registers hourly and daily triggers without changing review cadence or execution limits", () => {
    const registrar = installer.slice(installer.indexOf("function Register-DownstreamLaneTasks {"), installer.indexOf("\n$packageRoot = Resolve-Path"));
    const script = [
      registrar,
      "function Write-Step { param($Message) }",
      "function Join-Path { param($Path,$ChildPath);[string]$Path+'\\'+$ChildPath }",
      "function Test-Path { param($LiteralPath,$PathType);$true }",
      "function Copy-Item { param($LiteralPath,$Destination,[switch]$Force,$ErrorAction) }",
      "function New-ScheduledTaskAction { param($Execute,$Argument);[pscustomobject]@{Execute=$Execute;Argument=$Argument} }",
      "function New-ScheduledTaskTrigger { param([switch]$Daily,[switch]$Once,$At,$RepetitionInterval,$RepetitionDuration);[pscustomobject]@{StartBoundary=$At.ToString('o');Daily=[bool]$Daily;Once=[bool]$Once;Interval=if($RepetitionInterval){$RepetitionInterval.TotalMinutes}else{0}} }",
      "function New-ScheduledTaskSettingsSet { param($MultipleInstances,[switch]$StartWhenAvailable,$ExecutionTimeLimit);[pscustomobject]@{MultipleInstances=$MultipleInstances;ExecutionMinutes=$ExecutionTimeLimit.TotalMinutes;DisallowStartIfOnBatteries=$true;StopIfGoingOnBatteries=$true;Hidden=$false;Enabled=$true} }",
      "$script:registered=@()",
      "function Register-ScheduledTask { param($TaskName,$Action,$Trigger,$Settings,$Description,[switch]$Force);$script:registered+=[pscustomobject]@{Name=$TaskName;Trigger=$Trigger;Execution=$Settings.ExecutionMinutes;Enabled=$Settings.Enabled;Instances=$Settings.MultipleInstances;Arguments=$Action.Argument} }",
      "Register-DownstreamLaneTasks -InstallRoot 'C:\\Fixture' -RegisterDisabled $true",
      "$script:registered | ForEach-Object { 'TASK='+$_.Name+';INTERVAL='+$_.Trigger.Interval+';DAILY='+$_.Trigger.Daily+';START='+$_.Trigger.StartBoundary+';EXEC='+$_.Execution+';ENABLED='+$_.Enabled+';INSTANCES='+$_.Instances+';ARGS='+$_.Arguments }",
    ].join("\n");
    const output = run(script);
    expect(output).toMatch(/TASK=AwardPing Changed Page Review Lane;INTERVAL=15;DAILY=False;START=.*;EXEC=12;ENABLED=False/);
    expect(output).toMatch(/TASK=AwardPing Page Audit Lane;INTERVAL=60;DAILY=False;START=.*T\d{2}:10:00Z;EXEC=8;ENABLED=False/);
    expect(output).toMatch(/TASK=AwardPing Coverage Report;INTERVAL=0;DAILY=True;START=.*T23:30:00Z;EXEC=6;ENABLED=False/);
    expect(output).toMatch(/TASK=AwardPing Coverage Report;.*;INSTANCES=Queue;ARGS=.*-RunTrigger scheduled/);
    expect(output).toMatch(/TASK=AwardPing Changed Page Review Lane;.*;INSTANCES=IgnoreNew/);
    expect(output).toMatch(/TASK=AwardPing Page Audit Lane;.*;INSTANCES=IgnoreNew/);
  }, 20_000);
});
