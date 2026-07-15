import {
  existsSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import {
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

import {
  atomicWriteJson,
  withVisualBaselineLockAsync,
} from "./visual-baseline-lock.mjs";

export const LOCAL_BASELINE_EVIDENCE_REPAIR_REASON =
  "repaired_dangling_baseline_pointer";

const sourceIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab0-9a-f][0-9a-f]{3}-[0-9a-f]{12}$/i;
const capturePathFields = [
  "dir",
  "page",
  "thumb",
  "pdf",
  "text",
  "expansion_text",
  "sections_text",
  "sections_json",
  "meta",
];
const requiredEvidenceFields = {
  webpage: ["page", "thumb", "text", "meta"],
  pdf: ["pdf", "text", "meta"],
};
const metadataPathFields = new Set(capturePathFields.filter((field) => field !== "dir"));

export function parseSourceIdsFileContent(content) {
  const text = String(content ?? "").trim();
  if (!text) return [];

  if (text.startsWith("[") || text.startsWith("{")) {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new TypeError(`Source IDs JSON is invalid: ${errorMessage(error)}`);
    }
    const values = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed?.source_ids)
        ? parsed.source_ids
        : null;
    if (!values) {
      throw new TypeError("Source IDs JSON must be an array or an object with a source_ids array.");
    }
    if (values.some((value) => typeof value !== "string")) {
      throw new TypeError("Every source ID in JSON must be a string.");
    }
    return uniqueStrings(values);
  }

  return uniqueStrings(
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#")),
  );
}

export async function repairLocalBaselineEvidence({
  archiveRoot,
  sourceId,
  apply = false,
  now = new Date().toISOString(),
} = {}) {
  const root = requiredArchiveRoot(archiveRoot);
  const id = String(sourceId || "").trim();
  if (!sourceIdPattern.test(id)) {
    return refusal(id, "unsafe_or_invalid_source_id");
  }

  return withVisualBaselineLockAsync({
    archiveRoot: root,
    sourceId: id,
    operation: async () => {
      const inspection = inspectLocalBaselineEvidence({
        archiveRoot: root,
        sourceId: id,
        now,
      });
      if (inspection.decision !== "repair") return inspection;
      if (!apply) {
        return {
          ...inspection,
          status: "repairable",
          evidence_complete: false,
        };
      }

      atomicWriteJson(inspection.baseline_path, inspection.repaired_baseline);
      return {
        ...inspection,
        status: "repaired",
        evidence_complete: true,
      };
    },
  });
}

