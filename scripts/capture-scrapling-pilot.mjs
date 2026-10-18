import { createHash } from "node:crypto";
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { validatePilotRoster } from "./lib/rendered-html-pilot.mjs";
import { captureScraplingSource, compareScraplingCaptures, validateScraplingCapture } from "./lib/scrapling-capture.mjs";
import { extractStructuredHtml } from "./lib/structured-html-content.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const writeNew = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
const root = dirname(dirname(fileURLToPath(import.meta.url)));

export function readCapture(path, expectedHash) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 24 * 1024 * 1024) throw new Error("invalid_capture_file");
  const bytes = readFileSync(path);
  if (bytes.length > 24 * 1024 * 1024 || hash(bytes) !== expectedHash) throw new Error("capture_file_changed");
  const record = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  return validateScraplingCapture(record, { source: { id: record.source_id, url: record.url } });
}

// Same retained DOM through the prior parser: useful agreement diagnostic, not a full old-worker run.
export function legacyParserAgreement(record) {
  const parsed = extractStructuredHtml(record.html, { sourceUrl: record.final_url });
  if (parsed.status !== "ok") return { status: "unavailable", reason: parsed.reason };
  const visible = record.text.replace(/\s+/gu, " ").trim();
  let offset = 0;
  for (const block of parsed.blocks) {
    const text = block.text.replace(/\s+/gu, " ").trim();
    const next = visible.indexOf(text, offset);
    if (next < 0) return { status: "unavailable", reason: "visible_text_not_corroborated" };
    offset = next + text.length;
  }
  return { status: "corroborated", blocks: parsed.blocks.length };
}

