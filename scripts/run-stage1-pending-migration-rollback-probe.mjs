import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { renderStage1PendingMigrationRollbackProbe } from "./render-stage1-pending-migration-rollback-probe.mjs";

export const STAGE1_ROLLBACK_PROBE_SUCCESS_MARKER =
  "awardping_stage1_pending_migration_rollback_probe_passed";

export const STAGE1_ROLLBACK_PROBE_USAGE = `Usage: node scripts/run-stage1-pending-migration-rollback-probe.mjs [--help|-h]

Runs every pending Stage 1 migration against the linked database inside one
transaction, verifies the post-migration contract, and rolls the transaction back.

Options:
  -h, --help  Show this help without connecting to the database.
`;

export function runStage1PendingMigrationRollbackProbe({
  platform = process.platform,
  nodeExecutable = process.execPath,
  tempRoot = tmpdir(),
  render = renderStage1PendingMigrationRollbackProbe,
  fileExists = existsSync,
  makeTempDirectory = mkdtempSync,
  writeFile = writeFileSync,
  runProcess = spawnSync,
  removeDirectory = rmSync,
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  let executable;
  let commandPrefix;
  if (platform === "win32") {
    const npxCliPath = join(
      dirname(nodeExecutable),
      "node_modules",
      "npm",
      "bin",
      "npx-cli.js",
    );
    if (!fileExists(npxCliPath)) {
      throw new Error(
        `Cannot safely launch npx: expected the Node-adjacent CLI at ${npxCliPath}.`,
      );
    }
    // Node 26 on Windows rejects direct spawnSync of npx.cmd with EINVAL.
    // Executing npx-cli.js through the already-running Node binary keeps
    // shell:false and avoids both .cmd dispatch and shell quoting.
    executable = nodeExecutable;
    commandPrefix = [npxCliPath];
  } else {
    executable = "npx";
    commandPrefix = [];
  }

  const sql = render();
  if (sql.includes("\r")) {
    throw new Error("Rendered rollback probe contains CR bytes; refusing a non-LF query.");
  }
  if (!sql.endsWith("\n")) {
    throw new Error("Rendered rollback probe must end with one LF newline.");
  }

  const tempDirectory = makeTempDirectory(
    join(tempRoot, "awardping-stage1-rollback-probe-"),
  );
  const sqlPath = join(tempDirectory, "stage1-pending-migrations-rollback-probe.sql");
  const args = [
    ...commandPrefix,
    "supabase",
    "db",
    "query",
    "--linked",
    "--file",
    sqlPath,
  ];

  try {
    // The explicit encoding writes UTF-8 without a BOM. Passing a file avoids
    // PowerShell's native-pipeline CRLF normalization inside dollar-quoted SQL.
    writeFile(sqlPath, sql, { encoding: "utf8", flag: "wx" });
    const result = runProcess(executable, args, {
      encoding: "utf8",
      shell: false,
      windowsHide: true,
      timeout: 300_000,
      maxBuffer: 16 * 1024 * 1024,
    });

    if (result.stdout) stdout.write(result.stdout);
    if (result.stderr) stderr.write(result.stderr);

    if (result.error) {
      throw new Error(`Could not execute the Supabase rollback probe: ${result.error.message}`);
    }
    if (result.status !== 0) {
      const termination = result.signal
        ? `signal ${result.signal}`
        : `exit code ${String(result.status)}`;
      throw new Error(`Supabase rollback probe failed with ${termination}.`);
    }

    const markerPattern = new RegExp(
      `${STAGE1_ROLLBACK_PROBE_SUCCESS_MARKER}[\\s\\S]{0,1000}\\btrue\\b`,
      "i",
    );
    if (!markerPattern.test(String(result.stdout || ""))) {
      throw new Error(
        "Supabase exited successfully but did not return the verified rollback success marker.",
      );
    }

    return {
      status: "passed",
      executable,
      args,
      successMarker: STAGE1_ROLLBACK_PROBE_SUCCESS_MARKER,
    };
  } finally {
    removeDirectory(tempDirectory, { recursive: true, force: true });
  }
}

export function runStage1PendingMigrationRollbackProbeCli({
  argv = process.argv.slice(2),
  run = runStage1PendingMigrationRollbackProbe,
  stdout = process.stdout,
} = {}) {
  if (argv.length === 1 && ["--help", "-h"].includes(argv[0])) {
    stdout.write(STAGE1_ROLLBACK_PROBE_USAGE);
    return { status: "help" };
  }

  if (argv.length > 0) {
    throw new Error(
      `Unknown argument${argv.length === 1 ? "" : "s"}: ${argv.join(" ")}\n${STAGE1_ROLLBACK_PROBE_USAGE}`,
    );
  }

  return run();
}

const invokedPath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : null;
if (invokedPath === import.meta.url) {
  try {
    runStage1PendingMigrationRollbackProbeCli();
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
