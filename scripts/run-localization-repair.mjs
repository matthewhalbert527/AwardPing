#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const passthroughArgs = process.argv.slice(2);
const hasEnvArg = passthroughArgs.some((arg) => arg === "--env" || arg.startsWith("--env="));

const envArgs = hasEnvArg
  ? []
  : existsSync(resolve(root, ".env.worker.local"))
    ? ["--env", ".env.worker.local"]
    : existsSync(resolve(root, ".env.local"))
      ? ["--env", ".env.local"]
      : [];

const defaultArgs = [
  "scripts/capture-visual-snapshots.mjs",
  ...envArgs,
  "--localization-repair=true",
  "--capture-profile=localization-repair",
  "--force-r2-snapshot-refresh=true",
  "--r2-snapshot-sync=true",
  "--all=true",
  "--web-only=true",
  "--limit=100000",
  "--interpret-visual-changes=false",
  "--extract-baseline-info=false",
  "--discover-pdf-subpages=false",
  "--discover-html-subpages=false",
  "--gemini-api-max-calls=0",
  "--gemini-cli-max-calls=0",
];

const child = spawn(process.execPath, [...defaultArgs, ...passthroughArgs], {
  cwd: root,
  env: process.env,
  stdio: "inherit",
});

child.once("error", (error) => {
  console.error(`Failed to start localization repair: ${error.message}`);
  process.exit(1);
});

child.once("exit", (code, signal) => {
  if (signal) {
    console.error(`Localization repair stopped by signal ${signal}.`);
    process.exit(1);
  }
  process.exit(code ?? 1);
});
