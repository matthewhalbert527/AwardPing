import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readCapture } from "./capture-scrapling-pilot.mjs";
import { validatePilotRoster } from "./lib/rendered-html-pilot.mjs";
import { normalizePublicHttpUrl } from "./lib/public-network-safety.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const hash = (value) => createHash("sha256").update(value).digest("hex");
const fail = (reason) => { throw new Error(reason); };
const text = (value, max = 250000) => typeof value === "string" && value.length <= max;
const strings = (value, max = 1000) => Array.isArray(value) && value.length <= max && value.every((v) => text(v));
const headings = (value) => Array.isArray(value) && value.length <= 100 && value.every((v) =>
  Number.isInteger(v?.level) && v.level >= 1 && v.level <= 6 && text(v.text) && v.text.trim());
const semantic = (doc) => Object.fromEntries(["title", "text", "blocks", "links", "base_hrefs"].map((key) => [key, doc[key]]));
const writeNew = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });

/** Source HTML includes closed sections. It is not proof that every statement is current or visible. */
export function validateHtmlDocument(doc, { sourceUrl }) {
  try {
    const url = normalizePublicHttpUrl(sourceUrl);
    if (url.port || url.href !== sourceUrl) fail("invalid_html_source");
  } catch { fail("invalid_html_source"); }
  if (doc?.schema !== "awardping.scrapling-html-document.v1" || doc.scope !== "html-source-main-document" ||
      doc.source_url !== sourceUrl || !text(sourceUrl, 10000) ||
      doc.publishable !== false || doc.visibility_verified !== false || !text(doc.title, 10000) ||
      !text(doc.text) || !doc.text.trim() || !strings(doc.base_hrefs, 100) || !strings(doc.limitations) ||
      !Array.isArray(doc.blocks) || !doc.blocks.length || doc.blocks.length > 10000 ||
      !Array.isArray(doc.links) || doc.links.length > 10000) fail("invalid_html_document");
  for (const block of doc.blocks) {
    if (!text(block?.kind, 40) || !block.kind || !text(block.text) || !block.text.trim() ||
        !headings(block.heading_path) || !strings(block.list_path) || !strings(block.table_row)) fail("invalid_html_block");
    if (Object.hasOwn(block, "details_path") && (!strings(block.details_path, 100) || !block.details_path.length)) fail("invalid_html_block");
    if (Object.hasOwn(block, "table_cell") && (!block.table_cell || typeof block.table_cell !== "object" ||
        Array.isArray(block.table_cell) || !Object.values(block.table_cell).every((v) => text(v, 10000) ||
          (Number.isInteger(v) && v >= 0 && v <= 65534)))) fail("invalid_html_table_cell");
  }
  for (const link of doc.links) {
    if (!text(link?.text) || !text(link.raw_href, 10000) || link.source_url !== sourceUrl ||
        !strings(link.base_hrefs, 100) || JSON.stringify(link.base_hrefs) !== JSON.stringify(doc.base_hrefs) ||
        !headings(link.heading_path) || !strings(link.list_path)) fail("invalid_html_link");
    if (Object.hasOwn(link, "details_path") && (!strings(link.details_path, 100) || !link.details_path.length)) fail("invalid_html_link");
  }
  if (Buffer.byteLength(JSON.stringify(doc), "utf8") > 5 * 1024 * 1024) fail("html_document_too_large");
  return doc;
}

export function compareHtmlDocuments(previous, current) {
  const base = { publishable: false, scope: "html_source_main_document", accuracy_benchmark: false };
  try {
    validateHtmlDocument(previous, { sourceUrl: previous?.source_url });
    validateHtmlDocument(current, { sourceUrl: current?.source_url });
    if (previous.source_url !== current.source_url) fail("source_mismatch");
    const fields = Object.keys(semantic(previous)).filter((key) => JSON.stringify(previous[key]) !== JSON.stringify(current[key]));
    return { ...base, status: fields.length ? "changed_needs_review" : "unchanged", fields };
  } catch (error) {
    return { ...base, status: "unavailable", reason: /^[a-z_]+$/.test(error?.message || "") ? error.message : "invalid_html_document" };
  }
}

function readBounded(path, max = 2 * 1024 * 1024) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > max) fail("invalid_input_file");
  const bytes = readFileSync(path);
  if (bytes.length > max) fail("input_file_too_large");
  return bytes;
}

function readJson(path) { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(readBounded(path))); }