export function inspectLocalBaselineEvidence({
  archiveRoot,
  sourceId,
  now = new Date().toISOString(),
} = {}) {
  const root = requiredArchiveRoot(archiveRoot);
  const id = String(sourceId || "").trim();
  if (!sourceIdPattern.test(id)) {
    return refusal(id, "unsafe_or_invalid_source_id");
  }

  const sourceDir = join(root, "sources", id);
  const baselinePath = join(sourceDir, "baseline.json");
  if (!existsSync(baselinePath)) {
    return refusal(id, "baseline_missing", { baseline_path: baselinePath });
  }

  const currentBaselineRead = readJson(baselinePath);
  if (!currentBaselineRead.ok) {
    return refusal(id, "baseline_json_invalid", {
      baseline_path: baselinePath,
      detail: currentBaselineRead.error,
    });
  }
  const currentBaseline = objectValue(currentBaselineRead.value);
  if (currentBaseline.source?.id !== id) {
    return refusal(id, "current_source_id_mismatch", { baseline_path: baselinePath });
  }

  const currentKind = captureKind(currentBaseline.kind, currentBaseline.capture);
  if (!currentKind.ok) {
    return refusal(id, `current_${currentKind.reason}`, { baseline_path: baselinePath });
  }
  const currentCapture = validateCaptureDescriptor({
    archiveRoot: root,
    sourceDir,
    capture: currentBaseline.capture,
    kind: currentKind.kind,
    label: "current",
    requireCompleteEvidence: false,
  });
  if (!currentCapture.ok) {
    return refusal(id, currentCapture.reason, {
      baseline_path: baselinePath,
      detail: currentCapture.detail,
    });
  }
  if (currentCapture.resolved.meta && isRegularFile(currentCapture.resolved.meta)) {
    const currentMetaRead = readJson(currentCapture.resolved.meta);
    if (!currentMetaRead.ok) {
      return refusal(id, "current_meta_json_invalid", {
        baseline_path: baselinePath,
        detail: currentMetaRead.error,
      });
    }
    const currentMetaValidation = validateEvidenceMeta({
      archiveRoot: root,
      sourceDir,
      sourceId: id,
      kind: currentKind.kind,
      capture: currentCapture,
      meta: objectValue(currentMetaRead.value),
      label: "current",
    });
    if (!currentMetaValidation.ok) {
      return refusal(id, currentMetaValidation.reason, {
        baseline_path: baselinePath,
        detail: currentMetaValidation.detail,
      });
    }
  }
  if (!currentCapture.missing_required.length) {
    return refusal(id, "current_evidence_valid", {
      baseline_path: baselinePath,
      evidence_complete: true,
    });
  }

  const previousDescriptor = currentBaseline.summary_metadata?.previous_baseline_capture;
  if (!objectHasKeys(previousDescriptor)) {
    return refusal(id, "previous_baseline_capture_missing", {
      baseline_path: baselinePath,
      missing_current_evidence: currentCapture.missing_required,
    });
  }
  if (sameCaptureDirectory(currentBaseline.capture, previousDescriptor)) {
    return refusal(id, "previous_capture_ambiguous_same_as_current", {
      baseline_path: baselinePath,
    });
  }

  const previousKind = captureKind(currentKind.kind, previousDescriptor);
  if (!previousKind.ok || previousKind.kind !== currentKind.kind) {
    return refusal(id, "previous_capture_kind_ambiguous", { baseline_path: baselinePath });
  }
  const previousCapture = validateCaptureDescriptor({
    archiveRoot: root,
    sourceDir,
    capture: previousDescriptor,
    kind: previousKind.kind,
    label: "previous",
    requireCompleteEvidence: true,
  });
  if (!previousCapture.ok) {
    return refusal(id, previousCapture.reason, {
      baseline_path: baselinePath,
      detail: previousCapture.detail,
      missing_previous_evidence: previousCapture.missing_required || [],
    });
  }
  if (sameResolvedPath(currentCapture.resolved.dir, previousCapture.resolved.dir)) {
    return refusal(id, "previous_capture_ambiguous_same_as_current", {
      baseline_path: baselinePath,
    });
  }

  const previousMetaRead = readJson(previousCapture.resolved.meta);
  if (!previousMetaRead.ok) {
    return refusal(id, "previous_meta_json_invalid", {
      baseline_path: baselinePath,
      detail: previousMetaRead.error,
    });
  }
  const previousMeta = objectValue(previousMetaRead.value);
  const metaValidation = validateEvidenceMeta({
    archiveRoot: root,
    sourceDir,
    sourceId: id,
    kind: previousKind.kind,
    capture: previousCapture,
    meta: previousMeta,
    label: "previous",
  });
  if (!metaValidation.ok) {
    return refusal(id, metaValidation.reason, {
      baseline_path: baselinePath,
      detail: metaValidation.detail,
    });
  }

  const repairedBaseline = buildRepairedBaseline({
    currentBaseline,
    danglingCapture: currentCapture.stored,
    previousCapture: previousCapture.stored,
    previousMeta,
    kind: previousKind.kind,
    now,
  });

  return {
    source_id: id,
    status: "repairable",
    decision: "repair",
    reason: LOCAL_BASELINE_EVIDENCE_REPAIR_REASON,
    evidence_complete: false,
    baseline_path: baselinePath,
    missing_current_evidence: currentCapture.missing_required,
    restored_capture: previousCapture.stored.dir,
    repaired_baseline: repairedBaseline,
  };
}

