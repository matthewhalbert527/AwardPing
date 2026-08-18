import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  normalizeStage1CandidateImportBundle,
  stage1CandidateImportScope,
} from "./stage1-reviewed-candidate-import.mjs";
import { stableRows } from "./stage1-manifest-draft-loader.mjs";

export const STAGE1_CANDIDATE_IMPORT_MAX_TEXT_BYTES = 20 * 1024 * 1024;

export async function loadStage1CandidateImportEvidence({
  supabase,
  bundle,
  archiveRoot,
  now = new Date(),
}) {
  if (!supabase || typeof supabase.from !== "function") {
    throw new Error("Stage 1 candidate import loading requires a Supabase service client.");
  }
  const scope = stage1CandidateImportScope(bundle, now);
  const registry = await stableRows(
    () => supabase
      .from("stage1_award_registry")
      .select("cohort_key,launch_rank,canonical_name,canonical_shared_award_id,official_homepage,policy_version,updated_at", { count: "exact" })
      .eq("cohort_key", scope.cohort_key)
      .order("cohort_key", { ascending: true }),
    "candidate-import Stage 1 registry",
    (row) => `registry:${row.cohort_key}`,
  );
  const members = await stableRows(
    () => supabase
      .from("stage1_award_members")
      .select("shared_award_id,cohort_key,member_kind,reason,created_at,updated_at", { count: "exact" })
      .eq("cohort_key", scope.cohort_key)
      .order("shared_award_id", { ascending: true }),
    "candidate-import cohort members",
    (row) => `member:${row.shared_award_id}`,
  );
  const identityRules = await stableRows(
    () => supabase
      .from("stage1_award_source_identity_rules")
      .select("id,cohort_key,rule_key,url_pattern,title_pattern,reason,policy_version,created_at,updated_at", { count: "exact" })
      .eq("cohort_key", scope.cohort_key)
      .order("rule_key", { ascending: true })
      .order("id", { ascending: true }),
    "candidate-import identity rules",
    (row) => `rule:${row.id}`,
  );
  const [awards, sources, visualSnapshots] = await Promise.all([
    stableRows(
      () => supabase
        .from("shared_awards")
        .select("id,search_key,name,official_homepage,status,updated_at", { count: "exact" })
        .eq("id", scope.canonical_award_id)
        .order("id", { ascending: true }),
      "candidate-import canonical award",
      (row) => `award:${row.id}`,
    ),
    stableRows(
      () => supabase
        .from("shared_award_sources")
        .select("id,shared_award_id,url,title,display_title,admin_review_status,last_checked_at,last_error,updated_at", { count: "exact" })
        .in("id", scope.source_ids)
        .order("id", { ascending: true }),
      "candidate-import reviewed sources",
      (row) => `source:${row.id}`,
    ),
    stableRows(
      () => supabase
        .from("shared_award_source_visual_snapshots")
        .select("shared_award_source_id,shared_award_id,source_url,kind,bucket,latest_captured_at,latest_object_keys,latest_hashes,latest_metadata,updated_at", { count: "exact" })
        .in("shared_award_source_id", scope.source_ids)
        .order("shared_award_source_id", { ascending: true }),
      "candidate-import immutable snapshots",
      (row) => `snapshot:${row.shared_award_source_id}`,
    ),
  ]);
  const localEvidence = readStage1CandidateImportLocalEvidence({
    bundle,
    archiveRoot,
    now,
  });
  return {
    database: {
      registry,
      members,
      identity_rules: identityRules,
      awards,
      sources,
      visual_snapshots: visualSnapshots,
    },
    localEvidence,
  };
}

