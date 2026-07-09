#!/usr/bin/env node
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createSupabaseServiceClient } from "./supabase-service-client.mjs";

const root = resolve(import.meta.dirname, "..");
const args = parseArgs(process.argv.slice(2));
const bundleStamp = new Date().toISOString().replace(/[:.]/g, "-");
const bundleName = cleanPathSegment(args.name || `awardping-full-review-${bundleStamp}`);
const outputRoot = resolve(root, String(args.output || "review-bundles"));
const bundleDir = resolve(outputRoot, bundleName);
const zipPath = `${bundleDir}.zip`;
const envPath = resolve(root, String(args.env || ".env.local"));
const env = { ...loadEnvFile(envPath), ...process.env };
const supabaseUrl = env.NEXT_PUBLIC_SUPABASE_URL || env.SUPABASE_URL;
const supabaseKey = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_KEY;
const supabase = supabaseUrl && supabaseKey ? createSupabaseServiceClient(supabaseUrl, supabaseKey) : null;
const maxRows = nonNegativeInt(args["max-rows"], 5000);
const recentRows = nonNegativeInt(args["recent-rows"], 1000);
const reportLimit = nonNegativeInt(args["report-limit"], 120);
const createdAt = new Date().toISOString();
const manifest = {
  bundle_name: bundleName,
  created_at: createdAt,
  root,
  included: {},
  warnings: [],
  database_exports: [],
  secret_scan: null,
};

if (existsSync(bundleDir)) rmSync(bundleDir, { recursive: true, force: true });
if (existsSync(zipPath)) rmSync(zipPath, { force: true });
mkdirSync(bundleDir, { recursive: true });

copyCodebase();
copyProjectContext();
copySupabaseSchema();
copyRecentReports();
await exportDatabase();
writeReviewGuide();
writeManifest();
runSecretScan();
writeManifest();
createZip();
writeManifest();

console.log(
  JSON.stringify(
    {
      bundle_dir: bundleDir,
      zip_path: zipPath,
      database_exports: manifest.database_exports.length,
      warnings: manifest.warnings,
      secret_scan: manifest.secret_scan,
    },
    null,
    2,
  ),
);

function copyCodebase() {
  const codeRoot = join(bundleDir, "CODEBASE");
  mkdirSync(codeRoot, { recursive: true });
  const includeDirs = ["src", "scripts", "installer", "public", "supabase"];
  for (const dir of includeDirs) {
    const source = join(root, dir);
    if (!existsSync(source)) continue;
    copyDirectoryFiltered(source, join(codeRoot, dir));
  }
  const rootFiles = [
    "package.json",
    "package-lock.json",
    "tsconfig.json",
    "next.config.ts",
    "eslint.config.mjs",
    "postcss.config.mjs",
    "vitest.config.ts",
    "vercel.json",
    ".gitignore",
    ".vercelignore",
    "AGENTS.md",
    "README.md",
    "RUNBOOK.md",
    "PROGRAM_CONTEXT.md",
    "PROJECT_HANDOFF.md",
    "START_HERE.md",
    "CURRENT_STATE.md",
    "CHANGELOG.md",
    "design-qa.md",
  ];
  for (const file of rootFiles) copyFileIfExists(join(root, file), join(codeRoot, file));
  manifest.included.codebase = {
    path: relative(root, codeRoot),
    include_dirs: includeDirs,
    note: "Excluded env files, node_modules, .git, .next, logs, reports, bulk snapshots, and generated caches.",
  };
}

function copyProjectContext() {
  copyDirectoryIfExists(join(root, "config"), join(bundleDir, "POLICY"));
  copyDirectoryIfExists(join(root, "docs"), join(bundleDir, "DOCS"));
  copyFileIfExists(join(root, "DECISIONS_AND_PREFERENCES.md"), join(bundleDir, "DECISIONS_AND_PREFERENCES.md"));
  copyFileIfExists(join(root, "CURRENT_STATE.md"), join(bundleDir, "CURRENT_STATE.md"));
  copyFileIfExists(join(root, "RUNBOOK.md"), join(bundleDir, "RUNBOOK.md"));
  copyFileIfExists(join(root, "PROGRAM_CONTEXT.md"), join(bundleDir, "PROGRAM_CONTEXT.md"));
  copyFileIfExists(join(root, "PROJECT_HANDOFF.md"), join(bundleDir, "PROJECT_HANDOFF.md"));
  manifest.included.project_context = {
    policy: "POLICY",
    docs: "DOCS",
    decision_memory: "POLICY/award-decision-memory.json",
  };
}

