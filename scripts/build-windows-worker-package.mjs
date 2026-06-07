#!/usr/bin/env node
import { rmSync, mkdirSync, cpSync, copyFileSync, existsSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const distDir = join(root, "dist");
const packageName = "awardping-worker-windows";
const stageDir = join(distDir, packageName);
const payloadDir = join(stageDir, "runner-files");
const zipPath = join(distDir, `${packageName}.zip`);
const publicZipPath = join(root, "public", `${packageName}.zip`);

const excludedNames = new Set([
  ".git",
  ".next",
  ".vercel",
  "dist",
  "docs",
  "installer",
  "node_modules",
  ".DS_Store",
  ".branches",
  ".temp",
  "reports",
  "tsconfig.tsbuildinfo",
  "next-env.d.ts",
]);

function filter(source) {
  const name = basename(source);
  if (excludedNames.has(name)) return false;
  if (name.endsWith(".zip")) return false;
  if (name.endsWith(".bat")) return false;
  if (name.startsWith(".env")) return false;
  return true;
}

function supportFilter(source) {
  const name = basename(source);
  if (name === ".DS_Store") return false;
  if (name.endsWith(".zip")) return false;
  if (name.startsWith(".env")) return false;
  return true;
}

function writePackageLaunchers() {
  writeFileSync(
    join(stageDir, "README-FIRST.txt"),
    [
      "AwardPing Windows Runner",
      "",
      "For a fresh PC setup, double-click:",
      "  1-INSTALL-AND-RUN-DEEP-CRAWL.bat",
      "",
      "That installs the runner, asks for your Supabase service_role JWT key or sb_secret key and Gemini key, creates the hourly scheduled task if you accept, runs a one-page test, then starts the full deep crawl.",
      "",
      "If the runner is already installed and you only need the newest code, double-click:",
      "  0-UPDATE-INSTALLED-RUNNER.bat",
      "",
      "That keeps the existing Supabase and Gemini keys on this PC, replaces the runner code, refreshes the installed helper BAT files, and creates the auto-update task.",
      "After one successful install or update, the PC checks awardping.com every 30 minutes and patches itself when a new runner ZIP is published.",
      "If a crawl is running, the updater skips that cycle and tries again later.",
      "You can still force a manual update from the installed runner with:",
      "  %LOCALAPPDATA%\\AwardPingWorker\\0-UPDATE-FROM-WEBSITE.bat",
      "",
      "Use these only after the runner is already installed:",
      "  3-RUN-DEEP-CRAWL-AGAIN.bat",
      "  4-RUN-HOURLY-CHECK-NOW.bat",
      "",
      "The installer puts the active runner here:",
      "  %LOCALAPPDATA%\\AwardPingWorker",
      "",
      "Logs are here:",
      "  %LOCALAPPDATA%\\AwardPingWorker\\logs",
      "",
    ].join("\r\n"),
    "utf8",
  );

  writeFileSync(
    join(stageDir, "0-UPDATE-INSTALLED-RUNNER.bat"),
    [
      "@echo off",
      "setlocal",
      "cd /d \"%~dp0\"",
      "echo AwardPing installed runner code update.",
      "echo This keeps the existing Supabase and Gemini keys on this PC.",
      "echo.",
      "powershell.exe -NoProfile -ExecutionPolicy Bypass -File \"%~dp0installer\\windows\\Install-AwardPingWorker.ps1\" -UpdateOnly",
      "echo.",
      "pause",
      "",
    ].join("\r\n"),
    "ascii",
  );

  writeFileSync(
    join(stageDir, "1-INSTALL-AND-RUN-DEEP-CRAWL.bat"),
    [
      "@echo off",
      "setlocal",
      "cd /d \"%~dp0\"",
      "echo AwardPing fresh install plus full deep crawl.",
      "echo This is the normal first-run choice for the PC runner.",
      "echo.",
      "powershell.exe -NoProfile -ExecutionPolicy Bypass -File \"%~dp0installer\\windows\\Install-AwardPingWorker.ps1\" -RunInitialDeepCrawl",
      "echo.",
      "pause",
      "",
    ].join("\r\n"),
    "ascii",
  );

  writeFileSync(
    join(stageDir, "2-INSTALL-ONLY.bat"),
    [
      "@echo off",
      "setlocal",
      "cd /d \"%~dp0\"",
      "echo AwardPing install only.",
      "echo Use this if you do not want to start the full deep crawl immediately.",
      "echo.",
      "powershell.exe -NoProfile -ExecutionPolicy Bypass -File \"%~dp0installer\\windows\\Install-AwardPingWorker.ps1\"",
      "echo.",
      "pause",
      "",
    ].join("\r\n"),
    "ascii",
  );

  writeFileSync(
    join(stageDir, "3-RUN-DEEP-CRAWL-AGAIN.bat"),
    [
      "@echo off",
      "setlocal",
      "set \"RUN_SCRIPT=%LOCALAPPDATA%\\AwardPingWorker\\Run-AwardPingWorker.ps1\"",
      "if not exist \"%RUN_SCRIPT%\" (",
      "  echo AwardPing runner is not installed yet.",
      "  echo First run 1-INSTALL-AND-RUN-DEEP-CRAWL.bat.",
      "  echo.",
      "  pause",
      "  exit /b 1",
      ")",
      "echo Running AwardPing full source expansion crawl.",
      "echo This searches known official award pages for subpages and can take a while.",
      "powershell.exe -NoProfile -ExecutionPolicy Bypass -File \"%RUN_SCRIPT%\" -DeepCrawl -Limit 20000 -MaxSubpages 24 -CrawlDepth 2",
      "echo.",
      "pause",
      "",
    ].join("\r\n"),
    "ascii",
  );

  writeFileSync(
    join(stageDir, "4-RUN-HOURLY-CHECK-NOW.bat"),
    [
      "@echo off",
      "setlocal",
      "set \"RUN_SCRIPT=%LOCALAPPDATA%\\AwardPingWorker\\Run-AwardPingWorker.ps1\"",
      "if not exist \"%RUN_SCRIPT%\" (",
      "  echo AwardPing runner is not installed yet.",
      "  echo First run 1-INSTALL-AND-RUN-DEEP-CRAWL.bat.",
      "  echo.",
      "  pause",
      "  exit /b 1",
      ")",
      "echo Running one scheduled-style AwardPing source check now.",
      "powershell.exe -NoProfile -ExecutionPolicy Bypass -File \"%RUN_SCRIPT%\"",
      "echo.",
      "pause",
      "",
    ].join("\r\n"),
    "ascii",
  );
}

rmSync(stageDir, { recursive: true, force: true });
rmSync(zipPath, { force: true });
mkdirSync(stageDir, { recursive: true });
mkdirSync(payloadDir, { recursive: true });

for (const entry of readdirSync(root, { withFileTypes: true })) {
  const source = join(root, entry.name);
  if (!filter(source)) continue;

  cpSync(source, join(payloadDir, entry.name), {
    recursive: true,
    filter,
  });
}

cpSync(join(root, "installer"), join(stageDir, "installer"), {
  recursive: true,
  filter: supportFilter,
});

cpSync(join(root, "docs"), join(stageDir, "docs"), {
  recursive: true,
  filter: supportFilter,
});

writePackageLaunchers();

const zip = spawnSync("zip", ["-qr", zipPath, packageName], {
  cwd: distDir,
  stdio: "inherit",
});

if (zip.status !== 0) {
  process.exit(zip.status || 1);
}

if (!existsSync(zipPath)) {
  console.error("Package zip was not created.");
  process.exit(1);
}

mkdirSync(join(root, "public"), { recursive: true });
copyFileSync(zipPath, publicZipPath);

console.log(zipPath);
console.log(publicZipPath);
