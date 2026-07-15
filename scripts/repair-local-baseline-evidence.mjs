#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  parseSourceIdsFileContent,
  repairLocalBaselineEvidence,
} from "./lib/local-baseline-evidence.mjs";
import { atomicWriteJson } from "./lib/visual-baseline-lock.mjs";

const root = resolve(import.meta.dirname, "..");
const args = parseArgs(process.argv.slice(2));
if (args.help || args.h) {
  printHelp();
  process.exit(0);
}

const envPath = args.env ? resolve(root, String(args.env)) : resolve(root, ".env.local");
const env = { ...loadEnvFile(envPath), ...process.env };
const archiveRoot = resolve(
  String(args["archive-dir"] || env.AWARDPING_VISUAL_SNAPSHOT_DIR || "D:\\AwardPingVisualSnapshots"),
);
const sourceIdsFileValue = String(args["source-ids-file"] || "").trim();
if (!sourceIdsFileValue) {
  console.error("--source-ids-file is required. Broad unbounded scans are not supported.");
  process.exit(1);
}
const sourceIdsFile = resolve(root, sourceIdsFileValue);
if (!existsSync(sourceIdsFile)) {
  console.error(`--source-ids-file does not exist: ${sourceIdsFile}`);
  process.exit(1);
}

let apply;
let requireComplete;
let limit;
try {
  apply = boolArg(args.apply, false, "--apply");
  requireComplete = boolArg(args["require-complete"], false, "--require-complete");
  limit = positiveInt(args.limit, 1_000, "--limit");
} catch (error) {
  console.error(errorMessage(error));
  process.exit(1);
}
let requestedSourceIds;
try {
  requestedSourceIds = parseSourceIdsFileContent(readFileSync(sourceIdsFile, "utf8"));
} catch (error) {
  console.error(`Could not parse --source-ids-file: ${errorMessage(error)}`);
  process.exit(1);
}
const sourceIds = requestedSourceIds.slice(0, limit);
const reportPath = args.report
  ? resolve(root, String(args.report))
  : join(root, "reports", `local-baseline-evidence-${timestampForPath(new Date().toISOString())}.json`);
const report = {
  started_at: new Date().toISOString(),
  finished_at: null,
  apply,
  require_complete: requireComplete,
  archive_root: archiveRoot,
  source_ids_file: sourceIdsFile,
  report_path: reportPath,
  requested_source_ids: requestedSourceIds.length,
  selected_source_ids: sourceIds.length,
  source_ids_truncated: requestedSourceIds.length > sourceIds.length,
  limit,
  scanned: 0,
  repairable: 0,
  repaired: 0,
  refused: 0,
  failed: 0,
  evidence_complete: 0,
  evidence_incomplete: 0,
  reason_counts: {},
  rows: [],
};

for (const sourceId of sourceIds) {
  try {
    const result = await repairLocalBaselineEvidence({
      archiveRoot,
      sourceId,
      apply,
    });
    report.scanned += 1;
    if (result.status === "repairable") report.repairable += 1;
    else if (result.status === "repaired") report.repaired += 1;
    else report.refused += 1;
    if (result.evidence_complete === true) report.evidence_complete += 1;
    else report.evidence_incomplete += 1;
    countReason(report.reason_counts, result.reason);
    report.rows.push(publicResult(result));
  } catch (error) {
    report.scanned += 1;
    report.failed += 1;
    report.evidence_incomplete += 1;
    countReason(report.reason_counts, "unexpected_error");
    report.rows.push({
      source_id: sourceId,
      status: "failed",
      decision: "error",
      reason: "unexpected_error",
      detail: errorMessage(error),
    });
  }
}

report.finished_at = new Date().toISOString();
atomicWriteJson(reportPath, report);
console.log(JSON.stringify(report, null, 2));
console.log(`LOCAL_BASELINE_EVIDENCE_REPORT ${reportPath}`);
if (report.failed > 0 || (requireComplete && report.evidence_incomplete > 0)) {
  process.exitCode = 1;
}

function publicResult(result) {
  const safe = { ...result };
  delete safe.repaired_baseline;
  return safe;
}

function countReason(counts, reason) {
  const key = String(reason || "unknown");
  counts[key] = (counts[key] || 0) + 1;
}

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) continue;
    const separator = value.indexOf("=");
    if (separator > 2) {
      parsed[value.slice(2, separator)] = value.slice(separator + 1);
      continue;
    }
    const key = value.slice(2);
    const next = values[index + 1];
    if (next && !next.startsWith("--")) {
      parsed[key] = next;
      index += 1;
    } else {
      parsed[key] = true;
    }
  }
  return parsed;
}

function boolArg(value, fallback, label) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  const normalized = String(value).toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new TypeError(`${label} must be true or false.`);
}

function positiveInt(value, fallback, label) {
  if (value === undefined || value === null || value === "") return fallback;
  if (!/^\d+$/.test(String(value))) {
    throw new TypeError(`${label} must be a positive integer.`);
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new TypeError(`${label} must be a positive integer.`);
  }
  return number;
}

function timestampForPath(value) {
  return String(value || new Date().toISOString()).replace(/[:.]/g, "-");
}

function loadEnvFile(path) {
  if (!existsSync(path)) return {};
  const loaded = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    loaded[match[1]] = unquote(match[2].trim());
  }
  return loaded;
}

function unquote(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function errorMessage(error) {
  return String(error?.message || error || "unknown error");
}

function printHelp() {
  console.log(`Repair dangling local AwardPing baseline evidence pointers.

Dry-run is the default. The command only considers explicit source IDs.

Usage:
  node scripts/repair-local-baseline-evidence.mjs --source-ids-file=<path> [options]

Options:
  --apply=true          Atomically apply validated repairs (default: false)
  --require-complete=true
                        Exit nonzero if any selected source remains unusable
  --source-ids-file     Required newline text, JSON array, or {"source_ids": [...]}
  --limit=<count>       Maximum source IDs to inspect (default: 1000)
  --archive-dir=<path>  Override AWARDPING_VISUAL_SNAPSHOT_DIR
  --env=<path>          Environment file relative to the repository root
  --report=<path>       Override the timestamped JSON report path
`);
}