function copySupabaseSchema() {
  const schemaDir = join(bundleDir, "DATABASE", "schema");
  mkdirSync(schemaDir, { recursive: true });
  const migrationsDir = join(root, "supabase", "migrations");
  if (existsSync(migrationsDir)) {
    copyDirectoryFiltered(migrationsDir, join(schemaDir, "migrations"));
  }
  const combined = [];
  const files = existsSync(migrationsDir)
    ? readdirSync(migrationsDir)
        .filter((file) => file.endsWith(".sql"))
        .sort()
    : [];
  for (const file of files) {
    combined.push(`-- ${file}\n${readFileSync(join(migrationsDir, file), "utf8").trim()}\n`);
  }
  writeFileSync(join(schemaDir, "schema-from-migrations.sql"), combined.join("\n\n"), "utf8");
  manifest.included.schema = {
    migrations: files.length,
    combined_schema: "DATABASE/schema/schema-from-migrations.sql",
  };
}

function copyRecentReports() {
  const reportsRoot = join(root, "reports");
  const targetRoot = join(bundleDir, "WORKER_REPORTS");
  mkdirSync(targetRoot, { recursive: true });
  if (!existsSync(reportsRoot)) {
    manifest.warnings.push("No reports directory found.");
    return;
  }
  const files = walkFiles(reportsRoot)
    .filter((file) => [".json", ".jsonl", ".md", ".txt", ".csv"].includes(extname(file).toLowerCase()))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
    .slice(0, reportLimit);
  for (const file of files) {
    const rel = relative(reportsRoot, file);
    const target = join(targetRoot, rel);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, redactSecretLikeText(readFileSync(file, "utf8")), "utf8");
  }
  manifest.included.worker_reports = {
    copied_files: files.length,
    report_limit: reportLimit,
    path: "WORKER_REPORTS",
  };
}

async function exportDatabase() {
  const databaseRoot = join(bundleDir, "DATABASE");
  mkdirSync(databaseRoot, { recursive: true });
  if (!supabase) {
    manifest.warnings.push("Supabase credentials were not available; skipped live database exports.");
    return;
  }

  const tables = [
    {
      table: "shared_awards",
      select:
        "id,search_key,name,slug,official_homepage,summary,public_facts,public_facts_generated_at,public_facts_model,confidence,status,source,created_at,updated_at,last_structure_scan_at,next_structure_scan_at,structure_scan_error",
      order: { column: "updated_at", ascending: false },
      limit: maxRows,
      sanitize: sanitizeSharedAward,
    },
    {
      table: "shared_award_sources",
      select:
        "id,shared_award_id,url,title,display_title,page_description,page_type,confidence,reason,source,created_at,updated_at,last_checked_at,next_check_at,consecutive_failures,last_error,page_metadata,page_metadata_generated_at,page_metadata_model,admin_review_status,admin_review_note,admin_reviewed_at",
      order: { column: "updated_at", ascending: false },
      limit: maxRows,
      sanitize: sanitizeSharedAwardSource,
    },
    {
      table: "shared_award_change_events",
      select:
        "id,shared_award_id,shared_award_source_id,source_url,source_title,source_page_type,previous_snapshot_id,new_snapshot_id,summary,change_details,detected_at",
      order: { column: "detected_at", ascending: false },
      limit: recentRows,
      sanitize: sanitizeChangeEvent,
    },
    {
      table: "shared_award_source_visual_snapshots",
      select:
        "shared_award_source_id,shared_award_id,source_url,source_title,source_page_type,kind,bucket,latest_captured_at,latest_object_keys,latest_hashes,latest_metadata,previous_captured_at,previous_object_keys,previous_hashes,previous_metadata,created_at,updated_at",
      order: { column: "updated_at", ascending: false },
      limit: maxRows,
      sanitize: sanitizeVisualSnapshot,
    },
    {
      table: "shared_award_source_snapshots",
      select:
        "id,shared_award_id,shared_award_source_id,source_url,source_title,source_page_type,hash,text_sample,byte_length,status_code,content_type,created_at",
      order: { column: "created_at", ascending: false },
      limit: recentRows,
      sanitize: sanitizeTextSnapshot,
    },
    {
      table: "shared_award_slug_aliases",
      select: "id,shared_award_id,slug,created_at",
      order: { column: "created_at", ascending: false },
      limit: maxRows,
      sanitize: (row) => row,
    },
    {
      table: "local_worker_runs",
      select:
        "id,worker_name,status,ai_provider,checked_count,changed_count,unchanged_count,initial_count,discovered_count,failed_count,error,metadata,started_at,finished_at",
      order: { column: "started_at", ascending: false },
      limit: maxRows,
      sanitize: sanitizeWorkerRun,
    },
  ];

  const summary = [];
  for (const config of tables) {
    const rows = await selectTableRows(config);
    const sanitized = rows.map((row) => sanitizeRecord(config.sanitize(row)));
    const csvPath = join(databaseRoot, `${config.table}.csv`);
    const jsonPath = join(databaseRoot, `${config.table}.json`);
    writeFileSync(csvPath, toCsv(sanitized), "utf8");
    writeFileSync(jsonPath, JSON.stringify(sanitized, null, 2), "utf8");
    const entry = {
      table: config.table,
      rows: sanitized.length,
      limit: config.limit,
      csv: `DATABASE/${config.table}.csv`,
      json: `DATABASE/${config.table}.json`,
    };
    manifest.database_exports.push(entry);
    summary.push(entry);
  }
  writeFileSync(join(databaseRoot, "export-summary.json"), JSON.stringify(summary, null, 2), "utf8");
}

