// Local, temporary-fixture regression suites only; never invokes the installer.
// The outer bound also covers async fixture mistakes beyond individual deadlines.
import { spawn } from "./bounded-test-process.mjs";
const started = Date.now();
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== "--pattern" || !args[1])) throw new Error("Usage: node scripts/test-support/run-worker-installer-regressions.mjs [--pattern test-name-regex]");
const child = spawn(process.execPath, [
  "node_modules/vitest/vitest.mjs", "run",
  "scripts/worker-installer-update-safety.test.mjs",
  "scripts/bounded-test-process.test.mjs",
  "scripts/scrapling-installer-rollback.test.mjs",
  "scripts/scrapling-main-installer.test.mjs",
  "scripts/scrapling-runtime-installer.test.mjs",
  "--maxWorkers=1", "--reporter=verbose",
  ...(args.length ? ["--testNamePattern", args[1]] : []),
], { stdio: "inherit", timeout: 600000 });
child.once("error", error => { console.error(error.message); process.exitCode = 1; });
child.once("close", code => {
  console.log(`Installer regression elapsed: ${((Date.now() - started) / 1000).toFixed(1)}s; outer deadline reached: ${Boolean(child.testTimeout)}`);
  process.exitCode = child.testTimeout || child.testCleanupError ? 1 : (code ?? 1);
});