function parseHtml(record, pythonPath) {
  return new Promise((resolveResult, reject) => {
    const env = Object.fromEntries(["SystemRoot", "WINDIR", "TEMP", "TMP", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "PATH", "COMSPEC", "PATHEXT"]
      .filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]));
    env.PYTHONUTF8 = "1";
    const child = spawn(pythonPath, ["-B", join(root, "scripts/scrapling/html_document.py")], {
      shell: false, windowsHide: true, env, stdio: ["pipe", "pipe", "pipe"],
    });
    const chunks = [];
    let bytes = 0;
    let failure;
    let killed;
    const stop = (reason) => {
      failure ||= reason;
      if (killed || !child.pid) return;
      killed = process.platform === "win32" ? new Promise((done) => {
        const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
        killer.once("error", () => { child.kill(); done(); });
        killer.once("close", done);
      }) : Promise.resolve(child.kill("SIGKILL"));
    };
    const timer = setTimeout(() => stop("html_parser_timeout"), 15000);
    child.stdout.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > 8 * 1024 * 1024) stop("html_parser_output_limit");
      else if (!failure) chunks.push(chunk);
    });
    child.stderr.on("data", () => {});
    child.stdin.on("error", () => {});
    child.once("error", () => { clearTimeout(timer); reject(new Error("html_parser_start_failed")); });
    child.once("close", async (code) => {
      clearTimeout(timer);
      await killed;
      try {
        if (failure) fail(failure);
        const result = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
        if (code !== 0 || result.error) fail(/^[a-z_]+$/.test(result.error || "") ? result.error : "html_parser_failed");
        resolveResult(validateHtmlDocument(result, { sourceUrl: record.final_url }));
      } catch (error) { reject(error); }
    });
    child.stdin.end(JSON.stringify({ html: record.html, url: record.final_url }));
  });
}