async function selectTableRows(config) {
  const rows = [];
  const pageSize = Math.min(1000, Math.max(1, config.limit));
  for (let from = 0; from < config.limit; from += pageSize) {
    let query = supabase
      .from(config.table)
      .select(config.select)
      .range(from, Math.min(config.limit - 1, from + pageSize - 1));
    if (config.order) {
      query = query.order(config.order.column, { ascending: config.order.ascending });
    }
    const { data, error } = await query;
    if (error) {
      manifest.warnings.push(`Database export failed for ${config.table}: ${error.message}`);
      break;
    }
    rows.push(...(Array.isArray(data) ? data : []));
    if (!data || data.length < pageSize) break;
  }
  return rows;
}

function writeReviewGuide() {
  const guide = `# AwardPing GPT Pro Review Guide

Created: ${createdAt}

This is a sanitized review bundle for AwardPing. Start here, then inspect the files in the order below.

## What To Review First

1. \`CURRENT_STATE.md\`, \`PROGRAM_CONTEXT.md\`, \`RUNBOOK.md\`, and \`PROJECT_HANDOFF.md\`.
2. \`POLICY/award-monitoring-policy.json\` and \`POLICY/award-decision-memory.json\`.
3. \`CODEBASE/scripts/capture-visual-snapshots.mjs\`, \`CODEBASE/scripts/backfill-baseline-facts.mjs\`, \`CODEBASE/scripts/run-localization-repair.mjs\`, and \`CODEBASE/scripts/run-overnight-source-quality-pass.mjs\`.
4. \`CODEBASE/src/lib/public-award-pages.ts\`, \`CODEBASE/src/lib/change-details-ai.ts\`, and the public award page components under \`CODEBASE/src/app\`.
5. \`DATABASE/export-summary.json\`, then the CSV/JSON exports in \`DATABASE/\`.
6. Recent worker summaries in \`WORKER_REPORTS/\`.

## Review Goals

- Find places where user corrections are not applied globally through decision memory or policy prompts.
- Audit whether Gemini prompt scopes receive the right source-quality, baseline, localization, and update-filtering rules.
- Check whether irrelevant pages/PDFs can still remain attached to awards.
- Check whether separate awards can still be accidentally combined into one award.
- Check whether update cards can show wrong screenshot crops or wrong localization.
- Check whether duplicate or expansion/lazy-load/page-reflow changes can still become public updates.
- Check whether source titles, award conditions, important dates, and bullet-list fields are consistently produced.
- Review Supabase data shape and retention for large snapshot/screenshot storage.

## Safety Notes

- This bundle intentionally excludes live secrets, env files, Supabase service keys, R2 credentials, \`.git\`, \`.next\`, \`node_modules\`, logs, bulk screenshots, and private subscriber/profile tables.
- Database exports are selected shared/public award-monitoring tables plus local worker runs. Private account/profile/subscriber data is excluded.
- Screenshot files are not included in bulk. Use \`shared_award_source_visual_snapshots\` object-key manifests to reason about screenshot coverage and retention.

## Key Files Added Recently

- \`POLICY/award-decision-memory.json\`: durable user decision memory for Gemini and source-quality interpretation.
- \`CODEBASE/scripts/lib/award-monitoring-policy.mjs\`: Node policy loader used by workers.
- \`CODEBASE/src/lib/award-monitoring-policy.ts\`: app-side policy loader.

`;
  writeFileSync(join(bundleDir, "REVIEW_GUIDE.md"), guide, "utf8");
}

