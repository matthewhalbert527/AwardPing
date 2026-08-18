#!/usr/bin/env node
import { createHash } from "node:crypto";
import {
  closeSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  writeSync,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
} from "node:path";
import { pathToFileURL } from "node:url";
import {
  stage1EvidenceSchemaUpgradeExpectedManifest,
} from "./lib/stage1-evidence-schema-upgrade.mjs";
import {
  createStage1EvidenceSchemaUpgradeReviewedApplyPlan,
} from "./lib/stage1-evidence-schema-upgrade-reviewed-apply-plan.mjs";

const projectRoot = resolve(import.meta.dirname, "..");
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const PLAN_ARGS = Object.freeze([
  "expires-at",
  "output-file",
  "report-file",
  "report-sha256",
  "reviewed-at",
  "reviewer-id",
  "selected-source-id",
]);

const defaultFileSystem = Object.freeze({
  close: (descriptor) => closeSync(descriptor),
  fstat: (descriptor) => fstatSync(descriptor),
  fsync: (descriptor) => fsyncSync(descriptor),
  lstat: (path) => lstatSync(path),
  open: (path, flags, mode) => openSync(path, flags, mode),
  readFile: (path) => readFileSync(path),
  read: (descriptor, buffer, offset, length, position) => (
    readSync(descriptor, buffer, offset, length, position)
  ),
  realpath: (path) => realpathSync.native(path),
  write: (descriptor, buffer, offset, length, position) => (
    writeSync(descriptor, buffer, offset, length, position)
  ),
});

const defaultClock = Object.freeze({
  now: () => new Date().toISOString(),
});

/**
 * Authors one immutable reviewed exact-one plan. The only I/O permitted by
 * this surface is one read of the exact reviewed report and one exclusive
 * plan-file write followed by its exact readback. It loads no environment,
 * database, browser, R2, capture, apply, or recovery runtime.
 */
