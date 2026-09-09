#!/usr/bin/env node
/**
 * Offline evidence-attribution report over an exported candidate set.
 *
 * Reads one JSON document from a local path or stdin, writes a report to
 * stdout, and does nothing else: no environment loading, no database, no
 * network, no output files, and nothing from the input is imported, evaluated
 * or resolved as a module or path. It changes no gate and publishes nothing.
 */
import { readFile } from "node:fs/promises";
import process from "node:process";

import {
  QUOTE_CONTAINER_PATHS,
  REVIEW_CAVEAT,
  auditAwards,
  parseAuditInput,
} from "./lib/award-fact-evidence-audit.mjs";

const HELP = `Report baseline evidence attribution for exported fact candidates.

Usage:
  node scripts/report-award-fact-evidence.mjs --input <path>  [--format json|table]
  node scripts/report-award-fact-evidence.mjs --input -       [--format json|table]

Options:
  --input <path>   local JSON file to read, or "-" to read stdin
  --format <kind>  json (default) or table
  --help           print this message

Input shape (schemaVersion 1):
  {
    "schemaVersion": 1,
    "awards": [
      {
        "id": "award-uuid",
        "name": "Example Award",
        "candidates": [
          {
            "id": "candidate-uuid",
            "field_name": "deadline",
            "raw_value": "October 1, 2026",
            "evidence_quote": "The student deadline is October 1, 2026.",
            "shared_award_source_id": "source-uuid"
          }
        ],
        "sources": [
          {
            "id": "source-uuid",
            "url": "https://example.edu/apply",
            "page_metadata": { "baseline_facts": { "evidence_quotes": ["..."] } }
          }
        ]
      }
    ]
  }

Identifiers must be non-empty strings when present. A candidate with no
shared_award_source_id is reported as an unresolved binding rather than
rejected, so a missing binding stays diagnosable.

Source quotes are read from every one of these paths, and none outranks
another:
${QUOTE_CONTAINER_PATHS.map((path) => `  ${path.join(".")}`).join("\n")}

Quote availability is reported as known (a count, possibly zero), unknown (no
container present), invalid (a container in an unusable shape), ambiguous (two
containers disagree), or unresolved_source. A missing container is never
reported as a count of zero.

What the report does NOT do:
  ${REVIEW_CAVEAT}
  No row is a verdict. There is no verified, pass, or publication-ready field,
  and no score. Candidates that could not be assessed are counted and given a
  reason, never dropped. An input with no candidates means none were provided,
  not success.
`;

function parseArgs(argv) {
  const options = { input: null, format: "json", help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--input") options.input = argv[++index] ?? null;
    else if (arg === "--format") options.format = argv[++index] ?? "";
    else throw new Error(`unknown argument ${JSON.stringify(arg)}`);
  }
  if (options.help) return options;
  if (!options.input) throw new Error("--input <path|-> is required");
  if (!["json", "table"].includes(options.format)) {
    throw new Error(`--format must be json or table, received ${JSON.stringify(options.format)}`);
  }
  return options;
}

async function readInput(input) {
  if (input !== "-") return readFile(input, "utf8");
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function flagLabels(flags) {
  return Object.entries(flags)
    .filter(([, value]) => value === true)
    .map(([name]) => name)
    .join(",") || "-";
}

function describeValue(row) {
  if (row.valueItemKind === "text") return JSON.stringify(row.valueItemText);
  return `<${row.valueItemKind}>`;
}

function renderTable(reports) {
  const lines = [REVIEW_CAVEAT, ""];
  let candidatesSeen = 0;
  for (const report of reports) {
    candidatesSeen += report.summary.candidatesSeen;
    lines.push(`award ${report.awardId}${report.awardName ? ` (${report.awardName})` : ""}`);
    lines.push(`  candidates seen: ${report.summary.candidatesSeen}`);
    lines.push(`  value items assessed: ${report.summary.valueItemsAssessed}`);
    lines.push(`  value items unassessed: ${report.summary.valueItemsUnassessed}`);
    for (const [name, count] of Object.entries(report.summary.flagCounts)) lines.push(`  ${name}: ${count}`);
    for (const [reason, count] of Object.entries(report.summary.reasonCounts)) lines.push(`  reason ${reason}: ${count}`);
    for (const row of report.rows) {
      const availability = row.quoteAvailability.status === "known"
        ? `quotes=${row.quoteAvailability.count}`
        : `quotes=${row.quoteAvailability.status}`;
      lines.push(
        `  [${row.candidateIndex}.${row.valueIndex}] ${row.fieldName ?? "<invalid field>"}`
        + ` | source=${row.sourceIdRef === null ? "none" : JSON.stringify(row.sourceIdRef)}(${row.sourceResolution})`
        + ` | ${availability}`
        + ` | value=${describeValue(row)}`
        + ` | quote=${row.assignedQuote === null ? "none" : JSON.stringify(row.assignedQuote)}`
        + `${row.unassessedReason ? ` | reason=${row.unassessedReason}` : ""}`
        + ` | flags=${flagLabels(row.flags)}`,
      );
    }
    lines.push("");
  }
  if (candidatesSeen === 0) lines.push("no candidates were provided");
  return lines.join("\n");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(HELP);
    return;
  }

  const text = await readInput(options.input);
  let document;
  try {
    document = JSON.parse(text);
  } catch (error) {
    throw new Error(`input is not valid JSON: ${error.message}`);
  }

  const reports = auditAwards(parseAuditInput(document));
  const noCandidatesProvided = reports.every((report) => report.summary.noCandidatesProvided);

  if (options.format === "table") {
    process.stdout.write(`${renderTable(reports)}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify({
    caveat: REVIEW_CAVEAT,
    quoteContainerPaths: QUOTE_CONTAINER_PATHS.map((path) => path.join(".")),
    noCandidatesProvided,
    reports,
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`report-award-fact-evidence: ${error.message}\n`);
  process.exitCode = 1;
});