/** Offline only: existing captures remain unchanged, with derived evidence in a new child directory. */
export async function analyzeScraplingHtml(runDir, { pythonPath = join(root, "tmp/scrapling-runtime/Scripts/python.exe") } = {}) {
  runDir = resolve(runDir);
  const allowed = join(root, "tmp/scrapling-pilot-20261015/runs");
  if (dirname(runDir) !== allowed) fail("invalid_run_directory");
  for (const part of [root, join(root, "tmp"), join(root, "tmp/scrapling-pilot-20261015"), allowed, runDir, join(runDir, "captures")]) {
    if (lstatSync(part).isSymbolicLink() || realpathSync(part) !== resolve(part)) fail("linked_run_directory");
  }
  const report = readJson(join(runDir, "report.json"));
  const roster = readJson(join(runDir, "roster.json"));
  const registry = readBounded(join(root, "src/lib/stage1-cohort-identity.ts")).toString("utf8");
  const expectedAwardIds = [...registry.matchAll(/^\s*\[\d+,\s*"[^"\r\n]+",\s*"[^"\r\n]+",\s*"([a-f0-9-]+)"/gm)].map((m) => m[1]);
  const selected = validatePilotRoster(roster, { expectedAwardIds });
  if (report.schema !== "awardping.scrapling-pilot.v1" || report.publishable !== false || report.activation_ready !== false ||
      JSON.stringify(report.sources.map((s) => s.source_id)) !== JSON.stringify(selected.htmlSources.map((s) => s.id))) fail("invalid_capture_report");
  for (const [index, source] of report.sources.entries()) {
    const expected = selected.htmlSources[index];
    if (source.url !== expected.url || JSON.stringify(source.award_ids) !== JSON.stringify(expected.award_ids) ||
        !Array.isArray(source.rounds) || JSON.stringify(source.rounds.map((r) => r.round)) !== "[1,2]" ||
        source.rounds.some((r) => r.source_id !== source.source_id || !["captured", "failed"].includes(r.status))) fail("invalid_source_report");
    for (const attempt of source.rounds) {
      if (attempt.status === "captured" && (attempt.file !== `captures/${source.source_id}-round-${attempt.round}.json` ||
          !/^[a-f0-9]{64}$/.test(attempt.sha256))) fail("capture_path_identity_mismatch");
    }
  }
  const inputs = ["report.json", "roster.json", "implementation.json"].map((file) => ({ file, sha256: hash(readBounded(join(runDir, file))) }));
  const codePaths = ["scripts/analyze-scrapling-html.mjs", "scripts/scrapling/html_document.py", "scripts/scrapling/requirements.txt"];
  const code = Object.fromEntries(codePaths.map((file) => [file, hash(readBounded(join(root, file)))]));
  const outputDir = join(runDir, `html-analysis-${new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-")}`);
  if (existsSync(outputDir)) fail("analysis_already_exists");
  mkdirSync(outputDir);
  mkdirSync(join(outputDir, "documents"));
  const startedAt = new Date().toISOString();
  const results = new Array(report.sources.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: 2 }, async () => {
    while (cursor < report.sources.length) {
      const index = cursor++;
      const source = report.sources[index];
      const rounds = [];
      const documents = [];
      const captures = [];
      for (const attempt of source.rounds) {
        if (attempt.status !== "captured") {
          rounds.push({ round: attempt.round, status: "unavailable", reason: attempt.reason || "capture_unavailable" });
          continue;
        }
        const file = `captures/${source.source_id}-round-${attempt.round}.json`;
        try {
          const record = readCapture(join(runDir, file), attempt.sha256);
          if (record.source_id !== source.source_id || record.url !== source.url) fail("capture_identity_mismatch");
          const document = await parseHtml(record, pythonPath);
          const derivedFile = `documents/${source.source_id}-round-${attempt.round}.json`;
          const derived = { schema: "awardping.scrapling-html-evidence.v1", publishable: false,
            source_id: source.source_id, capture_file: file, capture_sha256: attempt.sha256,
            html_sha256: record.integrity.html_sha256, captured_at: record.captured_at,
            document_sha256: hash(JSON.stringify(semantic(document))), document };
          writeNew(join(outputDir, derivedFile), derived);
          rounds.push({ round: attempt.round, status: "parsed", file: derivedFile,
            sha256: hash(readBounded(join(outputDir, derivedFile), 8 * 1024 * 1024)),
            capture_file: file, capture_sha256: attempt.sha256, html_sha256: record.integrity.html_sha256 });
          documents.push(document);
          captures.push(record);
        } catch (error) {
          rounds.push({ round: attempt.round, status: "unavailable", reason: /^[a-z_]+$/.test(error?.message || "") ? error.message : "html_analysis_failed" });
        }
      }
      const comparable = documents.length === 2 && captures[0].final_url === captures[1].final_url && Date.parse(captures[0].captured_at) < Date.parse(captures[1].captured_at);
      const comparison = comparable ? compareHtmlDocuments(...documents) : { status: "unavailable", publishable: false, reason: "incomplete_or_incompatible_pair" };
      results[index] = { source_id: source.source_id, url: source.url, award_ids: source.award_ids, rounds, comparison };
    }
  }));
  const codeUnchanged = codePaths.every((file) => hash(readBounded(join(root, file))) === code[file]);
  const inputsUnchanged = inputs.every((item) => hash(readBounded(join(runDir, item.file))) === item.sha256) && results.every((source) => source.rounds.every((item) =>
    item.status !== "parsed" || hash(readBounded(join(runDir, item.capture_file), 24 * 1024 * 1024)) === item.capture_sha256));
  if (!codeUnchanged || !inputsUnchanged) fail("analysis_inputs_changed");
  const summary = { awards: selected.awards.length, html_sources: results.length,
    parsed_captures: results.reduce((n, s) => n + s.rounds.filter((r) => r.status === "parsed").length, 0),
    comparable: results.filter((s) => s.comparison.status !== "unavailable").length,
    unchanged: results.filter((s) => s.comparison.status === "unchanged").length,
    changed_needs_review: results.filter((s) => s.comparison.status === "changed_needs_review").length,
    unavailable: results.filter((s) => s.comparison.status === "unavailable").length };
  const awards = selected.awards.map((award) => ({ award_id: award.award_id, name: award.name,
    comparable_sources: results.filter((s) => s.award_ids.includes(award.award_id) && s.comparison.status !== "unavailable").length }));
  const result = { schema: "awardping.scrapling-html-analysis.v1", publishable: false, activation_ready: false,
    started_at: startedAt, finished_at: new Date().toISOString(), summary, awards, sources: results,
    code, inputs, inputs_unchanged: inputsUnchanged, code_unchanged: codeUnchanged,
    limitations: ["Source HTML includes hidden and closed content; inclusion does not prove that a statement is current or visible.",
      "Each HTML snapshot is an adjacent retained DOM observation; browser readiness certifies visible-content stability, not hidden-content stability.",
      "No JavaScript execution, requests, accordion clicks, AI summaries, baseline changes or publication occur during this analysis.",
      "Two same-day comparisons are not a labelled accuracy benchmark. Differences need relevance and context review.",
      "PDFs, iframe/shadow contents and content absent from the retained main-document HTML remain outside scope."] };
  writeNew(join(outputDir, "report.json"), result);
  return { outputDir, result };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 3) fail("usage_analyze_scrapling_html_run_directory");
    const { outputDir, result } = await analyzeScraplingHtml(process.argv[2]);
    console.log(JSON.stringify({ event: "html_analysis_complete", output_dir: outputDir, summary: result.summary }));
    process.exitCode = result.summary.unavailable ? 2 : 0;
  } catch (error) {
    console.error(JSON.stringify({ event: "html_analysis_failed", reason: /^[a-z_]+$/.test(error?.message || "") ? error.message : "analysis_failed" }));
    process.exitCode = 1;
  }
}
