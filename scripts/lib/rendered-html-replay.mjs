import { resolve } from "node:path";
import { compareRetainedHtmlCaptures, loadRetainedHtmlCaptureRecord } from "./rendered-html-comparison.mjs";

export const renderedHtmlReplayManifestSchema = "awardping.html-replay-manifest.v1";
export const renderedHtmlReplayReportSchema = "awardping.html-replay-report.v1";
const statuses = ["changed", "unchanged", "unavailable", "first_observation"];
const identifier = /^[A-Za-z0-9._-]{1,160}$/;
const reasonCode = /^[a-z][a-z0-9_]{0,120}$/;

/**
 * Explicit pairs only: no discovery, network, credentials, writes, or worker run.
 * Labels are reviewer assertions, not independently established ground truth.
 * This replay can characterize behavior; it can never authorize activation.
 */
export function replayRetainedHtmlManifest({ manifest, archiveRoot }) {
  validateManifest(manifest);
  if (typeof archiveRoot !== "string" || !archiveRoot) invalidManifest();
  const summary = {
    pairs: manifest.pairs.length, comparable: 0, changed: 0, unchanged: 0,
    unavailable: 0, first_observation: 0, reviewer_labelled: 0,
    expectations_matched: 0, expectations_mismatched: 0, unassessed: 0,
  };
  const results = manifest.pairs.map((pair) => {
    let side = "previous";
    let previous = null;
    let current = null;
    let diagnostic;
    try {
      if (pair.previous_meta !== null) previous = load(pair.previous_meta);
      side = "current";
      current = load(pair.current_meta);
      diagnostic = compareRetainedHtmlCaptures({ previous: previous?.capture || null, current: current.capture, sourceId: pair.source_id, archiveRoot });
    } catch (error) {
      diagnostic = {
        status: "unavailable",
        reason: `${side}_${error?.replaySourceMismatch ? "source_mismatch" : "evidence_invalid"}`,
        previous: null, current: null, changes: null,
      };
    }
    function load(path) {
      const record = loadRetainedHtmlCaptureRecord({ metadataPath: resolve(archiveRoot, path), archiveRoot });
      if (record.capture.source?.id !== pair.source_id) throw Object.assign(new Error("source_mismatch"), { replaySourceMismatch: true });
      return record;
    }
    summary[diagnostic.status] += 1;
    if (diagnostic.status === "changed" || diagnostic.status === "unchanged") summary.comparable += 1;
    let evaluation = "unassessed";
    if (pair.expectation) {
      summary.reviewer_labelled += 1;
      const matches = diagnostic.status === pair.expectation.status &&
        (pair.expectation.reason === undefined || pair.expectation.reason === diagnostic.reason);
      evaluation = matches ? "matched" : "mismatched";
      summary[matches ? "expectations_matched" : "expectations_mismatched"] += 1;
    } else summary.unassessed += 1;
    return {
      id: pair.id, source_id: pair.source_id,
      previous_meta: pair.previous_meta, current_meta: pair.current_meta,
      status: diagnostic.status, reason: diagnostic.reason,
      visible_text_changed: diagnostic.visible_text_changed ?? null,
      previous: diagnostic.previous, current: diagnostic.current,
      metadata_sha256: { previous: previous?.metadata_sha256 || null, current: current?.metadata_sha256 || null },
      changes: diagnostic.changes ? countProjection(diagnostic.changes) : null,
      expectation: pair.expectation || null, evaluation,
    };
  });
  return {
    schema: renderedHtmlReplayReportSchema,
    mode: "offline_shadow", publishable: false, activation_ready: false,
    evidence_basis: "local_retained_files",
    visibility: "not_verified", screenshot_alignment: "not_verified",
    validation_status: summary.comparable === 0 ? "no_comparable_pairs" :
      summary.expectations_mismatched ? "expectation_mismatch" :
        summary.unassessed ? "unassessed" : "expectations_matched",
    summary, results,
  };
}

function countProjection(changes) {
  return Object.fromEntries([
    "text_changed", "links_changed", "structure_changed", "order_only",
    "added_blocks", "removed_blocks", "added_links", "removed_links", "examples_truncated",
  ].map((key) => [key, changes[key]]));
}

function validateManifest(manifest) {
  if (!record(manifest, ["schema", "pairs"]) || manifest.schema !== renderedHtmlReplayManifestSchema ||
      !Array.isArray(manifest.pairs) || manifest.pairs.length < 1 || manifest.pairs.length > 100) invalidManifest();
  const ids = new Set();
  for (const pair of manifest.pairs) {
    if (!record(pair, ["id", "source_id", "previous_meta", "current_meta", "expectation"]) ||
        typeof pair.id !== "string" || !identifier.test(pair.id) || ids.has(pair.id) ||
        typeof pair.source_id !== "string" || !identifier.test(pair.source_id) ||
        !relativeMetadataPath(pair.current_meta) ||
        !(pair.previous_meta === null || relativeMetadataPath(pair.previous_meta))) invalidManifest();
    ids.add(pair.id);
    if (pair.expectation !== undefined && (!record(pair.expectation, ["status", "reason"]) ||
        !statuses.includes(pair.expectation.status) ||
        (pair.expectation.reason !== undefined && (typeof pair.expectation.reason !== "string" || !reasonCode.test(pair.expectation.reason))))) invalidManifest();
  }
}

function record(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value)) &&
    Object.keys(value).every((key) => keys.includes(key));
}

function relativeMetadataPath(value) {
  return typeof value === "string" && value.length <= 2000 && value.endsWith("/meta.json") &&
    !/[\\:\u0000-\u001f\u007f]/u.test(value) &&
    value.split("/").every((part) => part && part !== "." && part !== "..");
}

function invalidManifest() {
  throw Object.assign(new Error("Invalid rendered HTML replay manifest."), { code: "rendered_html_replay_manifest_invalid" });
}
