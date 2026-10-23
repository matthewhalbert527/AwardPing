#!/usr/bin/env node
import { readFileSync, readdirSync } from "node:fs";
import { resolve, relative } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
function nodeTests(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = resolve(directory, entry.name);
    if (entry.isDirectory()) return nodeTests(file);
    return entry.isFile() && entry.name.endsWith(".test.mjs") && /from\s+["']node:test["']/.test(readFileSync(file, "utf8"))
      ? [relative(root, file).replaceAll("\\", "/")] : [];
  });
}
// Both test APIs are intentional. Vitest cannot discover node:test cases;
// running those files through Node keeps every assertion in the release check.
const native = nodeTests(resolve(root, "scripts")).sort();
const unit = spawnSync(process.execPath, [resolve(root, "node_modules/vitest/vitest.mjs"), "run",
  ...native.flatMap(file => ["--exclude", file]), ...process.argv.slice(2)], { cwd: root, stdio: "inherit", windowsHide: true });
const node = native.length ? spawnSync(process.execPath, ["--test", ...native],
  { cwd: root, stdio: "inherit", windowsHide: true }) : { status: 0 };
process.exitCode = unit.status === 0 && node.status === 0 ? 0 : 1;
