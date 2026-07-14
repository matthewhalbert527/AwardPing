import { DeleteObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { atomicWriteJson } from "./visual-baseline-lock.mjs";
import { advanceVisualSnapshotPointer } from "./visual-snapshot-pointer.mjs";
import {
  rotatedVisualSnapshotHistory,
  visualSnapshotKeysToDeleteAfterCas,
  visualSnapshotUploadedKeysToDeleteAfterLostCas,
} from "./visual-snapshot-history.mjs";

const r2Slots = [
  { name: "page", fileName: "page.jpg", contentType: "image/jpeg" },
  { name: "thumb", fileName: "thumb.jpg", contentType: "image/jpeg" },
  { name: "pdf", fileName: "document.pdf", contentType: "application/pdf" },
  { name: "text", fileName: "text.txt", contentType: "text/plain; charset=utf-8" },
  { name: "meta", fileName: "meta.json", contentType: "application/json; charset=utf-8" },
];

export function visualBaselinePromotionDecision({
  candidate,
  approved = false,
  existingBaseline = null,
  snapshot = null,
} = {}) {
  if (!approved) return { promote: false, reason: "candidate_not_approved" };
  const ref = candidateSnapshotRef(candidate);
  const hashes = snapshot
    ? {
        text_hash: snapshot.text_hash || null,
        image_hash: snapshot.image_hash || null,
        file_hash: snapshot.file_hash || null,
      }
    : candidateSnapshotHashes(candidate, ref);
  if (!ref || !Object.values(hashes).some(Boolean)) {
    return { promote: false, reason: "missing_approved_snapshot_reference" };
  }
  if (sameSnapshotHashes(existingBaseline, hashes)) {
    return { promote: false, reason: "approved_snapshot_already_current", already_current: true };
  }
  const existingCapturedAt = timestampValue(existingBaseline?.captured_at);
  const candidateCapturedAt = timestampValue(snapshot?.captured_at || ref.captured_at);
  if (existingCapturedAt && candidateCapturedAt && existingCapturedAt > candidateCapturedAt) {
    return { promote: false, reason: "newer_whole_page_baseline_exists" };
  }
  if (
    existingCapturedAt &&
    candidateCapturedAt &&
    existingCapturedAt === candidateCapturedAt &&
    !sameSnapshotHashes(existingBaseline, hashes)
  ) {
    return { promote: false, reason: "same_timestamp_baseline_conflict" };
  }
  return { promote: true, reason: "approved_whole_page_snapshot" };
}

export function visualBaselinePublicationDecision({
  local,
  r2,
  r2Required = false,
} = {}) {
  const conflictReasons = new Set([
    "newer_whole_page_baseline_exists",
    "same_timestamp_baseline_conflict",
    "newer_or_conflicting_r2_baseline_exists",
  ]);
  const conflict = [local, r2].find((result) => conflictReasons.has(result?.reason));
  if (conflict) return { action: "supersede", reason: conflict.reason };

  const localComplete = Boolean(local?.promoted || local?.already_current);
  if (!localComplete) {
    return { action: "retry", reason: local?.reason || "local_baseline_not_advanced" };
  }
  const r2Complete = Boolean(r2?.promoted || r2?.already_current);
  if (r2Required && !r2Complete) {
    return { action: "retry", reason: r2?.reason || "r2_baseline_not_advanced" };
  }
  return { action: "publish", reason: "required_baseline_targets_current" };
}

export function promoteApprovedVisualBaselineLocal({
  candidate,
  source,
  archiveRoot,
  approved = false,
  now = new Date().toISOString(),
} = {}) {
  if (!source?.id) return { promoted: false, reason: "missing_source_id" };
  const baselinePath = join(resolve(archiveRoot), "sources", source.id, "baseline.json");
  const existingBaseline = readJsonIfExists(baselinePath);
  if (!approved) {
    return {
      promoted: false,
      baseline_path: baselinePath,
      ...visualBaselinePromotionDecision({ candidate, approved, existingBaseline }),
    };
  }
  const capture = captureFromVisualReviewCandidate(candidate, archiveRoot);
  const decision = visualBaselinePromotionDecision({
    candidate,
    approved,
    existingBaseline,
    snapshot: capture,
  });
  if (!decision.promote) {
    return { promoted: false, baseline_path: baselinePath, ...decision };
  }
  const requiredPaths = capture.kind === "pdf"
    ? [capture.pdf_path, capture.text_path, capture.meta_path]
    : [capture.page_path, capture.thumb_path, capture.text_path, capture.meta_path];
  const missingPaths = requiredPaths.filter((path) => !path || !existsSync(path));
  if (missingPaths.length) {
    return {
      promoted: false,
      reason: "approved_snapshot_files_missing",
      baseline_path: baselinePath,
      missing_paths: missingPaths,
    };
  }

  const baseline = buildBaseline({
    candidate,
    source,
    capture,
    archiveRoot,
    existingBaseline,
    now,
  });
  mkdirSync(dirname(baselinePath), { recursive: true });
  atomicWriteJson(baselinePath, baseline);
  return {
    promoted: true,
    reason: "approved_whole_page_snapshot",
    baseline_path: baselinePath,
    capture,
    baseline,
  };
}

export async function promoteApprovedVisualBaselineR2({
  candidate,
  source,
  capture,
  supabase,
  config,
  s3Client = null,
  approved = false,
  now = new Date().toISOString(),
} = {}) {
  const decision = visualBaselinePromotionDecision({ candidate, approved, snapshot: capture });
  if (!decision.promote) return { promoted: false, ...decision };
  if (!config?.enabled) return { promoted: false, reason: "r2_snapshot_sync_disabled" };
  if (!capture) return { promoted: false, reason: "missing_local_capture_for_r2" };
  if (!supabase) return { promoted: false, reason: "missing_supabase_client" };

  const ownsClient = !s3Client;
  const client = s3Client || new S3Client({
    region: "auto",
    endpoint: config.endpoint,
    forcePathStyle: true,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });
  try {
    const { data: existing, error: loadError } = await supabase
      .from("shared_award_source_visual_snapshots")
      .select(
        "latest_captured_at,latest_object_keys,latest_hashes,latest_metadata,previous_captured_at,previous_object_keys,previous_hashes,previous_metadata,updated_at",
      )
      .eq("shared_award_source_id", source.id)
      .maybeSingle();
    if (loadError) throw new Error(`Load R2 visual baseline failed: ${loadError.message}`);

    const candidateHashes = captureHashes(capture);
    const requiredSlots = capture.kind === "pdf"
      ? ["pdf", "text", "meta"]
      : ["page", "thumb", "text", "meta"];
    const existingKeys = objectValue(existing?.latest_object_keys);
    const hashesCurrent = sameSnapshotHashes(existing?.latest_hashes, candidateHashes);
    const existingPointerComplete = requiredSlots.every((slot) => cleanText(existingKeys[slot]));
    if (hashesCurrent && existingPointerComplete) {
      return { promoted: false, reason: "approved_r2_snapshot_already_current", already_current: true };
    }
    const existingCapturedAt = timestampValue(existing?.latest_captured_at);
    const candidateCapturedAt = timestampValue(capture.captured_at);
    if (
      existingCapturedAt && candidateCapturedAt &&
      (existingCapturedAt > candidateCapturedAt ||
        (existingCapturedAt === candidateCapturedAt && !hashesCurrent))
    ) {
      return { promoted: false, reason: "newer_or_conflicting_r2_baseline_exists" };
    }

    const files = captureFiles(capture);
    const presentSlots = new Set(files.map((file) => file.name));
    const missingSlots = requiredSlots.filter((slot) => !presentSlots.has(slot));
    if (missingSlots.length) {
      return {
        promoted: false,
        reason: "approved_snapshot_files_missing",
        missing_slots: missingSlots,
      };
    }
    const immutableVersion = approvedR2SnapshotVersion({ candidate, capture });
    const latestObjectKeys = {};
    for (const file of files) {
      const key = approvedR2SnapshotKey(source.id, immutableVersion, file.fileName);
      await client.send(new PutObjectCommand({
        Bucket: config.bucket,
        Key: key,
        Body: readFileSync(file.path),
        ContentType: file.contentType,
      }));
      latestObjectKeys[file.name] = key;
    }

    // Immutable, candidate-specific objects are all durable before the pointer
    // row changes. A partial upload or failed upsert can be retried without
    // mutating the objects referenced by the prior latest/previous pointers.
    const history = rotatedVisualSnapshotHistory(existing, latestObjectKeys);
    const snapshotRow = {
        shared_award_source_id: source.id,
        shared_award_id: source.shared_award_id,
        source_url: source.url,
        source_title: source.title || null,
        source_page_type: source.page_type || null,
        kind: capture.kind || "webpage",
        bucket: config.bucket,
        latest_captured_at: capture.captured_at,
        latest_object_keys: latestObjectKeys,
        latest_hashes: candidateHashes,
        latest_metadata: captureMetadata(capture),
        previous_captured_at: history.previous_captured_at,
        previous_object_keys: history.previous_object_keys,
        previous_hashes: history.previous_hashes,
        previous_metadata: history.previous_metadata,
        updated_at: now,
    };
    const advanced = await advanceVisualSnapshotPointer(supabase, {
      existing,
      snapshot: snapshotRow,
    });
    if (!advanced) {
      const { data: current, error: currentError } = await supabase
        .from("shared_award_source_visual_snapshots")
        .select("latest_object_keys,previous_object_keys")
        .eq("shared_award_source_id", source.id)
        .maybeSingle();
      if (currentError) {
        throw new Error(`Reload R2 visual baseline after lost CAS failed: ${currentError.message}`);
      }
      const orphanKeys = visualSnapshotUploadedKeysToDeleteAfterLostCas({
        uploaded: latestObjectKeys,
        current,
      });
      await Promise.all(orphanKeys.map((key) => client.send(new DeleteObjectCommand({
        Bucket: config.bucket,
        Key: key,
      }))));
      return {
        promoted: false,
        reason: "r2_pointer_compare_and_set_lost",
        deleted_orphan_uploads: orphanKeys.length,
      };
    }
    const staleKeys = visualSnapshotKeysToDeleteAfterCas({
      pointerAdvanced: advanced,
      existing,
      next: snapshotRow,
    });
    await Promise.all(staleKeys.map((key) => client.send(new DeleteObjectCommand({
      Bucket: config.bucket,
      Key: key,
    }))));

    return {
      promoted: true,
      reason: "approved_whole_page_snapshot",
      uploaded: Object.keys(latestObjectKeys).length,
      rotated: Object.keys(history.previous_object_keys).length,
      deleted: staleKeys.length,
      immutable_version: immutableVersion,
    };
  } finally {
    if (ownsClient) client.destroy();
  }
}

function candidateSnapshotRef(candidate) {
  const direct = objectValue(candidate?.new_snapshot_ref);
  if (Object.keys(direct).length) return direct;
  const promptRef = objectValue(candidate?.prompt_payload?.new_snapshot_ref);
  return Object.keys(promptRef).length ? promptRef : null;
}

function candidateSnapshotHashes(candidate, ref = candidateSnapshotRef(candidate)) {
  return {
    text_hash: candidate?.new_text_hash || ref?.text_hash || candidate?.prompt_payload?.hashes?.new_text_hash || null,
    image_hash: candidate?.new_image_hash || ref?.image_hash || candidate?.prompt_payload?.hashes?.new_image_hash || null,
    file_hash: candidate?.new_file_hash || ref?.file_hash || candidate?.prompt_payload?.hashes?.new_file_hash || null,
  };
}

export function captureFromVisualReviewCandidate(candidate, archiveRoot) {
  const ref = candidateSnapshotRef(candidate) || {};
  const paths = objectValue(ref.local_paths);
  const metaPath = resolvePathRef(paths.meta, archiveRoot);
  const meta = readJsonIfExists(metaPath) || {};
  const metaFiles = objectValue(meta.files);
  const sectionsJsonPath = resolvePathRef(
    metaFiles.sections_json ? { archive_relative: metaFiles.sections_json } : null,
    archiveRoot,
  );
  const sectionsDocument = readJsonValueIfExists(sectionsJsonPath);
  const expandableSections = Array.isArray(meta.expandable_sections)
    ? meta.expandable_sections
    : Array.isArray(sectionsDocument)
      ? sectionsDocument
      : Array.isArray(sectionsDocument?.sections)
        ? sectionsDocument.sections
        : [];
  const candidateScope =
    candidate?.deterministic_diff?.candidate_scope ||
    candidate?.prompt_payload?.deterministic_diff?.candidate_scope ||
    null;
  const candidateHashes = candidateSnapshotHashes(candidate, ref);
  const hashes = candidateScope === "expandable_section"
    ? {
        text_hash: meta.text_hash || candidateHashes.text_hash,
        image_hash: meta.image_hash || candidateHashes.image_hash,
        file_hash: meta.file_hash || candidateHashes.file_hash,
      }
    : {
        text_hash: candidateHashes.text_hash || meta.text_hash || null,
        image_hash: candidateHashes.image_hash || meta.image_hash || null,
        file_hash: candidateHashes.file_hash || meta.file_hash || null,
      };
  return {
    ...meta,
    kind: cleanText(ref.kind || meta.kind) || (resolvePathRef(paths.pdf, archiveRoot) ? "pdf" : "webpage"),
    captured_at: ref.captured_at || meta.captured_at || null,
    final_url: ref.final_url || meta.final_url || null,
    page_title: ref.page_title || meta.page_title || null,
    text_hash: hashes.text_hash,
    image_hash: hashes.image_hash,
    file_hash: hashes.file_hash,
    dir: resolvePathRef(ref.capture_dir, archiveRoot),
    page_path: resolvePathRef(paths.page, archiveRoot),
    thumb_path: resolvePathRef(paths.thumb, archiveRoot),
    pdf_path: resolvePathRef(paths.pdf, archiveRoot),
    text_path: resolvePathRef(paths.text, archiveRoot),
    meta_path: metaPath,
    expansion_text_path: resolvePathRef(
      metaFiles.expansion_text ? { archive_relative: metaFiles.expansion_text } : null,
      archiveRoot,
    ),
    sections_text_path: resolvePathRef(
      metaFiles.sections_text ? { archive_relative: metaFiles.sections_text } : null,
      archiveRoot,
    ),
    sections_json_path: sectionsJsonPath,
    expandable_sections: expandableSections,
  };
}

function buildBaseline({ candidate, source, capture, archiveRoot, existingBaseline, now }) {
  const existingSummary = objectValue(existingBaseline?.summary_metadata);
  const sourceMetadata = {
    id: source.id,
    shared_award_id: source.shared_award_id || null,
    award_name: source.award_name || source.shared_awards?.name || null,
    title: source.title || null,
    url: source.url || null,
    page_type: source.page_type || null,
  };
  return {
    version: 1,
    kind: capture.kind || "webpage",
    capture_behavior_version: capture.capture_behavior_version || null,
    capture_behavior_name: capture.capture_behavior_name || null,
    capture_profile: capture.capture_profile || null,
    section_extraction_profile: capture.section_extraction_profile || null,
    source: sourceMetadata,
    captured_at: capture.captured_at,
    final_url: capture.final_url,
    page_title: capture.page_title,
    text_hash: capture.text_hash || null,
    body_text_hash: capture.body_text_hash || null,
    main_content_hash: capture.main_content_hash || null,
    nav_header_footer_hash: capture.nav_header_footer_hash || null,
    expansion_hash: capture.expansion_hash || null,
    expandable_sections_hash: capture.expandable_sections_hash || null,
    image_hash: capture.image_hash || null,
    file_hash: capture.file_hash || null,
    file_bytes: capture.file_bytes || null,
    text_length: capture.text_length || null,
    body_text_length: capture.body_text_length || null,
    main_content_text_length: capture.main_content_text_length || null,
    nav_header_footer_text_length: capture.nav_header_footer_text_length || null,
    expansion_text_length: capture.expansion_text_length || null,
    section_text_length: capture.section_text_length || null,
    expandable_sections: Array.isArray(capture.expandable_sections) ? capture.expandable_sections : [],
    dimensions: capture.dimensions || null,
    hidden_noise_counts: capture.hidden_noise_counts || null,
    capture: {
      dir: archiveRelative(capture.dir, archiveRoot),
      page: archiveRelative(capture.page_path, archiveRoot),
      thumb: archiveRelative(capture.thumb_path, archiveRoot),
      pdf: archiveRelative(capture.pdf_path, archiveRoot),
      text: archiveRelative(capture.text_path, archiveRoot),
      expansion_text: archiveRelative(capture.expansion_text_path, archiveRoot),
      sections_text: archiveRelative(capture.sections_text_path, archiveRoot),
      sections_json: archiveRelative(capture.sections_json_path, archiveRoot),
      meta: archiveRelative(capture.meta_path, archiveRoot),
    },
    summary_metadata: {
      reason: "batch_approved_true_change",
      updated_at: now,
      ai_provider: "gemini_batch",
      ai_model: candidate?.model || null,
      previous_baseline: existingBaseline
        ? {
            captured_at: existingBaseline.captured_at || null,
            text_hash: existingBaseline.text_hash || null,
            body_text_hash: existingBaseline.body_text_hash || null,
            main_content_hash: existingBaseline.main_content_hash || null,
            nav_header_footer_hash: existingBaseline.nav_header_footer_hash || null,
            expansion_hash: existingBaseline.expansion_hash || null,
            expandable_sections_hash: existingBaseline.expandable_sections_hash || null,
            image_hash: existingBaseline.image_hash || null,
            file_hash: existingBaseline.file_hash || null,
            capture: existingBaseline.capture || null,
          }
        : null,
      previous_baseline_capture: existingBaseline?.capture || null,
      baseline_facts: capture.baseline_facts || existingSummary.baseline_facts || null,
      baseline_facts_metadata:
        capture.baseline_facts_metadata || existingSummary.baseline_facts_metadata || null,
      approved_visual_candidate_id: candidate?.id || null,
      promotion_scope: "whole_page",
      approved_candidate_scope:
        candidate?.deterministic_diff?.candidate_scope ||
        candidate?.prompt_payload?.deterministic_diff?.candidate_scope ||
        "whole_page",
    },
  };
}

function resolvePathRef(value, archiveRoot) {
  const ref = typeof value === "string" ? { path: value } : objectValue(value);
  const direct = cleanText(ref.path);
  if (direct && isAbsolute(direct)) return direct;
  const archive = cleanText(ref.archive_relative || direct);
  return archive ? resolve(archiveRoot, archive) : null;
}

function archiveRelative(path, archiveRoot) {
  if (!path) return null;
  return relative(resolve(archiveRoot), resolve(path));
}

function captureFiles(capture) {
  return r2Slots
    .map((slot) => ({
      ...slot,
      path: {
        page: capture.page_path,
        thumb: capture.thumb_path,
        pdf: capture.pdf_path,
        text: capture.text_path,
        meta: capture.meta_path,
      }[slot.name],
    }))
    .filter((file) => file.path && existsSync(file.path));
}

function captureHashes(capture) {
  return {
    image_hash: capture.image_hash || null,
    text_hash: capture.text_hash || null,
    body_text_hash: capture.body_text_hash || null,
    main_content_hash: capture.main_content_hash || null,
    nav_header_footer_hash: capture.nav_header_footer_hash || null,
    expansion_hash: capture.expansion_hash || null,
    file_hash: capture.file_hash || null,
  };
}

function captureMetadata(capture) {
  return {
    capture_profile: capture.capture_profile || null,
    final_url: capture.final_url || null,
    page_title: capture.page_title || null,
    status_code: capture.status_code || null,
    status_text: capture.status_text || null,
    content_type: capture.content_type || null,
    text_length: capture.text_length || 0,
    body_text_length: capture.body_text_length || 0,
    main_content_text_length: capture.main_content_text_length || 0,
    nav_header_footer_text_length: capture.nav_header_footer_text_length || 0,
    expansion_text_length: capture.expansion_text_length || 0,
    file_bytes: capture.file_bytes || null,
    page_bytes: capture.page_bytes || null,
    thumb_bytes: capture.thumb_bytes || null,
    dimensions: capture.dimensions || null,
    page_count: capture.page_count || null,
    baseline_facts: capture.baseline_facts || null,
    baseline_facts_metadata: capture.baseline_facts_metadata || null,
    localization: capture.localization || null,
    promoted_by: "process-visual-review-batch",
  };
}

export function approvedR2SnapshotVersion({ candidate, capture } = {}) {
  const identity = JSON.stringify({
    candidate_id: cleanText(candidate?.id) || null,
    captured_at: cleanText(capture?.captured_at) || null,
    hashes: captureHashes(capture),
  });
  return createHash("sha256").update(identity).digest("hex").slice(0, 32);
}

function approvedR2SnapshotKey(sourceId, version, fileName) {
  return `visual-snapshots/sources/${sourceId}/approved/${version}/${fileName}`;
}

function sameSnapshotHashes(value, expected) {
  const actual = objectValue(value);
  const compared = ["text_hash", "image_hash", "file_hash"].filter(
    (key) => cleanText(expected?.[key]),
  );
  return Boolean(compared.length) && compared.every(
    (key) => cleanText(actual[key]) === cleanText(expected[key]),
  );
}

function timestampValue(value) {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function readJsonIfExists(path) {
  return objectValue(readJsonValueIfExists(path));
}

function readJsonValueIfExists(path) {
  if (!path || !existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function cleanText(value) {
  return String(value || "").trim();
}