function writeManifest() {
  writeFileSync(join(bundleDir, "BUNDLE_MANIFEST.json"), JSON.stringify(manifest, null, 2), "utf8");
}

function runSecretScan() {
  const findings = [];
  const files = walkFiles(bundleDir)
    .filter((file) => !file.endsWith(".zip"))
    .filter((file) => statSync(file).size <= 2_000_000);
  const patterns = [
    { id: "supabase_service_key", re: /\beyJ[A-Za-z0-9_-]{80,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/g },
    { id: "openai_key", re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g },
    { id: "gemini_key", re: /\bAIza[A-Za-z0-9_-]{30,}\b/g },
    { id: "aws_access_key", re: /\bAKIA[0-9A-Z]{16}\b/g },
    { id: "private_key_block", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  ];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const pattern of patterns) {
      pattern.re.lastIndex = 0;
      if (pattern.re.test(text)) {
        findings.push({
          file: relative(bundleDir, file),
          pattern: pattern.id,
        });
      }
    }
  }
  manifest.secret_scan = {
    scanned_files: files.length,
    findings,
  };
  if (findings.length) {
    manifest.warnings.push(`Secret scan found ${findings.length} potential issue(s); inspect BUNDLE_MANIFEST.json before sharing.`);
  }
}

function createZip() {
  const ps = spawnSync(
    "powershell",
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      `Compress-Archive -LiteralPath ${powerShellString(bundleDir)} -DestinationPath ${powerShellString(zipPath)} -Force`,
    ],
    { cwd: root, encoding: "utf8" },
  );
  if (ps.status !== 0 || !existsSync(zipPath)) {
    const message = ps.status !== 0 ? ps.stderr || ps.stdout || "unknown error" : "archive was not created";
    const tar = spawnSync("tar", ["-a", "-cf", zipPath, "-C", outputRoot, bundleName], {
      cwd: root,
      encoding: "utf8",
    });
    if (tar.status !== 0 || !existsSync(zipPath)) {
      manifest.warnings.push(`Archive creation failed: ${message}; tar fallback: ${tar.stderr || tar.stdout || "unknown error"}`);
      return;
    }
    manifest.included.zip_archiver = "tar";
  } else {
    manifest.included.zip_archiver = "Compress-Archive";
  }
  if (existsSync(zipPath)) {
    manifest.included.zip_path = zipPath;
    manifest.included.zip_bytes = statSync(zipPath).size;
    return;
  }
}

function copyDirectoryIfExists(source, target) {
  if (!existsSync(source)) return;
  copyDirectoryFiltered(source, target);
}

function copyDirectoryFiltered(source, target) {
  cpSync(source, target, {
    recursive: true,
    filter: (item) => shouldCopyPath(item),
  });
}

function copyFileIfExists(source, target) {
  if (!existsSync(source)) return;
  if (!shouldCopyPath(source)) return;
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target);
}

function shouldCopyPath(path) {
  const rel = normalizeSlashes(relative(root, resolve(path)));
  const name = basename(path);
  if (!rel || rel.startsWith("..")) return true;
  const denySegments = new Set([
    ".git",
    ".next",
    ".vercel",
    "node_modules",
    "logs",
    "review-bundles",
    "tmp",
    "state",
  ]);
  if (rel.split("/").some((segment) => denySegments.has(segment))) return false;
  if (name.startsWith(".env")) return false;
  if (/\.env(?:\.|$)/i.test(name)) return false;
  if (/\.(log|tsbuildinfo)$/i.test(name)) return false;
  if (/\.(png|jpe?g|webp|gif|mp4|zip)$/i.test(name)) return false;
  return true;
}

function walkFiles(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkFiles(full));
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

function sanitizeSharedAward(row) {
  const copy = { ...row };
  delete copy.submitted_by_user_id;
  copy.public_facts = shrinkJson(copy.public_facts, 16_000);
  return copy;
}