export function runStage1EvidenceSchemaUpgradeReviewedApplyPlanCli({
  argv = process.argv.slice(2),
  workspaceRoot = projectRoot,
  interfaces = {},
} = {}) {
  const args = parseArgs(argv);
  if (args.help === true) {
    if (Object.keys(args).length !== 1) {
      throw new Error("Reviewed apply plan --help cannot be combined with other arguments.");
    }
    return deepFreeze({ exitCode: 0, help: helpText() });
  }
  assertExactArgs(args);

  const expectedReportSha256 = requiredSha256(
    args["report-sha256"],
    "--report-sha256",
  );
  const selectedSourceId = requiredUuid(
    args["selected-source-id"],
    "--selected-source-id",
  );
  const reviewerId = requiredText(args["reviewer-id"], "--reviewer-id");
  const reviewedAt = requiredTimestamp(args["reviewed-at"], "--reviewed-at");
  const expiresAt = requiredTimestamp(args["expires-at"], "--expires-at");
  const root = resolve(requiredText(workspaceRoot, "workspace root"));
  const reportPath = resolveInput(root, requiredText(
    args["report-file"],
    "--report-file",
  ));
  const outputPath = resolveInput(root, requiredText(
    args["output-file"],
    "--output-file",
  ));
  const fileSystem = assertFileSystem(interfaces.fileSystem || defaultFileSystem);
  const clock = assertClock(interfaces.clock || defaultClock);

  // One exact read prevents a hash-then-reload drift from reaching the plan
  // builder. The same in-memory bytes are hashed and bound into the plan.
  const reportBytes = exactBytes(
    fileSystem.readFile(reportPath),
    "reviewed dry-run report",
  );
  const observedReportSha256 = sha256(reportBytes);
  if (observedReportSha256 !== expectedReportSha256) {
    throw new Error(
      "The reviewed dry-run report raw bytes differ from --report-sha256.",
    );
  }

  const initialBoundary = inspectOutputBoundary({
    fileSystem,
    workspaceRoot: root,
    outputPath,
    outputMustExist: false,
  });
  const now = requiredTimestamp(clock.now(), "authoring clock now");
  const created = createStage1EvidenceSchemaUpgradeReviewedApplyPlan({
    reportBytes,
    manifest: stage1EvidenceSchemaUpgradeExpectedManifest(),
    selectedSourceId,
    reviewer: {
      reviewer_id: reviewerId,
      reviewed_at: reviewedAt,
      expires_at: expiresAt,
    },
    now,
  });
  if (
    created.plan.dry_run_report.file_sha256 !== expectedReportSha256
    || created.checked.report_binding.file_sha256 !== expectedReportSha256
    || created.plan.selected.source.source_id !== selectedSourceId
    || created.checked.selected_source_id !== selectedSourceId
    || !Buffer.from(created.plan_bytes).equals(
      Buffer.from(`${canonicalJson(created.plan)}\n`, "utf8"),
    )
    || sha256(created.plan_bytes) !== created.plan_file_sha256
  ) {
    throw new Error("The reviewed apply plan builder returned an inconsistent seal.");
  }

  const writeBoundary = inspectOutputBoundary({
    fileSystem,
    workspaceRoot: root,
    outputPath,
    outputMustExist: false,
  });
  assertSameBoundary(initialBoundary, writeBoundary, "before the exclusive write");
  const planBytes = Buffer.from(created.plan_bytes);
  let descriptor;
  try {
    descriptor = fileSystem.open(outputPath, "wx+", 0o600);
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw new Error("Refusing to replace an existing reviewed apply plan output file.");
    }
    throw error;
  }
  if (!Number.isSafeInteger(descriptor) || descriptor < 0) {
    throw new Error("The reviewed apply plan exclusive open returned an invalid descriptor.");
  }
  try {
    // The exclusive leaf is opened empty first. Canonical plan bytes are sent
    // only through this held descriptor after its identity is proven to be the
    // exact regular leaf observed below the still-checked reports boundary.
    const openedStats = assertEmptyRegularHandle(fileSystem.fstat(descriptor));
    const openedBoundary = inspectOutputBoundary({
      fileSystem,
      workspaceRoot: root,
      outputPath,
      outputMustExist: true,
    });
    assertSameBoundary(writeBoundary, openedBoundary, "during exclusive open");
    assertHandleMatchesBoundary(openedStats, openedBoundary, "exclusive open");

    writeExactDescriptor(fileSystem, descriptor, planBytes);
    fileSystem.fsync(descriptor);
    const writtenStats = requiredRegularHandle(
      fileSystem.fstat(descriptor),
      "written reviewed apply plan",
    );
    if (
      statIdentity(writtenStats) !== statIdentity(openedStats)
      || Number(writtenStats.size) !== planBytes.byteLength
    ) {
      throw new Error("The reviewed apply plan descriptor identity or length changed while writing.");
    }
    const writtenBoundary = inspectOutputBoundary({
      fileSystem,
      workspaceRoot: root,
      outputPath,
      outputMustExist: true,
    });
    assertSameBoundary(openedBoundary, writtenBoundary, "after descriptor write");
    assertHandleMatchesBoundary(writtenStats, writtenBoundary, "descriptor write");

    const readback = readExactDescriptor(fileSystem, descriptor, planBytes.byteLength);
    if (
      !readback.equals(planBytes)
      || sha256(readback) !== created.plan_file_sha256
    ) {
      throw new Error("The reviewed apply plan write/readback bytes or SHA-256 differ.");
    }
    const finalStats = requiredRegularHandle(
      fileSystem.fstat(descriptor),
      "read-back reviewed apply plan",
    );
    const finalBoundary = inspectOutputBoundary({
      fileSystem,
      workspaceRoot: root,
      outputPath,
      outputMustExist: true,
    });
    assertSameBoundary(writtenBoundary, finalBoundary, "during descriptor readback");
    assertHandleMatchesBoundary(finalStats, finalBoundary, "descriptor readback");
  } finally {
    fileSystem.close(descriptor);
  }

  return deepFreeze({
    exitCode: 0,
    mode: "create_reviewed_exact_one_apply_plan",
    schema_version: created.plan.schema_version,
    output_file: workspaceRelativePath(root, outputPath),
    selected_source_id: selectedSourceId,
    deferred_source_count: created.plan.deferred_source_ids.length,
    report_file_sha256: expectedReportSha256,
    plan_file_sha256: created.plan_file_sha256,
    plan_sha256: created.plan.plan_sha256,
    reviewed_at: reviewedAt,
    expires_at: expiresAt,
    mutation_performed: false,
    creates_api_charge: false,
  });
}

