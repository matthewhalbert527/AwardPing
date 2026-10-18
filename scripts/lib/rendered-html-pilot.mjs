import { createHash } from "node:crypto";
import { appendFileSync, existsSync, lstatSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { normalizePublicHttpUrl } from "./public-network-safety.mjs";
import { assertRenderedHtmlArtifactIdentity } from "./r2-capture-artifact-bindings.mjs";
import { replayRetainedHtmlManifest, renderedHtmlReplayManifestSchema } from "./rendered-html-replay.mjs";

const identifier = /^[A-Za-z0-9._-]{1,160}$/;
const safeIdentifier = (value) => typeof value === "string" && identifier.test(value) &&
  value !== "." && value !== ".." && !value.endsWith(".") && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value);
const hash = (value) => createHash("sha256").update(value).digest("hex");
const profile = "html-pilot-passive-v1";
const writeNewJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });

export function validatePilotRoster(roster, { expectedAwardIds }) {
  if (roster?.schema !== "awardping.html-pilot-roster.v1" || !Array.isArray(roster.awards) || roster.awards.length !== 25 ||
      !Array.isArray(expectedAwardIds) || expectedAwardIds.length !== 25 || new Set(expectedAwardIds).size !== 25) throw new Error("Pilot requires the independently verified 25-award roster.");
  const expected = new Set(expectedAwardIds);
  const seen = new Set();
  const sources = new Map();
  const sourceCase = new Map();
  for (const award of roster.awards) {
    if (!safeIdentifier(award.award_id) || !expected.has(award.award_id) || seen.has(award.award_id.toLowerCase()) ||
        !Array.isArray(award.sources) || award.sources.length < 1 || award.sources.length > 40) throw new Error("Invalid pilot award identity or source list.");
    seen.add(award.award_id.toLowerCase());
    const local = new Set();
    for (const source of award.sources) {
      if (!safeIdentifier(source.id) || local.has(source.id) || !["html", "pdf"].includes(source.kind)) throw new Error("Invalid pilot source identity.");
      if (sourceCase.has(source.id.toLowerCase()) && sourceCase.get(source.id.toLowerCase()) !== source.id) throw new Error("Source storage identity collision.");
      sourceCase.set(source.id.toLowerCase(), source.id);
      local.add(source.id);
      const url = normalizePublicHttpUrl(source.url);
      if (url.port) throw new Error("Unsupported source port.");
      const prior = sources.get(source.id);
      if (prior && (prior.url !== url.href || prior.kind !== source.kind)) throw new Error("Conflicting source identity.");
      if (prior) prior.award_ids.push(award.award_id);
      else sources.set(source.id, { ...source, url: url.href, award_ids: [award.award_id] });
    }
  }
  if (sources.size > 300) throw new Error("Pilot source limit exceeded.");
  return { awards: roster.awards, htmlSources: [...sources.values()].filter((s) => s.kind === "html"), pdfSources: [...sources.values()].filter((s) => s.kind === "pdf") };
}

