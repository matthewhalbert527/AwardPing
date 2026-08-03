import { describe, expect, it, vi } from "vitest";
import {
  runStage1PendingMigrationRollbackProbeCli,
  runStage1PendingMigrationRollbackProbe,
  STAGE1_ROLLBACK_PROBE_SUCCESS_MARKER,
  STAGE1_ROLLBACK_PROBE_USAGE,
} from "./run-stage1-pending-migration-rollback-probe.mjs";

function harness(overrides = {}) {
  const calls = {};
  const dependencies = {
    platform: "win32",
    nodeExecutable: "C:\\Program Files\\nodejs\\node.exe",
    tempRoot: "C:\\Temp",
    render: () => "begin;\nselect true;\nrollback;\n",
    fileExists: vi.fn(() => true),
    makeTempDirectory: vi.fn(() => "C:\\Temp\\awardping-probe-fixed"),
    writeFile: vi.fn((...args) => {
      calls.write = args;
    }),
    runProcess: vi.fn((...args) => {
      calls.process = args;
      return {
        status: 0,
        signal: null,
        stdout: `${STAGE1_ROLLBACK_PROBE_SUCCESS_MARKER} | true\n`,
        stderr: "",
      };
    }),
    removeDirectory: vi.fn((...args) => {
      calls.remove = args;
    }),
    stdout: { write: vi.fn() },
    stderr: { write: vi.fn() },
    ...overrides,
  };
  return { calls, dependencies };
}

describe("Stage 1 linked rollback probe runner", () => {
  it("writes exact UTF-8 LF SQL and invokes the Windows CLI with --file", () => {
    const { calls, dependencies } = harness();
    const result = runStage1PendingMigrationRollbackProbe(dependencies);

    expect(result.status).toBe("passed");
    expect(calls.write[0]).toMatch(/stage1-pending-migrations-rollback-probe\.sql$/);
    expect(calls.write[1]).toBe("begin;\nselect true;\nrollback;\n");
    expect(calls.write[1]).not.toContain("\r");
    expect(calls.write[2]).toEqual({ encoding: "utf8", flag: "wx" });
    expect(calls.process[0]).toBe("C:\\Program Files\\nodejs\\node.exe");
    expect(calls.process[1]).toEqual([
      "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npx-cli.js",
      "supabase",
      "db",
      "query",
      "--linked",
      "--file",
      calls.write[0],
    ]);
    expect(calls.process[2]).toMatchObject({ shell: false, windowsHide: true });
    expect(calls.remove).toEqual([
      "C:\\Temp\\awardping-probe-fixed",
      { recursive: true, force: true },
    ]);
  });

  it("uses npx on non-Windows platforms", () => {
    const { calls, dependencies } = harness({ platform: "linux" });
    runStage1PendingMigrationRollbackProbe(dependencies);
    expect(calls.process[0]).toBe("npx");
    expect(calls.process[1][0]).toBe("supabase");
  });

  it("fails closed before rendering or creating files when Windows npx-cli.js is absent", () => {
    const render = vi.fn(() => "begin;\nrollback;\n");
    const { dependencies } = harness({
      render,
      fileExists: vi.fn(() => false),
    });
    expect(() => runStage1PendingMigrationRollbackProbe(dependencies)).toThrow(
      "expected the Node-adjacent CLI",
    );
    expect(dependencies.fileExists).toHaveBeenCalledWith(
      "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npx-cli.js",
    );
    expect(render).not.toHaveBeenCalled();
    expect(dependencies.makeTempDirectory).not.toHaveBeenCalled();
    expect(dependencies.runProcess).not.toHaveBeenCalled();
  });

  it("deletes the temporary directory after a CLI failure", () => {
    const { calls, dependencies } = harness({
      runProcess: vi.fn(() => ({
        status: 1,
        signal: null,
        stdout: "",
        stderr: "migration failed",
      })),
    });
    expect(() => runStage1PendingMigrationRollbackProbe(dependencies)).toThrow(
      "exit code 1",
    );
    expect(calls.remove).toEqual([
      "C:\\Temp\\awardping-probe-fixed",
      { recursive: true, force: true },
    ]);
  });

  it("fails closed when exit zero lacks the verified marker", () => {
    const { calls, dependencies } = harness({
      runProcess: vi.fn(() => ({
        status: 0,
        signal: null,
        stdout: "query completed without a verification row",
        stderr: "",
      })),
    });
    expect(() => runStage1PendingMigrationRollbackProbe(dependencies)).toThrow(
      "did not return the verified rollback success marker",
    );
    expect(calls.remove).toBeDefined();
  });

  it("refuses CRLF input before creating a temporary directory", () => {
    const { dependencies } = harness({ render: () => "begin;\r\nrollback;\r\n" });
    expect(() => runStage1PendingMigrationRollbackProbe(dependencies)).toThrow(
      "contains CR bytes",
    );
    expect(dependencies.makeTempDirectory).not.toHaveBeenCalled();
  });
});

describe("Stage 1 linked rollback probe CLI", () => {
  it.each(["--help", "-h"])(
    "prints usage for %s without starting a database probe",
    (helpFlag) => {
      const run = vi.fn();
      const stdout = { write: vi.fn() };

      const result = runStage1PendingMigrationRollbackProbeCli({
        argv: [helpFlag],
        run,
        stdout,
      });

      expect(result).toEqual({ status: "help" });
      expect(stdout.write).toHaveBeenCalledWith(STAGE1_ROLLBACK_PROBE_USAGE);
      expect(run).not.toHaveBeenCalled();
    },
  );

  it("rejects unknown arguments before starting a database probe", () => {
    const run = vi.fn();

    expect(() =>
      runStage1PendingMigrationRollbackProbeCli({ argv: ["--dry-run"], run }),
    ).toThrow("Unknown argument: --dry-run");
    expect(run).not.toHaveBeenCalled();
  });

  it("runs the linked probe only when no arguments are supplied", () => {
    const expected = { status: "passed" };
    const run = vi.fn(() => expected);

    expect(
      runStage1PendingMigrationRollbackProbeCli({ argv: [], run }),
    ).toBe(expected);
    expect(run).toHaveBeenCalledOnce();
  });
});