function inspectOutputBoundary({
  fileSystem,
  workspaceRoot,
  outputPath,
  outputMustExist,
}) {
  const reportsRoot = resolve(workspaceRoot, "reports");
  if (!isContainedPath(reportsRoot, outputPath, { allowEqual: false })) {
    throw new Error("--output-file must remain under the workspace reports directory.");
  }
  const outputParent = dirname(outputPath);
  const relativeParent = relative(reportsRoot, outputParent);
  const pathSegments = !relativeParent || relativeParent === "."
    ? []
    : relativeParent.split(/[\\/]+/u).filter(Boolean);
  const inspectedDirectories = [];
  let cursor = reportsRoot;
  for (const segment of [null, ...pathSegments]) {
    if (segment !== null) cursor = resolve(cursor, segment);
    const stats = requiredLstat(fileSystem, cursor, "reviewed plan output directory");
    if (!stats.isDirectory?.()) {
      throw new Error("Every reviewed plan output parent must already be a directory.");
    }
    if (isReparsePoint(stats)) {
      throw new Error("Reviewed plan output parents cannot be symlink or reparse points.");
    }
    inspectedDirectories.push({
      path: cursor,
      identity: statIdentity(stats),
    });
  }

  const canonicalReportsRoot = resolve(fileSystem.realpath(reportsRoot));
  const canonicalParent = resolve(fileSystem.realpath(outputParent));
  if (!isContainedPath(canonicalReportsRoot, canonicalParent, { allowEqual: true })) {
    throw new Error("The canonical reviewed plan output parent escapes workspace reports.");
  }

  const outputStats = optionalLstat(fileSystem, outputPath);
  if (!outputMustExist && outputStats) {
    throw new Error("Refusing to replace an existing reviewed apply plan output file.");
  }
  let outputIdentity = null;
  let canonicalOutput = null;
  if (outputMustExist) {
    if (!outputStats) {
      throw new Error("The reviewed apply plan output disappeared after its exclusive write.");
    }
    if (!outputStats.isFile?.() || isReparsePoint(outputStats)) {
      throw new Error("The reviewed apply plan output is not one regular non-reparse file.");
    }
    canonicalOutput = resolve(fileSystem.realpath(outputPath));
    const expectedCanonicalOutput = resolve(canonicalParent, basename(outputPath));
    if (
      !samePath(canonicalOutput, expectedCanonicalOutput)
      || !isContainedPath(canonicalReportsRoot, canonicalOutput, { allowEqual: false })
    ) {
      throw new Error("The canonical reviewed apply plan output escaped its checked parent.");
    }
    outputIdentity = statIdentity(outputStats);
  }

  return {
    canonical_reports_root: canonicalReportsRoot,
    canonical_parent: canonicalParent,
    canonical_output: canonicalOutput,
    directories: inspectedDirectories,
    output_identity: outputIdentity,
  };
}

function assertSameBoundary(before, after, phase) {
  if (
    !samePath(before.canonical_reports_root, after.canonical_reports_root)
    || !samePath(before.canonical_parent, after.canonical_parent)
    || before.directories.length !== after.directories.length
    || before.directories.some((entry, index) => (
      !samePath(entry.path, after.directories[index]?.path)
      || entry.identity !== after.directories[index]?.identity
    ))
    || (
      before.output_identity !== null
      && before.output_identity !== after.output_identity
    )
  ) {
    throw new Error(`The reviewed plan output boundary drifted ${phase}.`);
  }
}

