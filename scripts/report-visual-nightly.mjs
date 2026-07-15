#!/usr/bin/env node
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { atomicWriteJson } from "./lib/visual-baseline-lock.mjs";
import {
  acquireFileLock,
  buildNightlyVisualReport,
  isDailyVisualShardReport,
  monitoringDateForTimestamp,
  monitoringDateForVisualReportFilename,
  shouldReplaceLatestNightlyReport,
} from "./lib/visual-capture-run-report.mjs";

const root = resolve(import.meta.dirname, "..");
const args = parseArgs(process.argv.slice(2));
const reportDir = resolve(String(args["reports-dir"] || join(root, "reports")));

await generateReport();

async function generateReport() {
  mkdirSync(reportDir, { recursive: true });
  const requestedDate = cleanText(args.date);
  const now = args.now ? new Date(String(args.now)) : new Date();
  if (Number.isNaN(now.getTime())) throw new Error(`Invalid --now timestamp: ${args.now}`);
  const monitoringDate = requestedDate || monitoringDateForTimestamp(now);
  const shouldWrite = boolArg(args.write, true);
  let releaseLock = null;

  try {
    releaseLock = await acquireFileLock(join(reportDir, "visual-nightly-report.lock"));
    const reportNames = readdirSync(reportDir)
      .filter((name) => /^visual-snapshot-run-.*\.json$/i.test(name));
    const reports = reportNames
      .filter((name) => {
        const filenameDate = monitoringDateForVisualReportFilename(name);
        return !filenameDate || filenameDate === monitoringDate;
      })
      .map((name) => readJson(join(reportDir, name)))
      .filter((report) => report && isDailyVisualShardReport(report))
      .filter((report) => monitoringDateForTimestamp(report.started_at) === monitoringDate);

    const hasNightlyHistory = reports.length > 0 || Boolean(readJson(
      join(reportDir, "visual-nightly-report-latest.json"),
    ));
    if (!requestedDate && !hasNightlyHistory && localChicagoHour(now) < 18) {
      console.log("No 6 PM scan is due yet; the first report will be created after the next scheduled window.");
      return;
    }
    if (!requestedDate && reports.length === 0 && withinSixPmLaunchGrace(now)) {
      console.log(`The ${monitoringDate} 6 PM shards are still within their launch grace period.`);
      return;
    }

    const report = buildNightlyVisualReport(reports, {
      monitoringDate,
      generatedAt: now.toISOString(),
    });
    if (shouldWrite) {
      atomicWriteJson(join(reportDir, `visual-nightly-report-${monitoringDate}.json`), report);
      const latestPath = join(reportDir, "visual-nightly-report-latest.json");
      if (shouldReplaceLatestNightlyReport(readJson(latestPath), report)) {
        atomicWriteJson(latestPath, report);
      }
    }

    if (boolArg(args.json, false)) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(`AwardPing 6 PM capture report — ${report.monitoring_date}`);
      console.log(`Status: ${report.status}`);
      console.log(`Shards: ${report.completed_shards}/${report.expected_shards} complete`);
      if (report.missing_shards.length) console.log(`Missing shards: ${report.missing_shards.join(", ")}`);
      console.log(`Sources loaded: ${report.totals.loaded_sources}`);
      console.log(`Pages captured: ${report.totals.pages_captured}`);
      console.log(`Source failures: ${report.totals.source_failures}`);
      console.log(`Failures / loaded sources: ${report.totals.failure_rate_percent}%`);
      if (report.failure_groups.length) {
        console.log("");
        console.log("Failures and safe repairs:");
        for (const group of report.failure_groups) {
          console.log(`- ${group.count} × ${group.label} [${group.retry_mode}]`);
          console.log(`  ${group.solution}`);
        }
      }
      if (shouldWrite) console.log(`Report: ${join(reportDir, `visual-nightly-report-${monitoringDate}.json`)}`);
    }
  } finally {
    releaseLock?.();
  }
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) continue;
    const separator = value.indexOf("=");
    if (separator >= 0) {
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

function boolArg(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

function cleanText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function withinSixPmLaunchGrace(now) {
  return localChicagoHour(now) === 18;
}

function localChicagoHour(now) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  return Number(parts.find((part) => part.type === "hour")?.value);
}