function sanitizeSharedAwardSource(row) {
  const copy = { ...row };
  delete copy.submitted_by_user_id;
  delete copy.admin_reviewed_by;
  copy.last_error = truncateString(copy.last_error, 400);
  copy.admin_review_note = truncateString(copy.admin_review_note, 500);
  copy.page_metadata = shrinkJson(copy.page_metadata, 12_000);
  return copy;
}

function sanitizeChangeEvent(row) {
  const copy = { ...row };
  copy.change_details = shrinkJson(copy.change_details, 16_000);
  return copy;
}

function sanitizeVisualSnapshot(row) {
  const copy = { ...row };
  copy.latest_metadata = shrinkJson(copy.latest_metadata, 10_000);
  copy.previous_metadata = shrinkJson(copy.previous_metadata, 10_000);
  return copy;
}

function sanitizeTextSnapshot(row) {
  const copy = { ...row };
  copy.text_sample = truncateString(copy.text_sample, 2000);
  return copy;
}

function sanitizeWorkerRun(row) {
  const copy = { ...row };
  copy.error = truncateString(copy.error, 500);
  copy.metadata = shrinkJson(copy.metadata, 12_000);
  return copy;
}

function sanitizeRecord(value) {
  const object = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const output = {};
  for (const [key, item] of Object.entries(object)) {
    if (/(email|phone|password|token|secret|service_role|api_key|access_key|private_key|ciphertext|encrypted)/i.test(key)) {
      output[key] = "[redacted]";
      continue;
    }
    if (item && typeof item === "object") {
      output[key] = sanitizeJsonValue(item);
    } else if (typeof item === "string") {
      output[key] = redactSecretLikeText(item);
    } else {
      output[key] = item;
    }
  }
  return output;
}

function sanitizeJsonValue(value) {
  if (Array.isArray(value)) return value.map(sanitizeJsonValue);
  if (!value || typeof value !== "object") {
    return typeof value === "string" ? redactSecretLikeText(value) : value;
  }
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    if (/(email|phone|password|token|secret|service_role|api_key|access_key|private_key|ciphertext|encrypted)/i.test(key)) {
      output[key] = "[redacted]";
    } else {
      output[key] = sanitizeJsonValue(item);
    }
  }
  return output;
}

function redactSecretLikeText(value) {
  return String(value || "")
    .replace(/\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g, "[redacted-openai-key]")
    .replace(/\bAIza[A-Za-z0-9_-]{30,}\b/g, "[redacted-google-key]")
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "[redacted-aws-key]")
    .replace(/\beyJ[A-Za-z0-9_-]{80,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/g, "[redacted-jwt]")
    .replace(
      /([?&](?:token|access_token|refresh_token|key|api_key|code|state|secret|sig|signature|x-amz-signature|x-amz-credential)=)[^&#\s"')]+/gi,
      "$1[redacted]",
    );
}

function shrinkJson(value, maxChars) {
  if (value == null) return value;
  const sanitized = sanitizeJsonValue(value);
  const text = JSON.stringify(sanitized);
  if (text.length <= maxChars) return sanitized;
  return {
    truncated: true,
    original_json_chars: text.length,
    preview: text.slice(0, maxChars),
  };
}

function truncateString(value, maxChars) {
  if (typeof value !== "string") return value;
  const clean = redactSecretLikeText(value);
  return clean.length > maxChars ? `${clean.slice(0, maxChars)}... [truncated]` : clean;
}

function toCsv(rows) {
  if (!rows.length) return "";
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  return [
    columns.map(csvCell).join(","),
    ...rows.map((row) => columns.map((column) => csvCell(row[column])).join(",")),
  ].join("\n");
}

function csvCell(value) {
  if (value == null) return "";
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) continue;
    const body = arg.slice(2);
    if (body.includes("=")) {
      const [key, ...rest] = body.split("=");
      parsed[key] = rest.join("=");
    } else {
      const next = argv[index + 1];
      if (next && !next.startsWith("--")) {
        parsed[body] = next;
        index += 1;
      } else {
        parsed[body] = true;
      }
    }
  }
  return parsed;
}

function loadEnvFile(filePath) {
  if (!existsSync(filePath)) return {};
  const env = {};
  for (const line of readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[match[1]] = value;
  }
  return env;
}

function nonNegativeInt(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : fallback;
}

function cleanPathSegment(value) {
  return String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
}

function normalizeSlashes(value) {
  return String(value || "").replace(/\\/g, "/");
}

function powerShellString(value) {
  return `'${String(value || "").replace(/'/g, "''")}'`;
}