function assertEmptyRegularHandle(stats) {
  const value = requiredRegularHandle(stats, "new reviewed apply plan");
  if (Number(value.size) !== 0) {
    throw new Error("The exclusively opened reviewed apply plan was not empty.");
  }
  return value;
}

function requiredRegularHandle(stats, label) {
  if (!stats || typeof stats !== "object" || !stats.isFile?.()) {
    throw new Error(`The ${label} descriptor is not one regular file.`);
  }
  return stats;
}

function assertHandleMatchesBoundary(stats, boundary, phase) {
  if (
    boundary.output_identity === null
    || statIdentity(stats) !== boundary.output_identity
  ) {
    throw new Error(
      `The reviewed apply plan descriptor escaped or changed during ${phase}.`,
    );
  }
}

function writeExactDescriptor(fileSystem, descriptor, bytes) {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const written = fileSystem.write(
      descriptor,
      bytes,
      offset,
      bytes.byteLength - offset,
      offset,
    );
    if (
      !Number.isSafeInteger(written)
      || written <= 0
      || written > bytes.byteLength - offset
    ) {
      throw new Error("The reviewed apply plan descriptor write did not make progress.");
    }
    offset += written;
  }
}

function readExactDescriptor(fileSystem, descriptor, byteLength) {
  const bytes = Buffer.alloc(byteLength);
  let offset = 0;
  while (offset < byteLength) {
    const read = fileSystem.read(
      descriptor,
      bytes,
      offset,
      byteLength - offset,
      offset,
    );
    if (
      !Number.isSafeInteger(read)
      || read <= 0
      || read > byteLength - offset
    ) {
      throw new Error("The reviewed apply plan descriptor read ended before its sealed length.");
    }
    offset += read;
  }
  return bytes;
}

function parseArgs(argv) {
  if (!Array.isArray(argv)) throw new TypeError("Reviewed apply plan argv must be an array.");
  const args = Object.create(null);
  for (const token of argv) {
    if (token === "--help") {
      if (Object.hasOwn(args, "help")) {
        throw new Error("Duplicate reviewed apply plan argument: --help.");
      }
      args.help = true;
      continue;
    }
    if (typeof token !== "string" || !token.startsWith("--") || !token.includes("=")) {
      throw new Error(
        `Reviewed apply plan CLI requires --name=value arguments; received ${String(token)}.`,
      );
    }
    const separator = token.indexOf("=");
    const key = token.slice(2, separator);
    const value = token.slice(separator + 1);
    if (
      !/^[a-z][a-z0-9-]*$/u.test(key)
      || value.length === 0
      || Object.hasOwn(args, key)
    ) {
      throw new Error(`Reviewed apply plan argument is invalid or duplicated: --${key}.`);
    }
    args[key] = value;
  }
  return args;
}

function assertExactArgs(args) {
  const supplied = Object.keys(args);
  const unexpected = supplied.filter((key) => !PLAN_ARGS.includes(key)).sort();
  if (unexpected.length) {
    throw new Error(`Reviewed apply plan CLI forbids arguments: ${unexpected.join(",")}.`);
  }
  const missing = PLAN_ARGS.filter((key) => !Object.hasOwn(args, key)).sort();
  if (missing.length) {
    throw new Error(`Reviewed apply plan CLI is missing arguments: ${missing.join(",")}.`);
  }
}

function assertFileSystem(value) {
  const fileSystem = requiredObject(value, "reviewed apply plan file-system interface");
  for (const name of [
    "close",
    "fstat",
    "fsync",
    "lstat",
    "open",
    "read",
    "readFile",
    "realpath",
    "write",
  ]) {
    if (typeof fileSystem[name] !== "function") {
      throw new TypeError(`Reviewed apply plan file-system interface requires ${name}().`);
    }
  }
  return fileSystem;
}

function assertClock(value) {
  const clock = requiredObject(value, "reviewed apply plan clock interface");
  if (typeof clock.now !== "function") {
    throw new TypeError("Reviewed apply plan clock interface requires now().");
  }
  return clock;
}