export async function runScraplingPilot({ roster, expectedAwardIds, outputDir, allowedOutputRoot, captureImpl, concurrency = 2, onProgress = () => {} }) {
  const selected = validatePilotRoster(roster, { expectedAwardIds });
  if (![1, 2].includes(concurrency) || typeof captureImpl !== "function") throw new Error("invalid_run_options");
  const parent = realpathSync(allowedOutputRoot);
  if (lstatSync(allowedOutputRoot).isSymbolicLink() || resolve(allowedOutputRoot) !== parent ||
      dirname(resolve(outputDir)) !== parent || existsSync(outputDir)) throw new Error("unsafe_output_directory");
  mkdirSync(outputDir);
  const captureDir = join(outputDir, "captures");
  mkdirSync(captureDir);
  writeNew(join(outputDir, "roster.json"), roster);
  writeFileSync(join(outputDir, "progress.jsonl"), "", { flag: "wx" });
  const startedAt = new Date().toISOString();
  const attempts = [];
  for (const round of [1, 2]) {
    let cursor = 0;
    await Promise.all(Array.from({ length: concurrency }, async () => {
      while (cursor < selected.htmlSources.length) {
        const source = selected.htmlSources[cursor++];
        const attempt = { source_id: source.id, round, started_at: new Date().toISOString(), status: "failed" };
        try {
          const record = validateScraplingCapture(await captureImpl(source, { round }), { source });
          const file = `captures/${source.id}-round-${round}.json`;
          writeNew(join(outputDir, file), record);
          Object.assign(attempt, { status: "captured", file, sha256: hash(readFileSync(join(outputDir, file))),
            captured_at: record.captured_at, final_url: record.final_url,
            text_characters: record.text.length, blocks: record.document.blocks.length, links: record.document.links.length,
            limitations: [...new Set([...record.document.limitations, ...record.warnings])],
            legacy_parser_agreement: legacyParserAgreement(record) });
        } catch (error) {
          attempt.reason = /^[a-z][a-z0-9_]{0,100}$/.test(error?.pilotReason || "") ? error.pilotReason : "capture_failed";
        }
        attempt.finished_at = new Date().toISOString();
        attempts.push(attempt);
        appendFileSync(join(outputDir, "progress.jsonl"), `${JSON.stringify(attempt)}\n`);
        onProgress(attempt);
      }
    }));
  }
  const sources = selected.htmlSources.map((source) => {
    const rounds = attempts.filter((a) => a.source_id === source.id).sort((a, b) => a.round - b.round);
    let comparison;
    try {
      comparison = rounds.length === 2 && rounds.every((a) => a.status === "captured") ? compareScraplingCaptures(
        readCapture(join(outputDir, rounds[0].file), rounds[0].sha256),
        readCapture(join(outputDir, rounds[1].file), rounds[1].sha256),
      ) : { status: "unavailable", reason: "incomplete_capture_pair", publishable: false };
    } catch { comparison = { status: "unavailable", reason: "retained_evidence_invalid", publishable: false }; }
    return { source_id: source.id, url: source.url, award_ids: source.award_ids, rounds, comparison };
  });
  const summary = {
    awards: selected.awards.length, html_sources: selected.htmlSources.length, unique_html_urls: new Set(selected.htmlSources.map((s) => s.url)).size,
    pdf_sources_inventoried: selected.pdfSources.length, attempts: attempts.length,
    captured: attempts.filter((a) => a.status === "captured").length, failed: attempts.filter((a) => a.status === "failed").length,
    comparable: sources.filter((s) => s.comparison.status !== "unavailable").length,
    unchanged: sources.filter((s) => s.comparison.status === "unchanged").length,
    changed_needs_review: sources.filter((s) => s.comparison.status === "changed_needs_review").length,
    unavailable: sources.filter((s) => s.comparison.status === "unavailable").length,
    legacy_parser_corroborated_captures: attempts.filter((a) => a.legacy_parser_agreement?.status === "corroborated").length,
  };
  const awards = selected.awards.map((award) => {
    const awardSources = sources.filter((s) => s.award_ids.includes(award.award_id));
    return { award_id: award.award_id, name: award.name, publication_status: award.publication_status,
      html_sources: awardSources.length, captured_pairs: awardSources.filter((s) => s.rounds.length === 2 && s.rounds.every((a) => a.status === "captured")).length,
      comparable_sources: awardSources.filter((s) => s.comparison.status !== "unavailable").length,
      changed_candidates: awardSources.filter((s) => s.comparison.status === "changed_needs_review").length };
  });
  const report = { schema: "awardping.scrapling-pilot.v1", publishable: false, activation_ready: false,
    started_at: startedAt, finished_at: new Date().toISOString(), summary, awards, sources, pdf_sources: selected.pdfSources,
    limitations: ["Two prospective rounds measure repeatability, not recall of real future changes.",
      "Unchanged means observed main-document content only; closed sections, embedded frames, shadow content and PDFs are not asserted covered.",
      "Differences require review; this does not produce or publish AI summaries.",
      "Legacy parser agreement uses the same retained HTML, not a concurrent run of the production worker."] };
  writeNew(join(outputDir, "report.json"), report);
  const lines = ["# Scrapling all-25 pilot", "", "Capture-only. No production changes or publication.", "", ...Object.entries(summary).map(([key, value]) => `- ${key}: ${value}`), "",
    "| Award | HTML sources | Complete pairs | Comparable | Review candidates |", "| --- | ---: | ---: | ---: | ---: |",
    ...awards.map((a) => `| ${a.name.replaceAll("|", "\\|")} | ${a.html_sources} | ${a.captured_pairs} | ${a.comparable_sources} | ${a.changed_candidates} |`),
    "", "## Limits", "", ...report.limitations.map((s) => `- ${s}`), ""];
  writeFileSync(join(outputDir, "summary.md"), lines.join("\n"), { flag: "wx" });
  return report;
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.length === 1 && argv[0] === "--help") {
    console.log("Capture-only Scrapling replacement test across all25 awards; two rounds; no publishing.\nnode scripts/capture-scrapling-pilot.mjs --roster=<JSON> [--python=<executable>] [--browser=<Chrome executable>] [--concurrency=1|2]");
    return 0;
  }
  try {
    const args = {};
    for (const item of argv) {
      const match = /^--(roster|python|browser|concurrency)=(.+)$/.exec(item);
      if (!match || Object.hasOwn(args, match[1])) throw new Error("invalid_arguments");
      args[match[1]] = match[2];
    }
    if (!args.roster) throw new Error("roster_required");
    const rosterStat = lstatSync(args.roster);
    if (!rosterStat.isFile() || rosterStat.isSymbolicLink() || rosterStat.size > 1024 * 1024) throw new Error("invalid_roster_file");
    const rosterBytes = readFileSync(args.roster);
    if (rosterBytes.length > 1024 * 1024) throw new Error("roster_too_large");
    const roster = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(rosterBytes));
    const registry = readFileSync(join(root, "src/lib/stage1-cohort-identity.ts"), "utf8");
    const expectedAwardIds = [...registry.matchAll(/^\s*\[\d+,\s*"[^"\r\n]+",\s*"[^"\r\n]+",\s*"([a-f0-9-]+)"/gm)].map((m) => m[1]);
    validatePilotRoster(roster, { expectedAwardIds });
    if (args.concurrency !== undefined && !["1", "2"].includes(args.concurrency)) throw new Error("invalid_concurrency");
    const pythonPath = resolve(args.python || join(root, "tmp/scrapling-runtime", process.platform === "win32" ? "Scripts/python.exe" : "bin/python"));
    const executablePath = args.browser || ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"].find(existsSync);
    if (!existsSync(pythonPath) || !executablePath || !existsSync(executablePath)) throw new Error("runtime_not_installed");
    let parent = root;
    for (const part of ["tmp", "scrapling-pilot-20261015", "runs"]) {
      parent = join(parent, part);
      if (!existsSync(parent)) mkdirSync(parent);
      if (lstatSync(parent).isSymbolicLink() || realpathSync(parent) !== resolve(parent)) throw new Error("unsafe_output_root");
    }
    const codePaths = ["scripts/capture-scrapling-pilot.mjs", "scripts/lib/scrapling-capture.mjs", "scripts/scrapling/collector.py", "scripts/scrapling/visible-document.js", "scripts/scrapling/requirements.txt", "scripts/lib/public-network-safety.mjs", "scripts/lib/capture-resource-limits.mjs", "scripts/lib/rendered-html-pilot.mjs", "scripts/lib/structured-html-content.mjs"];
    const code = Object.fromEntries(codePaths.map((p) => [p, hash(readFileSync(join(root, p)))]));
    const outputDir = join(parent, `run-${new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-")}`);
    console.log(JSON.stringify({ event: "scrapling_pilot_start", output_dir: outputDir, awards: 25 }));
    const report = await runScraplingPilot({ roster, expectedAwardIds, outputDir, allowedOutputRoot: parent,
      concurrency: Number(args.concurrency || "2"), captureImpl: (source) => captureScraplingSource(source, { pythonPath, executablePath }),
      onProgress: (a) => console.log(JSON.stringify({ event: "capture", source_id: a.source_id, round: a.round, status: a.status, reason: a.reason })) });
    const codeUnchanged = codePaths.every((p) => hash(readFileSync(join(root, p))) === code[p]);
    writeNew(join(outputDir, "implementation.json"), { code, code_unchanged_during_run: codeUnchanged, registry_sha256: hash(registry), roster_sha256: hash(rosterBytes), python_path: pythonPath, browser_path: executablePath });
    console.log(JSON.stringify({ event: "scrapling_pilot_complete", output_dir: outputDir, summary: report.summary, code_unchanged_during_run: codeUnchanged }));
    return !codeUnchanged || report.summary.failed || report.summary.unavailable ? 2 : 0;
  } catch (error) {
    console.error(JSON.stringify({ event: "scrapling_pilot_failed", reason: /^[a-z_]+$/.test(error?.message || "") ? error.message : "configuration_or_execution_failed" }));
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = await main();