export function buildRepairedBaseline({
  currentBaseline,
  danglingCapture,
  previousCapture,
  previousMeta,
  kind,
  now,
}) {
  const currentSummary = objectValue(currentBaseline.summary_metadata);
  const webCapture = kind === "webpage";
  return {
    version: currentBaseline.version || 1,
    kind,
    capture_behavior_version: webCapture
      ? nullable(previousMeta.capture_behavior_version)
      : null,
    capture_behavior_name: webCapture
      ? nullable(previousMeta.capture_behavior_name)
      : null,
    capture_profile: nullable(previousMeta.capture_profile),
    section_extraction_profile: nullable(previousMeta.section_extraction_profile),
    source: currentBaseline.source,
    captured_at: previousMeta.captured_at,
    final_url: nullable(previousMeta.final_url),
    page_title: nullable(previousMeta.page_title),
    text_hash: nullable(previousMeta.text_hash),
    body_text_hash: nullable(previousMeta.body_text_hash),
    main_content_hash: nullable(previousMeta.main_content_hash),
    nav_header_footer_hash: nullable(previousMeta.nav_header_footer_hash),
    expansion_hash: nullable(previousMeta.expansion_hash),
    expandable_sections_hash: nullable(previousMeta.expandable_sections_hash),
    image_hash: nullable(previousMeta.image_hash),
    file_hash: nullable(previousMeta.file_hash),
    file_bytes: nullable(previousMeta.file_bytes),
    text_length: nonNegativeNumberOrNull(previousMeta.text_length),
    body_text_length: nonNegativeNumberOrNull(previousMeta.body_text_length),
    main_content_text_length: nonNegativeNumberOrNull(previousMeta.main_content_text_length),
    nav_header_footer_text_length: nonNegativeNumberOrNull(previousMeta.nav_header_footer_text_length),
    expansion_text_length: nonNegativeNumberOrNull(previousMeta.expansion_text_length),
    section_text_length: nonNegativeNumberOrNull(previousMeta.section_text_length),
    expandable_sections: Array.isArray(previousMeta.expandable_sections)
      ? previousMeta.expandable_sections
      : [],
    dimensions: objectOrNull(previousMeta.dimensions),
    hidden_noise_counts: objectOrNull(previousMeta.hidden_noise_counts),
    capture: previousCapture,
    summary_metadata: {
      reason: LOCAL_BASELINE_EVIDENCE_REPAIR_REASON,
      updated_at: now,
      ai_provider: nullable(currentSummary.ai_provider),
      ai_model: nullable(currentSummary.ai_model),
      previous_baseline: null,
      previous_baseline_capture: null,
      baseline_facts: currentSummary.baseline_facts ?? null,
      baseline_facts_metadata: currentSummary.baseline_facts_metadata ?? null,
      local_evidence_repair: {
        reason: LOCAL_BASELINE_EVIDENCE_REPAIR_REASON,
        repaired_at: now,
        dangling_captured_at: currentBaseline.captured_at || null,
        dangling_capture: danglingCapture || null,
        restored_captured_at: previousMeta.captured_at,
        restored_capture: previousCapture,
        prior_summary_reason: currentSummary.reason || null,
      },
    },
  };
}

function validateCaptureDescriptor({
  archiveRoot,
  sourceDir,
  capture,
  kind,
  label,
  requireCompleteEvidence,
}) {
  const value = objectValue(capture);
  if (!objectHasKeys(value)) return invalid(`${label}_capture_missing`);

  const resolved = {};
  const stored = {};
  for (const field of capturePathFields) {
    const fieldValue = value[field];
    if (fieldValue === null || fieldValue === undefined || fieldValue === "") {
      stored[field] = null;
      resolved[field] = null;
      continue;
    }
    if (typeof fieldValue !== "string") {
      return invalid(`${label}_capture_path_invalid`, `${field} is not a string`);
    }
    const validated = validateStoredPath({
      archiveRoot,
      sourceDir,
      storedPath: fieldValue,
    });
    if (!validated.ok) {
      return invalid(`${label}_${validated.reason}`, field);
    }
    stored[field] = validated.stored;
    resolved[field] = validated.resolved;
  }

  if (!resolved.dir) return invalid(`${label}_capture_dir_missing`);
  if (!pathIsWithin(sourceDir, resolved.dir)) {
    return invalid(`${label}_capture_dir_outside_source`);
  }
  const realCaptureContainment = validateRealCaptureContainment({
    archiveRoot,
    sourceDir,
    captureDir: resolved.dir,
    resolved,
    label,
  });
  if (!realCaptureContainment.ok) return realCaptureContainment;
  for (const field of capturePathFields.filter((entry) => entry !== "dir")) {
    if (resolved[field] && !pathIsWithin(resolved.dir, resolved[field])) {
      return invalid(`${label}_capture_file_outside_capture_dir`, field);
    }
  }

  const conflictingField = kind === "pdf" ? ["page", "thumb"] : ["pdf"];
  if (conflictingField.some((field) => resolved[field])) {
    return invalid(`${label}_capture_kind_ambiguous`);
  }

  const missingRequired = requiredEvidenceFields[kind].filter(
    (field) => !resolved[field] || !isRegularFile(resolved[field]),
  );
  if (requireCompleteEvidence && missingRequired.length) {
    return {
      ...invalid(`${label}_evidence_incomplete`),
      missing_required: missingRequired,
    };
  }

  if (requireCompleteEvidence && !isDirectory(resolved.dir)) {
    return invalid(`${label}_capture_dir_missing`);
  }

  return {
    ok: true,
    kind,
    resolved,
    stored,
    missing_required: missingRequired,
  };
}