/** Fresh pilot files only. Existing archives/baselines are never opened or changed. */
export async function runHtmlPilot({ roster, expectedAwardIds, outputDir, allowedOutputRoot, captureImpl, concurrency = 2, onProgress = () => {} }) {
  const selected = validatePilotRoster(roster, { expectedAwardIds });
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 3 || typeof captureImpl !== "function") throw new Error("Invalid pilot execution options.");
  const parent = realpathSync(allowedOutputRoot);
  if (lstatSync(allowedOutputRoot).isSymbolicLink() || resolve(allowedOutputRoot) !== parent ||
      dirname(resolve(outputDir)) !== parent || existsSync(outputDir)) throw new Error("Pilot output must be a new immediate child of its real isolated root.");
  mkdirSync(outputDir);
  const archiveRoot = join(outputDir, "archive");
  mkdirSync(archiveRoot);
  const startedAt = new Date().toISOString();
  writeNewJson(join(outputDir, "roster.json"), roster);
  const attempts = new Map(selected.htmlSources.map((source) => [source.id, []]));
  const progressPath = join(outputDir, "progress.jsonl");
  writeFileSync(progressPath, "", { flag: "wx" });
  const metadataPath = (source, round) => `captures/${source.id}/round-${round}/meta.json`;

  // Round two begins only after round one has finished for the entire cohort.
  for (const round of [1, 2]) {
    let cursor = 0;
    await Promise.all(Array.from({ length: concurrency }, async () => {
      while (cursor < selected.htmlSources.length) {
        const source = selected.htmlSources[cursor++];
        const attempt = { source_id: source.id, round, started_at: new Date().toISOString(), status: "failed", reason: null, meta: null };
        try {
          const captured = await captureImpl(source, { round });
          const dir = join(archiveRoot, "captures", source.id, `round-${round}`);
          const metaPath = join(dir, "meta.json");
          const htmlPath = join(dir, "page.html.txt");
          const textPath = join(dir, "text.txt");
          const files = {
            meta: relative(archiveRoot, metaPath).replaceAll("\\", "/"),
            html: relative(archiveRoot, htmlPath).replaceAll("\\", "/"),
            text: relative(archiveRoot, textPath).replaceAll("\\", "/"),
          };
          const metadata = { ...captured.metadata, files };
          if (typeof captured.html !== "string" || typeof captured.text !== "string" || !captured.text.trim() || /[\r\n]$/.test(captured.text) ||
              metadata.kind !== "webpage" || metadata.source?.id !== source.id || metadata.source?.url !== source.url ||
              metadata.capture_profile !== profile || metadata.capture_behavior_version !== 1 || metadata.section_extraction_profile !== "no-interaction-v1" ||
              !Number.isInteger(metadata.status_code) || metadata.status_code < 200 || metadata.status_code >= 300 ||
              metadata.page_settle?.stable !== true || metadata.page_settle?.timed_out !== false || metadata.page_readiness?.timed_out !== false ||
              metadata.text_hash !== hash(captured.text) || metadata.text_length !== captured.text.length || captured.text.length > 250000) throw new Error("Invalid pilot capture.");
          if (normalizePublicHttpUrl(metadata.final_url).port) throw new Error("Unsupported final source port.");
          const body = Buffer.from(captured.html, "utf8");
          assertRenderedHtmlArtifactIdentity({
            capture: { ...metadata, html_path: htmlPath }, metadata, kind: "webpage",
            artifacts: new Map([["html", { path: htmlPath, fileName: "page.html.txt", contentType: "text/plain; charset=utf-8", body,
              binding: { sha256: hash(body), byte_length: body.length, content_type: "text/plain; charset=utf-8", hash_mode: "raw_sha256" } }]]),
          });
          // captureImpl has already closed its browser/network boundary. Only
          // complete validated in-memory evidence is retained as a successful pair.
          mkdirSync(dir, { recursive: true });
          writeFileSync(htmlPath, body, { flag: "wx" });
          writeFileSync(textPath, `${captured.text}\n`, { flag: "wx" });
          writeNewJson(metaPath, metadata);
          attempt.status = "captured";
          attempt.meta = files.meta;
        } catch (error) {
          attempt.reason = /^[a-z][a-z0-9_]{0,100}$/.test(String(error?.pilotReason || "")) ? error.pilotReason : "capture_failed";
        }
        attempt.finished_at = new Date().toISOString();
        attempts.get(source.id).push(attempt);
        appendFileSync(progressPath, `${JSON.stringify(attempt)}\n`);
        onProgress({ ...attempt });
      }
    }));
  }
  const pairs = selected.htmlSources.map((source) => ({ id: source.id, source_id: source.id, previous_meta: metadataPath(source, 1), current_meta: metadataPath(source, 2) }));
  const comparisons = [];
  const replayReports = [];
  for (let offset = 0; offset < pairs.length; offset += 100) {
    const manifest = { schema: renderedHtmlReplayManifestSchema, pairs: pairs.slice(offset, offset + 100) };
    const replay = replayRetainedHtmlManifest({ manifest, archiveRoot });
    const number = replayReports.length + 1;
    writeNewJson(join(outputDir, `replay-manifest-${number}.json`), manifest);
    writeNewJson(join(outputDir, `replay-report-${number}.json`), replay);
    replayReports.push(`replay-report-${number}.json`);
    comparisons.push(...replay.results);
  }
  writeNewJson(join(outputDir, "manifest.json"), { schema: "awardping.html-pilot-manifest.v1", pairs, replay_reports: replayReports });
  const allAttempts = [...attempts.values()].flat();
  const report = {
    schema: "awardping.html-pilot-report.v1", mode: "capture_only_pilot", publishable: false, activation_ready: false,
    started_at: startedAt, finished_at: new Date().toISOString(), capture_profile: profile,
    limitations: ["Two prospective same-day observations, not a historical accuracy benchmark.", "Passive DOM only; no accordion interaction, PDF parsing or screenshot localization.", "Capture failures and unavailable comparisons are not unchanged pages."],
    summary: {
      awards: selected.awards.length, html_sources: selected.htmlSources.length, pdf_sources: selected.pdfSources.length,
      attempts: allAttempts.length, captured: allAttempts.filter((a) => a.status === "captured").length, failed: allAttempts.filter((a) => a.status === "failed").length,
      comparable: comparisons.filter((c) => ["changed", "unchanged"].includes(c.status)).length,
      changed: comparisons.filter((c) => c.status === "changed").length, unchanged: comparisons.filter((c) => c.status === "unchanged").length,
      unavailable: comparisons.filter((c) => c.status === "unavailable").length,
    },
    awards: selected.awards.map((award) => {
      const html = selected.htmlSources.filter((s) => s.award_ids.includes(award.award_id));
      return {
        award_id: award.award_id, name: award.name, publication_status: award.publication_status || "not_asserted",
        html_sources: html.length, pdf_sources: selected.pdfSources.filter((s) => s.award_ids.includes(award.award_id)).length,
        captured_sources: html.filter((s) => attempts.get(s.id).filter((a) => a.status === "captured").length === 2).length,
        comparable_sources: html.filter((s) => comparisons.some((c) => c.source_id === s.id && ["changed", "unchanged"].includes(c.status))).length,
      };
    }),
    sources: selected.htmlSources.map((source) => ({ source_id: source.id, award_ids: source.award_ids, rounds: attempts.get(source.id), comparison: comparisons.find((c) => c.source_id === source.id) })),
    pdf_sources: selected.pdfSources,
  };
  writeNewJson(join(outputDir, "report.json"), report);
  return report;
}
