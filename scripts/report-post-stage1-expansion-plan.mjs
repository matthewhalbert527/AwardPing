#!/usr/bin/env node
/**
 * Offline review report over one explicit post-Stage-1 expansion plan input.
 *
 * Reads one JSON document from a local path or stdin, runs the existing
 * `buildPostStage1ExpansionPlan`, and writes the builder's result to stdout
 * inside a review-only envelope. It does nothing else: no environment
 * loading, no repository config or seed import, no database or network API, no
 * output files, and nothing from the input is imported, evaluated or
 * resolved as a module or a URL.
 *
 * It approves nothing. The builder pins every lifecycle field to an
 * unresolved or false value and uses the supplied Stage 1 identity only to
 * reject an overlapping candidate; this command copies that result through
 * unchanged and adds no judgement of its own. A successful run means the
 * supplied input satisfied the builder's structural checks, and nothing more.
 *
 * Anything malformed fails closed: the report is written in one call after
 * the plan is built, so a rejected input produces no partial output.
 */
import { readFile } from "node:fs/promises";
import process from "node:process";

import {
  POST_STAGE1_EXPANSION_CANDIDATES_SCHEMA,
  POST_STAGE1_EXPANSION_PLAN_VERSION,
  buildPostStage1ExpansionPlan,
} from "./lib/post-stage1-expansion-plan.mjs";

const REPORT_SCHEMA = "post-stage1-expansion-plan-report-v1";

/**
 * What a reader must not conclude from a successful report. These are part
 * of the output, not a comment, because the JSON is what gets forwarded.
 */
const DISCLAIMERS = Object.freeze({
  reportScope:
    "Offline review material only. This command reads one explicit input, runs the existing plan builder, and writes JSON to stdout. It uses no database or network APIs and reads no repository configuration or environment. The caller controls where the input file is stored, including whether its filesystem is network-backed.",
  monitorableSources:
    "monitorableSources lists declared, unverified source candidates carried from the supplied override packet. Listing one is not evidence that the URL is official, reachable, current, or correctly bound to the candidate award.",
  successMeaning:
    "A successful report is not current-cycle authority, not a human review, not actual monitoring, and not publication readiness. It states only that the supplied input satisfied the builder's structural checks.",
  stage1Fence:
    "Stage 1 remains the anchored cohort supplied in the input. The builder uses that identity only to reject a candidate that overlaps it. This command neither widens, renumbers, nor re-anchors it.",
  lifecycle:
    "Every lifecycle field in every plan is pinned by the builder to an unresolved or false value. This command copies those values through and never raises one.",
});

const HELP = `Report the offline post-Stage-1 expansion plan for one explicit input.

Usage:
  node scripts/report-post-stage1-expansion-plan.mjs --input <path>
  node scripts/report-post-stage1-expansion-plan.mjs --input -

Options:
  --input <path>   local JSON file to read, or "-" to read stdin
  --help, -h       print this message

The input document must be one JSON object with the four required fields the
builder takes, each supplied explicitly by the caller:

  {
    "config":         { "schema": "${POST_STAGE1_EXPANSION_CANDIDATES_SCHEMA}", "candidates": [ ... ] },
    "seeds":          [ ... ],
    "overrides":      [ ... ],
    "stage1Identity": [ ... ]
  }

No part of the input is read from this repository. Supply the candidate
config, the seed catalog, the source override packet, and the exact anchored
Stage 1 identity yourself, so the report describes the material you reviewed.
stage1Identity must contain all 25 anchored rows, each with cohortKey,
canonicalName, canonicalSearchKey, canonicalSlug and officialHomepage, plus
aliasSearchKeys where defined. Reuse the reviewed identity projection; a
smaller, widened or altered identity is rejected. Extra root fields are
ignored by the existing builder, not treated as evidence or approval.

The command does not fetch URLs or call network services. The caller is
responsible for choosing an input file on a local filesystem; the command
cannot determine whether a drive or mount is backed by a network share.

Output is a single JSON object on stdout: the report schema, the builder's
plan version, the review status, the disclaimers, and the builder result
copied through unchanged.

An unknown, repeated, or incomplete option, an unreadable file, malformed
JSON, or any input the builder rejects exits non-zero and writes nothing to
stdout.

This command approves nothing. It does not establish current-cycle authority,
human review, monitoring, or publication readiness for any candidate, and it
does not change the anchored Stage 1 cohort.
`;

class UsageError extends Error {}

/**
 * Strict: an unknown, repeated, or valueless option is refused rather than
 * silently overwritten by a later one.
 */
function parseArgs(argv) {
  let input;
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      if (help) throw new UsageError(`repeated option ${JSON.stringify(arg)}`);
      help = true;
      continue;
    }
    if (arg === "--input") {
      if (input !== undefined) throw new UsageError('repeated option "--input"');
      const value = argv[index + 1];
      // "-" is the stdin token; anything else starting with a dash is the
      // next option, so the value is missing rather than unusual.
      if (value === undefined || (value !== "-" && value.startsWith("-"))) {
        throw new UsageError('--input requires a path or "-"');
      }
      input = value;
      index += 1;
      continue;
    }
    throw new UsageError(`unknown argument ${JSON.stringify(arg)}`);
  }

  if (help) return { help: true, input: null };
  if (input === undefined) throw new UsageError('--input <path|-> is required');
  return { help: false, input };
}

async function readInput(input) {
  if (input !== "-") return readFile(input, "utf8");
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
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

  // The builder owns every structural rule, including the exact Stage 1
  // anchoring. It throws on anything it will not accept, before this command
  // has written a byte.
  const plan = buildPostStage1ExpansionPlan(document);

  process.stdout.write(`${JSON.stringify({
    schema: REPORT_SCHEMA,
    reviewStatus: "offline_review_only_not_approved",
    candidatesSchema: POST_STAGE1_EXPANSION_CANDIDATES_SCHEMA,
    planVersion: POST_STAGE1_EXPANSION_PLAN_VERSION,
    disclaimers: DISCLAIMERS,
    plan,
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`report-post-stage1-expansion-plan: ${error.message}\n`);
  process.exitCode = 1;
});