function validateEvidenceMeta({
  archiveRoot,
  sourceDir,
  sourceId,
  kind,
  capture,
  meta,
  label,
}) {
  if (meta.source?.id !== sourceId) {
    return invalid(`${label}_meta_source_id_mismatch`);
  }
  if (meta.kind !== kind) {
    return invalid(`${label}_meta_kind_mismatch`);
  }
  if (!meta.captured_at || !Number.isFinite(Date.parse(meta.captured_at))) {
    return invalid(`${label}_meta_captured_at_invalid`);
  }
  if (!meta.text_hash) return invalid(`${label}_meta_text_hash_missing`);
  if (kind === "pdf" && !meta.file_hash) {
    return invalid(`${label}_meta_file_hash_missing`);
  }
  if (kind === "webpage" && !meta.image_hash) {
    return invalid(`${label}_meta_image_hash_missing`);
  }

  if (meta.files != null && !isObject(meta.files)) {
    return invalid(`${label}_meta_files_invalid`);
  }
  const metaFiles = objectValue(meta.files);
  for (const { field, value: pathValue } of metadataPaths(metaFiles)) {
    const validated = validateStoredPath({
      archiveRoot,
      sourceDir,
      storedPath: pathValue,
    });
    if (!validated.ok) return invalid(`${label}_meta_${validated.reason}`, field);
    if (!pathIsWithin(capture.resolved.dir, validated.resolved)) {
      return invalid(`${label}_meta_file_outside_capture_dir`, field);
    }
    const realContainment = realPathContainment(
      capture.resolved.dir,
      validated.resolved,
    );
    if (!realContainment.ok) {
      return invalid(`${label}_meta_file_symlink_outside_capture_dir`, field);
    }
  }
  for (const field of requiredEvidenceFields[kind]) {
    if (!metaFiles[field]) continue;
    if (typeof metaFiles[field] !== "string") {
      return invalid(`${label}_meta_file_mismatch`, field);
    }
    const validated = validateStoredPath({
      archiveRoot,
      sourceDir,
      storedPath: metaFiles[field],
    });
    if (!validated.ok || validated.resolved !== capture.resolved[field]) {
      return invalid(`${label}_meta_file_mismatch`, field);
    }
  }

  return { ok: true };
}

function validateStoredPath({ archiveRoot, sourceDir, storedPath }) {
  const value = String(storedPath || "").trim();
  if (!value || isAbsolute(value)) return invalid("path_not_archive_relative");
  const resolvedPath = resolve(archiveRoot, value);
  if (!pathIsWithin(sourceDir, resolvedPath)) return invalid("path_outside_source");
  try {
    const realArchive = realpathSync(archiveRoot);
    const realSource = realpathSync(sourceDir);
    if (!pathIsWithin(realArchive, realSource)) {
      return invalid("source_symlink_outside_archive");
    }
  } catch (error) {
    return invalid("source_realpath_failed", errorMessage(error));
  }
  if (existsSync(resolvedPath)) {
    try {
      const realSource = realpathSync(sourceDir);
      const realTarget = realpathSync(resolvedPath);
      if (!pathIsWithin(realSource, realTarget)) return invalid("path_symlink_outside_source");
    } catch (error) {
      return invalid("path_realpath_failed", errorMessage(error));
    }
  }
  return {
    ok: true,
    resolved: resolvedPath,
    stored: relative(archiveRoot, resolvedPath).split(sep).join("/"),
  };
}