function requiredLstat(fileSystem, path, label) {
  const stats = optionalLstat(fileSystem, path);
  if (!stats) throw new Error(`The ${label} does not exist: ${path}`);
  return stats;
}

function optionalLstat(fileSystem, path) {
  try {
    return fileSystem.lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return null;
    throw error;
  }
}

function isReparsePoint(stats) {
  return stats.isSymbolicLink?.() === true
    || stats.isReparsePoint?.() === true
    || stats.reparsePoint === true;
}

function statIdentity(stats) {
  const device = stats.dev ?? "unknown-device";
  const inode = stats.ino ?? "unknown-inode";
  return `${String(device)}:${String(inode)}`;
}

function isContainedPath(parent, target, { allowEqual }) {
  const pathFromParent = relative(resolve(parent), resolve(target));
  if (!pathFromParent || pathFromParent === ".") return allowEqual;
  return pathFromParent !== ".."
    && !pathFromParent.startsWith(`..\\`)
    && !pathFromParent.startsWith("../")
    && !isAbsolute(pathFromParent);
}

function samePath(left, right) {
  const first = resolve(left);
  const second = resolve(right);
  return process.platform === "win32"
    ? first.toLowerCase() === second.toLowerCase()
    : first === second;
}

function workspaceRelativePath(workspaceRoot, path) {
  return relative(workspaceRoot, path).split("\\").join("/");
}

function resolveInput(workspaceRoot, value) {
  return isAbsolute(value) ? resolve(value) : resolve(workspaceRoot, value);
}

function requiredSha256(value, label) {
  const text = requiredText(value, label);
  if (!SHA256_PATTERN.test(text)) {
    throw new Error(`${label} must be one lowercase SHA-256.`);
  }
  return text;
}

function requiredUuid(value, label) {
  const text = requiredText(value, label);
  if (!UUID_PATTERN.test(text)) {
    throw new Error(`${label} must be one lowercase UUID.`);
  }
  return text;
}

function requiredTimestamp(value, label) {
  const text = requiredText(value, label);
  const milliseconds = Date.parse(text);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== text) {
    throw new Error(`${label} must be one canonical UTC timestamp.`);
  }
  return text;
}

function requiredText(value, label) {
  if (typeof value !== "string" || !value || value.trim() !== value) {
    throw new Error(`${label} is required without surrounding whitespace.`);
  }
  return value;
}

function requiredObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`The ${label} must be an object.`);
  }
  return value;
}

function exactBytes(value, label) {
  if (typeof value === "string") return Buffer.from(value, "utf8");
  if (value instanceof Uint8Array) return Buffer.from(value);
  throw new TypeError(`The ${label} read must return exact bytes.`);
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

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const entry of Object.values(value)) deepFreeze(entry);
  return value;
}

function helpText() {
  return [
    "Create one canonical Stage 1 reviewed exact-one apply plan (no live operations).",
    "",
    "Usage:",
    "  node scripts/create-stage1-evidence-schema-upgrade-reviewed-apply-plan.mjs \\",
    "    --report-file=reports/<reviewed-dry-run>.json \\",
    "    --report-sha256=<64-lowercase-hex> \\",
    "    --selected-source-id=<lowercase-uuid> \\",
    "    --reviewer-id=<human-reviewer> \\",
    "    --reviewed-at=<canonical-UTC-ISO> \\",
    "    --expires-at=<canonical-UTC-ISO> \\",
    "    --output-file=reports/<new-plan>.json",
    "",
    "The report is read exactly once and its raw SHA-256 is checked before plan",
    "construction. The output must be a new regular file below workspace reports/.",
    "The command performs no capture, apply, recovery, database, R2, AI, or config I/O.",
  ].join("\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = runStage1EvidenceSchemaUpgradeReviewedApplyPlanCli();
    console.log(result.help || JSON.stringify(result));
    process.exitCode = result.exitCode;
  } catch (error) {
    console.error(error?.message || String(error));
    process.exitCode = 1;
  }
}