export function readStage1CandidateImportLocalEvidence({
  bundle,
  archiveRoot,
  now = new Date(),
}) {
  const normalized = normalizeStage1CandidateImportBundle(bundle, now);
  const root = resolve(String(archiveRoot || ""));
  if (!String(archiveRoot || "").trim() || !existsSync(root)) {
    throw new Error("Stage 1 candidate import requires an existing visual archive root.");
  }
  assertNoSymlink(root, "visual archive root");
  const realRoot = realpathSync.native(root);
  return normalized.sources.map((source) => {
    const captureDirectory = new Date(source.captured_at).toISOString().replace(/[:.]/g, "-");
    const sourceRoot = resolve(join(root, "sources", source.source_id));
    const exactCaptureRoot = resolve(join(sourceRoot, "captures", captureDirectory));
    const path = resolve(join(
      exactCaptureRoot,
      "text.txt",
    ));
    assertInsideRoot(path, root, "derived immutable text path");
    if (!existsSync(path)) {
      throw new Error(`Stage 1 candidate import local text is missing for source ${source.source_id}: ${path}`);
    }
    assertNoSymlinksBetween(root, path, source.source_id);
    const realPath = realpathSync.native(path);
    assertInsideRoot(realPath, realRoot, "resolved immutable text path");
    const realSourceRoot = realpathSync.native(sourceRoot);
    const realCaptureRoot = realpathSync.native(exactCaptureRoot);
    assertInsideRoot(realCaptureRoot, realSourceRoot, "resolved source capture directory");
    if (!samePath(dirname(realPath), realCaptureRoot)) {
      throw new Error(`Stage 1 candidate import immutable text resolves outside the exact capture directory for source ${source.source_id}.`);
    }
    const file = statSync(realPath);
    if (!file.isFile()) {
      throw new Error(`Stage 1 candidate import immutable text is not a regular file for source ${source.source_id}.`);
    }
    if (file.size > STAGE1_CANDIDATE_IMPORT_MAX_TEXT_BYTES) {
      throw new Error(`Stage 1 candidate import immutable text exceeds the 20 MiB safety limit for source ${source.source_id}.`);
    }
    const buffer = readFileSync(realPath);
    let rawText;
    try {
      rawText = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    } catch {
      throw new Error(`Stage 1 candidate import local text is not valid UTF-8 for source ${source.source_id}.`);
    }
    if (!rawText.endsWith("\n")) {
      throw new Error(`Stage 1 candidate import local text lacks the capture writer's final newline for source ${source.source_id}.`);
    }
    const semanticText = rawText.endsWith("\r\n")
      ? rawText.slice(0, -2)
      : rawText.slice(0, -1);
    return {
      source_id: source.source_id,
      path: realPath,
      raw_bytes: buffer.length,
      semantic_text: semanticText,
      semantic_text_sha256: sha256Text(semanticText),
      text_length: semanticText.length,
      capture_text_sha256: source.capture_text_sha256,
      capture_text_object_key: source.capture_text_object_key,
    };
  });
}

function assertNoSymlinksBetween(root, path, sourceId) {
  const parts = relative(root, path).split(sep).filter(Boolean);
  let current = root;
  assertNoSymlink(current, "visual archive root");
  for (const part of parts) {
    current = join(current, part);
    assertNoSymlink(current, `immutable text path for source ${sourceId}`);
  }
}

function assertNoSymlink(path, label) {
  if (lstatSync(path).isSymbolicLink()) {
    throw new Error(`Stage 1 candidate import ${label} must not contain a symbolic link.`);
  }
}

function samePath(left, right) {
  return process.platform === "win32"
    ? resolve(left).toLowerCase() === resolve(right).toLowerCase()
    : resolve(left) === resolve(right);
}

function assertInsideRoot(path, root, label) {
  const pathRelative = relative(root, path);
  if (!pathRelative || pathRelative === ".") {
    throw new Error(`Stage 1 candidate import ${label} resolves to the archive root.`);
  }
  if (pathRelative === ".." || pathRelative.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(pathRelative)) {
    throw new Error(`Stage 1 candidate import ${label} escapes the visual archive root.`);
  }
}

function sha256Text(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