function captureKind(explicitKind, capture) {
  const value = objectValue(capture);
  const explicit = explicitKind === "webpage" || explicitKind === "pdf"
    ? explicitKind
    : null;
  if (explicitKind && !explicit) return invalid("capture_kind_ambiguous");
  const hasWeb = Boolean(value.page || value.thumb);
  const hasPdf = Boolean(value.pdf);
  if (hasWeb && hasPdf) return invalid("capture_kind_ambiguous");
  const inferred = hasPdf ? "pdf" : hasWeb ? "webpage" : null;
  if (explicit && inferred && explicit !== inferred) {
    return invalid("capture_kind_ambiguous");
  }
  if (!explicit && !inferred) return invalid("capture_kind_ambiguous");
  return { ok: true, kind: explicit || inferred };
}

function sameCaptureDirectory(left, right) {
  const leftDir = typeof left?.dir === "string" ? left.dir.replaceAll("\\", "/") : "";
  const rightDir = typeof right?.dir === "string" ? right.dir.replaceAll("\\", "/") : "";
  return Boolean(leftDir && rightDir && leftDir === rightDir);
}

function sameResolvedPath(left, right) {
  if (!left || !right) return false;
  const normalizedLeft = canonicalPath(left);
  const normalizedRight = canonicalPath(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function validateRealCaptureContainment({
  archiveRoot,
  sourceDir,
  captureDir,
  resolved,
  label,
}) {
  if (!existsSync(captureDir)) return { ok: true };
  try {
    const realArchive = realpathSync(archiveRoot);
    const realSource = realpathSync(sourceDir);
    const realCapture = realpathSync(captureDir);
    if (!pathIsWithin(realArchive, realSource)) {
      return invalid(`${label}_source_symlink_outside_archive`);
    }
    if (!pathIsWithin(realSource, realCapture)) {
      return invalid(`${label}_capture_symlink_outside_source`);
    }
    for (const [field, target] of Object.entries(resolved)) {
      if (field === "dir" || !target || !existsSync(target)) continue;
      if (!pathIsWithin(realCapture, realpathSync(target))) {
        return invalid(`${label}_capture_file_symlink_outside_capture_dir`, field);
      }
    }
  } catch (error) {
    return invalid(`${label}_capture_realpath_failed`, errorMessage(error));
  }
  return { ok: true };
}

function realPathContainment(parent, candidate) {
  if (!existsSync(parent) || !existsSync(candidate)) return { ok: true };
  try {
    return pathIsWithin(realpathSync(parent), realpathSync(candidate))
      ? { ok: true }
      : { ok: false };
  } catch (error) {
    return { ok: false, detail: errorMessage(error) };
  }
}

function canonicalPath(value) {
  try {
    return realpathSync(value);
  } catch {
    return resolve(value);
  }
}

function pathIsWithin(parent, candidate) {
  const path = relative(resolve(parent), resolve(candidate));
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

function readJson(path) {
  try {
    return { ok: true, value: JSON.parse(readFileSync(path, "utf8")) };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

function isRegularFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function metadataPaths(value) {
  if (Array.isArray(value)) return value.flatMap(metadataPaths);
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([field, entry]) => {
    if (metadataPathFields.has(field) && typeof entry === "string") {
      return [{ field, value: entry }];
    }
    return metadataPaths(entry);
  });
}

function refusal(sourceId, reason, details = {}) {
  return {
    source_id: sourceId || null,
    status: "refused",
    decision: "refuse",
    reason,
    ...details,
  };
}

function invalid(reason, detail = null) {
  return { ok: false, reason, detail };
}

function objectValue(value) {
  return isObject(value) ? value : {};
}

function isObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function objectHasKeys(value) {
  return Object.keys(objectValue(value)).length > 0;
}

function objectOrNull(value) {
  return objectHasKeys(value) ? value : null;
}

function nullable(value) {
  return value === undefined ? null : value;
}

function nonNegativeNumberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function requiredArchiveRoot(value) {
  const path = String(value ?? "").trim();
  if (!path) throw new TypeError("archiveRoot is required.");
  return resolve(path);
}

function uniqueStrings(values) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function errorMessage(error) {
  return String(error?.message || error || "unknown error");
}
