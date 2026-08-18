import { createHash } from "node:crypto";
import {
  closeSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  validateStage1EvidenceSchemaUpgradeReviewedApplyPlan,
} from "./lib/stage1-evidence-schema-upgrade-reviewed-apply-plan.mjs";
import {
  fixtureState,
  sourceId,
} from "./lib/stage1-evidence-schema-upgrade-reviewed-recovery-plan.test.mjs";
import {
  runStage1EvidenceSchemaUpgradeReviewedApplyPlanCli,
} from "./create-stage1-evidence-schema-upgrade-reviewed-apply-plan.mjs";

const temporaryRoots = [];
let reviewedReportBytes;
let manifest;

beforeAll(async () => {
  const fixture = await fixtureState();
  reviewedReportBytes = Buffer.from(fixture.reviewedDryRunReportBytes);
  manifest = structuredClone(fixture.manifest);
});

afterAll(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("reviewed exact-one apply plan authoring CLI", () => {
  it("prints help without consulting clock, config, or file-system interfaces", () => {
    const forbidden = vi.fn(() => {
      throw new Error("help attempted I/O");
    });
    const result = runStage1EvidenceSchemaUpgradeReviewedApplyPlanCli({
      argv: ["--help"],
      workspaceRoot: "not-consulted",
      interfaces: {
        clock: { now: forbidden },
        fileSystem: {
          close: forbidden,
          fstat: forbidden,
          fsync: forbidden,
          lstat: forbidden,
          open: forbidden,
          read: forbidden,
          readFile: forbidden,
          realpath: forbidden,
          write: forbidden,
        },
      },
    });
    expect(result).toMatchObject({ exitCode: 0 });
    expect(result.help).toMatch(/no live operations/i);
    expect(forbidden).not.toHaveBeenCalled();
  });

  it("reads the report once, writes canonical bytes with wx, and returns only sealed summary fields", () => {
    const harness = createHarness();
    let reportReads = 0;
    const open = vi.fn((path, flags, mode) => openSync(path, flags, mode));
    const write = vi.fn((...parameters) => writeSync(...parameters));
    const fileSystem = actualFileSystem({
      readFile(path) {
        if (samePath(path, harness.reportPath)) {
          reportReads += 1;
          if (reportReads > 1) return Buffer.from("drifted report bytes");
        }
        return readFileSync(path);
      },
      open,
      write,
    });
    const clock = { now: vi.fn(() => "2026-08-15T06:00:00.000Z") };
    const result = runStage1EvidenceSchemaUpgradeReviewedApplyPlanCli({
      argv: harness.args,
      workspaceRoot: harness.root,
      interfaces: { clock, fileSystem },
    });

    expect(result).toEqual({
      exitCode: 0,
      mode: "create_reviewed_exact_one_apply_plan",
      schema_version:
        "awardping.stage1.evidence-schema-upgrade-reviewed-exact-one-apply-plan.v3",
      output_file: "reports/faq-reviewed-apply-plan.json",
      selected_source_id: sourceId,
      deferred_source_count: 8,
      report_file_sha256: harness.reportSha256,
      plan_file_sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
      plan_sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
      reviewed_at: "2026-08-15T05:00:00.000Z",
      expires_at: "2026-08-16T05:00:00.000Z",
      mutation_performed: false,
      creates_api_charge: false,
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(reportReads).toBe(1);
    expect(clock.now).toHaveBeenCalledOnce();
    expect(open).toHaveBeenCalledOnce();
    expect(open).toHaveBeenCalledWith(harness.outputPath, "wx+", 0o600);
    expect(write).toHaveBeenCalled();

    const planBytes = readFileSync(harness.outputPath);
    expect(sha256(planBytes)).toBe(result.plan_file_sha256);
    const parsed = JSON.parse(planBytes.toString("utf8"));
    expect(planBytes).toEqual(Buffer.from(`${canonicalJson(parsed)}\n`, "utf8"));
    const validated = validateStage1EvidenceSchemaUpgradeReviewedApplyPlan({
      planBytes,
      expectedPlanFileSha256: result.plan_file_sha256,
      reportBytes: reviewedReportBytes,
      manifest,
      now: "2026-08-15T06:00:00.000Z",
    });
    expect(validated).toMatchObject({
      valid: true,
      selected_source_id: sourceId,
    });
    expect(validated.deferred_source_ids).toHaveLength(8);
    expect(JSON.stringify(result)).not.toContain("reviewed-operator@example.test");
  });

  it.each([
    ["unknown", (args) => [...args, "--browser=true"], /forbids arguments: browser/i],
    ["duplicate", (args) => [...args, `--report-file=reports/other.json`], /duplicated.*report-file/i],
    ["missing", (args) => args.filter((arg) => !arg.startsWith("--output-file=")), /missing arguments: output-file/i],
  ])("rejects %s arguments before any I/O", (_label, mutate, message) => {
    const harness = createHarness();
    const readFile = vi.fn();
    expect(() => runStage1EvidenceSchemaUpgradeReviewedApplyPlanCli({
      argv: mutate(harness.args),
      workspaceRoot: harness.root,
      interfaces: {
        clock: { now: vi.fn() },
        fileSystem: actualFileSystem({ readFile }),
      },
    })).toThrow(message);
    expect(readFile).not.toHaveBeenCalled();
  });

  it.each([
    ["uppercase report SHA", "report-sha256", "A".repeat(64), /lowercase SHA-256/i],
    ["noncanonical source UUID", "selected-source-id", sourceId.toUpperCase(), /lowercase UUID/i],
    ["noncanonical review time", "reviewed-at", "2026-08-15T05:00:00Z", /canonical UTC timestamp/i],
    ["noncanonical expiry time", "expires-at", "2026-08-16 05:00:00Z", /canonical UTC timestamp/i],
  ])("rejects %s before reading the report", (_label, key, value, message) => {
    const harness = createHarness();
    const readFile = vi.fn();
    expect(() => runStage1EvidenceSchemaUpgradeReviewedApplyPlanCli({
      argv: replaceArgument(harness.args, key, value),
      workspaceRoot: harness.root,
      interfaces: {
        clock: { now: vi.fn() },
        fileSystem: actualFileSystem({ readFile }),
      },
    })).toThrow(message);
    expect(readFile).not.toHaveBeenCalled();
  });

  it("checks the exact raw report hash before parsing or plan construction", () => {
    const harness = createHarness();
    writeFileSync(harness.reportPath, "not valid JSON", "utf8");
    const readFile = vi.fn((path) => readFileSync(path));
    const open = vi.fn();
    expect(() => runStage1EvidenceSchemaUpgradeReviewedApplyPlanCli({
      argv: harness.args,
      workspaceRoot: harness.root,
      interfaces: {
        clock: { now: vi.fn() },
        fileSystem: actualFileSystem({ open, readFile }),
      },
    })).toThrow(/raw bytes differ from --report-sha256/i);
    expect(readFile).toHaveBeenCalledOnce();
    expect(open).not.toHaveBeenCalled();
  });

  it("rejects review-window clock drift before writing a plan", () => {
    const harness = createHarness();
    const open = vi.fn();
    const clock = { now: vi.fn(() => "2026-08-16T05:00:00.000Z") };
    expect(() => runStage1EvidenceSchemaUpgradeReviewedApplyPlanCli({
      argv: harness.args,
      workspaceRoot: harness.root,
      interfaces: {
        clock,
        fileSystem: actualFileSystem({ open }),
      },
    })).toThrow(/bounded review window/i);
    expect(clock.now).toHaveBeenCalledOnce();
    expect(open).not.toHaveBeenCalled();
  });

  it("refuses an existing output without changing its bytes", () => {
    const harness = createHarness();
    const sentinel = Buffer.from("already reviewed elsewhere");
    writeFileSync(harness.outputPath, sentinel);
    const open = vi.fn();
    expect(() => runStage1EvidenceSchemaUpgradeReviewedApplyPlanCli({
      argv: harness.args,
      workspaceRoot: harness.root,
      interfaces: {
        clock: stableClock(),
        fileSystem: actualFileSystem({ open }),
      },
    })).toThrow(/refusing to replace an existing/i);
    expect(open).not.toHaveBeenCalled();
    expect(readFileSync(harness.outputPath)).toEqual(sentinel);
  });

  it("rejects lexical and canonical output-parent escapes", () => {
    const harness = createHarness();
    const open = vi.fn();
    expect(() => runStage1EvidenceSchemaUpgradeReviewedApplyPlanCli({
      argv: replaceArgument(harness.args, "output-file", "outside-plan.json"),
      workspaceRoot: harness.root,
      interfaces: {
        clock: stableClock(),
        fileSystem: actualFileSystem({ open }),
      },
    })).toThrow(/under the workspace reports/i);
    expect(open).not.toHaveBeenCalled();

    const nested = join(harness.reportsRoot, "canonical-escape");
    mkdirSync(nested);
    const canonicalEscapeOutput = join(nested, "plan.json");
    const outside = join(harness.root, "outside");
    mkdirSync(outside);
    const escapedRealpath = vi.fn((path) => (
      samePath(path, nested) ? outside : realpathSync.native(path)
    ));
    expect(() => runStage1EvidenceSchemaUpgradeReviewedApplyPlanCli({
      argv: replaceArgument(
        harness.args,
        "output-file",
        "reports/canonical-escape/plan.json",
      ),
      workspaceRoot: harness.root,
      interfaces: {
        clock: stableClock(),
        fileSystem: actualFileSystem({ open, realpath: escapedRealpath }),
      },
    })).toThrow(/canonical.*escapes workspace reports/i);
    expect(open).not.toHaveBeenCalled();
    expect(() => lstatSync(canonicalEscapeOutput)).toThrow();
  });

  it("rejects a symlink/reparse output parent even when it resolves inside reports", () => {
    const harness = createHarness();
    const reparseParent = join(harness.reportsRoot, "reparse-parent");
    mkdirSync(reparseParent);
    const open = vi.fn();
    const lstat = vi.fn((path) => {
      const stats = lstatSync(path);
      if (!samePath(path, reparseParent)) return stats;
      return statsView(stats, { reparsePoint: true });
    });
    expect(() => runStage1EvidenceSchemaUpgradeReviewedApplyPlanCli({
      argv: replaceArgument(
        harness.args,
        "output-file",
        "reports/reparse-parent/plan.json",
      ),
      workspaceRoot: harness.root,
      interfaces: {
        clock: stableClock(),
        fileSystem: actualFileSystem({ lstat, open }),
      },
    })).toThrow(/symlink or reparse/i);
    expect(open).not.toHaveBeenCalled();
  });

  it("detects output-directory identity drift between validation and the wx write", () => {
    const harness = createHarness();
    let reportsRootObservations = 0;
    const open = vi.fn();
    const lstat = vi.fn((path) => {
      const stats = lstatSync(path);
      if (!samePath(path, harness.reportsRoot)) return stats;
      reportsRootObservations += 1;
      return statsView(stats, {
        ino: BigInt(stats.ino) + BigInt(reportsRootObservations > 1 ? 1 : 0),
      });
    });
    expect(() => runStage1EvidenceSchemaUpgradeReviewedApplyPlanCli({
      argv: harness.args,
      workspaceRoot: harness.root,
      interfaces: {
        clock: stableClock(),
        fileSystem: actualFileSystem({ lstat, open }),
      },
    })).toThrow(/boundary drifted before the exclusive write/i);
    expect(reportsRootObservations).toBe(2);
    expect(open).not.toHaveBeenCalled();
  });

  it("does not write plan bytes when wx opens an escaped leaf during a parent-swap race", () => {
    const harness = createHarness();
    const outsideOutput = join(harness.root, "escaped-plan.json");
    const open = vi.fn(() => {
      const descriptor = openSync(outsideOutput, "wx+", 0o600);
      writeFileSync(harness.outputPath, "attacker replacement", "utf8");
      return descriptor;
    });
    const write = vi.fn((...parameters) => writeSync(...parameters));
    expect(() => runStage1EvidenceSchemaUpgradeReviewedApplyPlanCli({
      argv: harness.args,
      workspaceRoot: harness.root,
      interfaces: {
        clock: stableClock(),
        fileSystem: actualFileSystem({ open, write }),
      },
    })).toThrow(/descriptor escaped or changed during exclusive open/i);
    expect(open).toHaveBeenCalledOnce();
    expect(write).not.toHaveBeenCalled();
    expect(readFileSync(outsideOutput)).toHaveLength(0);
    expect(readFileSync(harness.outputPath, "utf8")).toBe("attacker replacement");
  });

  it("fails closed when exclusive descriptor readback bytes do not match the sealed plan", () => {
    const harness = createHarness();
    const open = vi.fn((path, flags, mode) => openSync(path, flags, mode));
    const write = vi.fn((...parameters) => writeSync(...parameters));
    const read = vi.fn((descriptor, buffer, offset, length, position) => {
      const count = readSync(descriptor, buffer, offset, length, position);
      if (count > 0) buffer[offset] ^= 0xff;
      return count;
    });
    expect(() => runStage1EvidenceSchemaUpgradeReviewedApplyPlanCli({
      argv: harness.args,
      workspaceRoot: harness.root,
      interfaces: {
        clock: stableClock(),
        fileSystem: actualFileSystem({ open, read, write }),
      },
    })).toThrow(/write\/readback bytes or SHA-256 differ/i);
    expect(open).toHaveBeenCalledWith(harness.outputPath, "wx+", 0o600);
    expect(write).toHaveBeenCalled();
    expect(read).toHaveBeenCalled();
  });
});

function createHarness() {
  const root = mkdtempSync(join(tmpdir(), "awardping-reviewed-apply-plan-cli-"));
  temporaryRoots.push(root);
  const reportsRoot = join(root, "reports");
  mkdirSync(reportsRoot);
  const reportPath = join(reportsRoot, "reviewed-dry-run.json");
  const outputPath = join(reportsRoot, "faq-reviewed-apply-plan.json");
  writeFileSync(reportPath, reviewedReportBytes);
  const reportSha256 = sha256(reviewedReportBytes);
  return {
    root,
    reportsRoot,
    reportPath,
    outputPath,
    reportSha256,
    args: [
      "--report-file=reports/reviewed-dry-run.json",
      `--report-sha256=${reportSha256}`,
      `--selected-source-id=${sourceId}`,
      "--reviewer-id=reviewed-operator@example.test",
      "--reviewed-at=2026-08-15T05:00:00.000Z",
      "--expires-at=2026-08-16T05:00:00.000Z",
      "--output-file=reports/faq-reviewed-apply-plan.json",
    ],
  };
}

function actualFileSystem(overrides = {}) {
  return {
    close: (descriptor) => closeSync(descriptor),
    fstat: (descriptor) => fstatSync(descriptor),
    fsync: (descriptor) => fsyncSync(descriptor),
    lstat: (path) => lstatSync(path),
    open: (path, flags, mode) => openSync(path, flags, mode),
    read: (...parameters) => readSync(...parameters),
    readFile: (path) => readFileSync(path),
    realpath: (path) => realpathSync.native(path),
    write: (...parameters) => writeSync(...parameters),
    ...overrides,
  };
}

function stableClock() {
  return { now: () => "2026-08-15T06:00:00.000Z" };
}

function replaceArgument(args, key, value) {
  return args.map((entry) => (
    entry.startsWith(`--${key}=`) ? `--${key}=${value}` : entry
  ));
}

function statsView(stats, overrides = {}) {
  return {
    dev: overrides.dev ?? stats.dev,
    ino: overrides.ino ?? stats.ino,
    reparsePoint: overrides.reparsePoint ?? false,
    isDirectory: () => stats.isDirectory(),
    isFile: () => stats.isFile(),
    isSymbolicLink: () => stats.isSymbolicLink(),
  };
}

function samePath(left, right) {
  const first = resolve(left);
  const second = resolve(right);
  return process.platform === "win32"
    ? first.toLowerCase() === second.toLowerCase()
    : first === second;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(",")}}`;
  }
  return JSON.stringify(value);
}
