import { DeleteObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { atomicWriteJson } from "./visual-baseline-lock.mjs";
import { verifyVisualTextGeometryBinding } from "./visual-event-localization.mjs";
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
  { name: "layout", fileName: "layout.json", contentType: "application/json; charset=utf-8" },
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
    ? captureHashes(snapshot)
    : candidateSnapshotHashes(candidate, ref);
  if (!ref || !Object.values(hashes).some(Boolean)) {
    return { promote: false, reason: "missing_approved_snapshot_reference" };
  }
  if (sameSnapshotHashes(existingBaseline, hashes)) {
    return { promote: false, reason: "approved_snapshot_already_current", already_current: true };
  }
  const existingCapturedAt = timestampValue(existingBaseline?.captured_at);
  const candidateCapturedAt = timestampValue(snapshot?.captured_at || ref.captured_at);
  const repairsMissingGeometry = canRepairMissingGeometry(existingBaseline, hashes);
  if (existingCapturedAt && candidateCapturedAt && existingCapturedAt > candidateCapturedAt) {
    return { promote: false, reason: "newer_whole_page_baseline_exists" };
  }
  if (
    existingCapturedAt &&
    candidateCapturedAt &&
    existingCapturedAt === candidateCapturedAt &&
    !sameSnapshotHashes(existingBaseline, hashes) &&
    !repairsMissingGeometry
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
  const requiredPaths = requiredCapturePaths(capture);
  const missingPaths = requiredPaths.filter((path) => !path || !existsSync(path));
  if (missingPaths.length) {
    return {
      promoted: false,
      reason: "approved_snapshot_files_missing",
      baseline_path: baselinePath,
      missing_paths: missingPaths,
    };
  }
  const missingGeometryMetadata = missingApprovedGeometryMetadata(capture);
  if (missingGeometryMetadata.length) {
    return {
      promoted: false,
      reason: "approved_snapshot_geometry_metadata_missing",
      baseline_path: baselinePath,
      missing_metadata: missingGeometryMetadata,
    };
  }
  verifyApprovedCaptureArtifacts(capture);

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
    const requiredSlots = requiredR2Slots(capture);
    const existingKeys = objectValue(existing?.latest_object_keys);
    const hashesCurrent = sameSnapshotHashes(existing?.latest_hashes, candidateHashes);
    const existingPointerComplete = requiredSlots.every((slot) => cleanText(existingKeys[slot]));
    if (hashesCurrent && existingPointerComplete) {
      return { promoted: false, reason: "approved_r2_snapshot_already_current", already_current: true };
    }
    const existingCapturedAt = timestampValue(existing?.latest_captured_at);
    const candidateCapturedAt = timestampValue(capture.captured_at);
    const repairsMissingGeometry =
      sameCoreSnapshotHashes(existing?.latest_hashes, candidateHashes) &&
      (!existingPointerComplete || canRepairMissingGeometry(existing?.latest_hashes, candidateHashes));
    if (
      existingCapturedAt && candidateCapturedAt &&
      (existingCapturedAt > candidateCapturedAt ||
        (existingCapturedAt === candidateCapturedAt && !hashesCurrent && !repairsMissingGeometry))
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
    const missingGeometryMetadata = missingApprovedGeometryMetadata(capture);
    if (missingGeometryMetadata.length) {
      return {
        promoted: false,
        reason: "approved_snapshot_geometry_metadata_missing",
        missing_metadata: missingGeometryMetadata,
      };
    }
    const verifiedArtifacts = verifyApprovedCaptureArtifacts(capture);
    const immutableVersion = approvedR2SnapshotVersion({ candidate, capture });
    const latestObjectKeys = {};
    for (const file of files) {
      const key = approvedR2SnapshotKey(source.id, immutableVersion, file.fileName);
      const body = verifiedArtifacts.get(file.name)?.body;
      if (!body) {
        throw new Error(`Approved snapshot artifact ${file.name} was not retained after verification.`);
      }
      await client.send(new PutObjectCommand({
        Bucket: config.bucket,
        Key: key,
        Body: body,
        ContentType: file.contentType,
        Metadata: { sha256: createHash("sha256").update(body).digest("hex") },
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
  const safeArchiveRoot = resolveArchiveRoot(archiveRoot);
  const ref = candidateSnapshotRef(candidate) || {};
  const paths = objectValue(ref.local_paths);
  const metaPath = resolvePathRef(paths.meta, safeArchiveRoot);
  const meta = readJsonIfExists(metaPath) || {};
  const metaFiles = objectValue(meta.files);
  const sectionsJsonPath = resolveArchiveFile(metaFiles.sections_json, safeArchiveRoot);
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
  const layoutPath = resolvePathRef(paths.layout, safeArchiveRoot) || resolveArchiveFile(metaFiles.layout, safeArchiveRoot);
  const expansionStateScreenshots = approvedExpansionStates({
    ref,
    meta,
    metaFiles,
    archiveRoot: safeArchiveRoot,
  });
  const mainState = Array.isArray(ref.visual_states)
    ? objectValue(ref.visual_states.find((state) => cleanText(state?.kind) === "main"))
    : {};
  const mainStatePaths = objectValue(mainState.local_paths);
  const artifactBindings = {
    page: artifactBinding(paths.page || mainStatePaths.image),
    thumb: artifactBinding(paths.thumb),
    pdf: artifactBinding(paths.pdf),
    text: artifactBinding(paths.text),
    layout: artifactBinding(paths.layout || mainStatePaths.layout),
    meta: artifactBinding(paths.meta),
  };
  for (const [index, state] of expansionStateScreenshots.entries()) {
    const suffix = String(index + 1).padStart(2, "0");
    artifactBindings[`expansion_state_${suffix}`] = state.page_artifact || null;
    artifactBindings[`expansion_state_${suffix}_layout`] = state.layout_artifact || null;
  }
  return {
    ...meta,
    kind: cleanText(ref.kind || meta.kind) || (resolvePathRef(paths.pdf, safeArchiveRoot) ? "pdf" : "webpage"),
    captured_at: ref.captured_at || meta.captured_at || null,
    final_url: ref.final_url || meta.final_url || null,
    page_title: ref.page_title || meta.page_title || null,
    text_hash: hashes.text_hash,
    image_hash: hashes.image_hash,
    layout_hash:
      cleanText(ref.layout_hash || meta.layout_hash || ref.metadata?.text_geometry?.geometry_hash) || null,
    file_hash: hashes.file_hash,
    text_geometry: meta.text_geometry || ref.metadata?.text_geometry || null,
    localization: meta.localization || ref.metadata?.localization || null,
    archive_root: safeArchiveRoot,
    artifact_bindings: artifactBindings,
    dir: resolvePathRef(ref.capture_dir, safeArchiveRoot, { kind: "directory" }),
    page_path: resolvePathRef(paths.page, safeArchiveRoot),
    thumb_path: resolvePathRef(paths.thumb, safeArchiveRoot),
    pdf_path: resolvePathRef(paths.pdf, safeArchiveRoot),
    text_path: resolvePathRef(paths.text, safeArchiveRoot),
    layout_path: layoutPath,
    meta_path: metaPath,
    expansion_text_path: resolveArchiveFile(metaFiles.expansion_text, safeArchiveRoot),
    sections_text_path: resolveArchiveFile(metaFiles.sections_text, safeArchiveRoot),
    sections_json_path: sectionsJsonPath,
    expandable_sections: expandableSections,
    expansion_state_screenshots: expansionStateScreenshots,
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
    layout_hash: capture.layout_hash || capture.text_geometry?.geometry_hash || null,
    expansion_states_hash: approvedExpansionStatesHash(capture),
    file_hash: capture.file_hash || null,
    text_geometry: capture.text_geometry || null,
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
      layout: archiveRelative(capture.layout_path, archiveRoot),
      expansion_text: archiveRelative(capture.expansion_text_path, archiveRoot),
      sections_text: archiveRelative(capture.sections_text_path, archiveRoot),
      sections_json: archiveRelative(capture.sections_json_path, archiveRoot),
      meta: archiveRelative(capture.meta_path, archiveRoot),
      expansion_states: approvedExpansionStateMetadata(capture, archiveRoot),
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

function resolveArchiveRoot(archiveRoot) {
  const configuredRoot = cleanText(archiveRoot);
  if (!configuredRoot) {
    throw new Error("Approved snapshot archive root is required.");
  }
  const root = resolve(configuredRoot);
  let rootStats;
  try {
    rootStats = lstatSync(root);
  } catch (error) {
    throw new Error(`Approved snapshot archive root is unavailable at ${root}: ${error.message}`);
  }
  if (rootStats.isSymbolicLink()) {
    throw new Error(`Approved snapshot archive root must not be a symbolic link: ${root}`);
  }
  if (!rootStats.isDirectory()) {
    throw new Error(`Approved snapshot archive root is not a directory: ${root}`);
  }
  return realpathSync(root);
}

function resolvePathRef(value, archiveRoot, { kind = "file" } = {}) {
  const ref = typeof value === "string" ? { path: value } : objectValue(value);
  if (!Object.keys(ref).length) return null;
  const root = resolveArchiveRoot(archiveRoot);
  const direct = cleanText(ref.path);
  const archive = cleanText(ref.archive_relative);

  if (direct && isAbsolute(direct)) {
    const absoluteDirect = resolve(direct);
    if (pathEntryExists(absoluteDirect)) {
      return validateArchivePath(absoluteDirect, root, { kind, mustExist: true });
    }
    // Absolute paths are machine-local hints. When an archive-relative key was
    // retained, it is authoritative and survives a moved/re-hydrated archive.
    if (!archive) {
      return validateArchivePath(absoluteDirect, root, { kind, mustExist: false });
    }
  }

  const archivePath = archive || direct;
  if (!archivePath) return null;
  if (isAbsolute(archivePath)) {
    throw new Error(`Approved snapshot archive-relative path must be relative: ${archivePath}`);
  }
  return validateArchivePath(resolve(root, archivePath), root, {
    kind,
    mustExist: pathEntryExists(resolve(root, archivePath)),
  });
}

function archiveRelative(path, archiveRoot) {
  if (!path) return null;
  const root = resolveArchiveRoot(archiveRoot);
  const entryExists = pathEntryExists(path);
  const safePath = validateArchivePath(path, root, {
    kind: entryExists && lstatSync(path).isDirectory() ? "directory" : "file",
    mustExist: entryExists,
  });
  return relative(root, safePath).split(sep).join("/");
}

function resolveArchiveFile(path, archiveRoot) {
  if (!path) return null;
  return resolvePathRef(
    isAbsolute(cleanText(path)) ? { path } : { archive_relative: path },
    archiveRoot,
  );
}

function validateArchivePath(path, archiveRoot, { kind = "file", mustExist = true } = {}) {
  const root = resolveArchiveRoot(archiveRoot);
  const candidate = resolve(path);
  if (!pathIsWithin(candidate, root)) {
    throw new Error(`Approved snapshot artifact resolves outside the archive root: ${candidate}`);
  }
  assertNoSymlinkComponents(candidate, root);
  if (!pathEntryExists(candidate)) {
    if (mustExist) {
      throw new Error(`Approved snapshot artifact is unavailable at ${candidate}`);
    }
    return candidate;
  }
  const stats = lstatSync(candidate);
  if (stats.isSymbolicLink()) {
    throw new Error(`Approved snapshot artifact must not be a symbolic link: ${candidate}`);
  }
  if (kind === "directory" ? !stats.isDirectory() : !stats.isFile()) {
    throw new Error(`Approved snapshot ${kind} has the wrong filesystem type: ${candidate}`);
  }
  const real = realpathSync(candidate);
  if (!pathIsWithin(real, root)) {
    throw new Error(`Approved snapshot artifact resolves outside the archive root: ${candidate}`);
  }
  return real;
}

function pathIsWithin(path, root) {
  const pathFromRoot = relative(root, path);
  return pathFromRoot === "" || (
    pathFromRoot !== ".." &&
    !pathFromRoot.startsWith(`..${sep}`) &&
    !isAbsolute(pathFromRoot)
  );
}

function assertNoSymlinkComponents(path, archiveRoot) {
  const pathFromRoot = relative(archiveRoot, path);
  let cursor = archiveRoot;
  for (const segment of pathFromRoot.split(sep).filter(Boolean)) {
    cursor = join(cursor, segment);
    if (!pathEntryExists(cursor)) break;
    if (lstatSync(cursor).isSymbolicLink()) {
      throw new Error(`Approved snapshot artifact path contains a symbolic link: ${cursor}`);
    }
  }
}

function pathEntryExists(path) {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function artifactBinding(value) {
  const ref = objectValue(value);
  if (!Object.keys(ref).length) return null;
  const byteLength = Number(ref.byte_length ?? ref.bytes);
  return {
    sha256: cleanText(ref.sha256).toLowerCase() || null,
    byte_length: Number.isSafeInteger(byteLength) && byteLength >= 0 ? byteLength : null,
  };
}

function approvedExpansionStates({ ref, meta, metaFiles, archiveRoot }) {
  const referencedStates = Array.isArray(ref.visual_states)
    ? ref.visual_states.filter((state) => cleanText(state?.kind) !== "main")
    : [];
  const metadataStates = Array.isArray(meta.expansion_state_screenshots)
    ? meta.expansion_state_screenshots
    : [];
  const fileStates = Array.isArray(metaFiles.expansion_states)
    ? metaFiles.expansion_states
    : [];
  const primaryStates = referencedStates.length
    ? referencedStates
    : metadataStates.length
      ? metadataStates
      : fileStates;
  return primaryStates.map((primary, index) => {
    const stateId = cleanText(primary?.state_id) || null;
    const referenced = stateByIdentity(referencedStates, stateId, index);
    const metadata = stateByIdentity(metadataStates, stateId, index);
    const files = stateByIdentity(fileStates, stateId, index);
    const referencedPaths = objectValue(referenced.local_paths);
    const pagePath =
      resolvePathRef(referencedPaths.image, archiveRoot) ||
      resolveArchiveFile(metadata.page || files.page, archiveRoot);
    const layoutPath =
      resolvePathRef(referencedPaths.layout, archiveRoot) ||
      resolveArchiveFile(metadata.layout || files.layout, archiveRoot);
    const geometry = objectValue(metadata.text_geometry);
    return {
      ...metadata,
      state_id: cleanText(referenced.state_id || metadata.state_id || files.state_id) || null,
      index: Number.isFinite(Number(metadata.index ?? referenced.index))
        ? Number(metadata.index ?? referenced.index)
        : index,
      label: cleanText(referenced.label || metadata.label || files.label) || null,
      captured_at:
        cleanText(metadata.captured_at || referenced.metadata?.captured_at || ref.captured_at) || null,
      image_hash: cleanText(referenced.image_hash || metadata.image_hash) || null,
      layout_hash:
        cleanText(referenced.geometry_hash || metadata.layout_hash || geometry.geometry_hash) || null,
      page_path: pagePath,
      layout_path: layoutPath,
      page_artifact: artifactBinding(referencedPaths.image),
      layout_artifact: artifactBinding(referencedPaths.layout),
      text_geometry: Object.keys(geometry).length ? geometry : null,
    };
  });
}

function stateByIdentity(states, stateId, index) {
  const byId = stateId
    ? states.find((state) => cleanText(state?.state_id) === stateId)
    : null;
  return objectValue(byId || states[index]);
}

function approvedExpansionStateValues(capture) {
  return Array.isArray(capture?.expansion_state_screenshots)
    ? capture.expansion_state_screenshots
    : [];
}

function approvedExpansionStateMetadata(capture, archiveRoot) {
  return approvedExpansionStateValues(capture).map((state, index) => ({
    state_id: state.state_id || null,
    index: Number.isFinite(Number(state.index)) ? Number(state.index) : index,
    label: state.label || null,
    captured_at: state.captured_at || capture.captured_at || null,
    image_hash: state.image_hash || null,
    layout_hash: state.layout_hash || state.text_geometry?.geometry_hash || null,
    text_geometry: state.text_geometry || null,
    text_hash: state.text_hash || null,
    text_length: state.text_length ?? null,
    page_bytes: state.page_bytes ?? null,
    isolation: state.isolation || null,
    page: archiveRelative(state.page_path, archiveRoot),
    layout: archiveRelative(state.layout_path, archiveRoot),
  }));
}

function approvedExpansionStatesHash(capture) {
  const identity = approvedExpansionStateValues(capture).map((state, index) => ({
    state_id: cleanText(state.state_id) || null,
    index: Number.isFinite(Number(state.index)) ? Number(state.index) : index,
    image_hash: cleanText(state.image_hash) || null,
    layout_hash: cleanText(state.layout_hash || state.text_geometry?.geometry_hash) || null,
  }));
  return identity.length
    ? createHash("sha256").update(JSON.stringify(identity)).digest("hex")
    : null;
}

function requiredCapturePaths(capture) {
  if (capture.kind === "pdf") {
    return [capture.pdf_path, capture.text_path, capture.meta_path];
  }
  return [
    capture.page_path,
    capture.thumb_path,
    capture.text_path,
    capture.layout_path,
    capture.meta_path,
    ...approvedExpansionStateValues(capture).flatMap((state) => [state.page_path, state.layout_path]),
  ];
}

function requiredR2Slots(capture) {
  if (capture.kind === "pdf") return ["pdf", "text", "meta"];
  return [
    "page",
    "thumb",
    "text",
    "layout",
    "meta",
    ...approvedExpansionStateValues(capture).flatMap((_, index) => {
      const suffix = String(index + 1).padStart(2, "0");
      return [`expansion_state_${suffix}`, `expansion_state_${suffix}_layout`];
    }),
  ];
}

function missingApprovedGeometryMetadata(capture) {
  if (capture.kind === "pdf") {
    return ["file_hash", "text_hash"].filter((field) => !cleanText(capture[field]));
  }
  const missing = ["image_hash", "text_hash"].filter((field) => !cleanText(capture[field]));
  if (!cleanText(capture.layout_hash || capture.text_geometry?.geometry_hash)) {
    missing.push("layout_hash");
  }
  for (const [index, state] of approvedExpansionStateValues(capture).entries()) {
    const prefix = `expansion_state_${String(index + 1).padStart(2, "0")}`;
    if (!cleanText(state.state_id)) missing.push(`${prefix}.state_id`);
    if (!cleanText(state.image_hash)) missing.push(`${prefix}.image_hash`);
    if (!cleanText(state.layout_hash || state.text_geometry?.geometry_hash)) {
      missing.push(`${prefix}.layout_hash`);
    }
  }
  return missing;
}

function captureFiles(capture) {
  const files = r2Slots
    .map((slot) => ({
      ...slot,
      path: {
        page: capture.page_path,
        thumb: capture.thumb_path,
        pdf: capture.pdf_path,
        text: capture.text_path,
        layout: capture.layout_path,
        meta: capture.meta_path,
      }[slot.name],
    }))
    .filter((file) => file.path && pathEntryExists(file.path));
  for (const [index, state] of approvedExpansionStateValues(capture).entries()) {
    const suffix = String(index + 1).padStart(2, "0");
    if (state.page_path && pathEntryExists(state.page_path)) {
      files.push({
        name: `expansion_state_${suffix}`,
        fileName: `expansion-state-${suffix}.jpg`,
        contentType: "image/jpeg",
        path: state.page_path,
      });
    }
    if (state.layout_path && pathEntryExists(state.layout_path)) {
      files.push({
        name: `expansion_state_${suffix}_layout`,
        fileName: `expansion-state-${suffix}-layout.json`,
        contentType: "application/json; charset=utf-8",
        path: state.layout_path,
      });
    }
  }
  return files;
}

function verifyApprovedCaptureArtifacts(capture) {
  const archiveRoot = resolveArchiveRoot(capture?.archive_root);
  const files = captureFiles(capture);
  const filesByName = new Map(files.map((file) => [file.name, file]));
  const missingSlots = requiredR2Slots(capture).filter((slot) => !filesByName.has(slot));
  if (missingSlots.length) {
    throw new Error(
      `Approved snapshot artifact verification failed: missing ${missingSlots.join(", ")}.`,
    );
  }

  const bindings = objectValue(capture.artifact_bindings);
  const verified = new Map();
  for (const file of files) {
    const binding = objectValue(bindings[file.name]);
    const declaredSha256 = cleanText(binding.sha256).toLowerCase();
    const declaredByteLength = Number(binding.byte_length ?? binding.bytes);
    if (!isSha256(declaredSha256) || !Number.isSafeInteger(declaredByteLength) || declaredByteLength < 0) {
      throw new Error(
        `Approved snapshot artifact verification failed for ${file.name}: immutable SHA-256 and byte length are required.`,
      );
    }
    const path = validateArchivePath(file.path, archiveRoot, { kind: "file", mustExist: true });
    const body = readFileSync(path);
    const actualSha256 = sha256(body);
    if (body.length !== declaredByteLength) {
      throw new Error(
        `Approved snapshot artifact verification failed for ${file.name}: byte length does not match the retained artifact.`,
      );
    }
    if (actualSha256 !== declaredSha256) {
      throw new Error(
        `Approved snapshot artifact verification failed for ${file.name}: SHA-256 does not match the retained artifact.`,
      );
    }
    verified.set(file.name, {
      body,
      path,
      sha256: actualSha256,
      byte_length: body.length,
    });
  }

  if (capture.kind === "pdf") {
    assertSemanticArtifactHash({
      role: "PDF",
      expected: capture.file_hash,
      actual: verified.get("pdf")?.sha256,
    });
  } else {
    assertSemanticArtifactHash({
      role: "main image",
      expected: capture.image_hash,
      actual: verified.get("page")?.sha256,
    });
    verifyGeometryArtifact({
      role: "main layout",
      body: verified.get("layout")?.body,
      expectedGeometryHash: capture.layout_hash || capture.text_geometry?.geometry_hash,
      expectedImageHash: capture.image_hash,
    });
    for (const [index, state] of approvedExpansionStateValues(capture).entries()) {
      const suffix = String(index + 1).padStart(2, "0");
      assertSemanticArtifactHash({
        role: `expansion state ${state.state_id || suffix} image`,
        expected: state.image_hash,
        actual: verified.get(`expansion_state_${suffix}`)?.sha256,
      });
      verifyGeometryArtifact({
        role: `expansion state ${state.state_id || suffix} layout`,
        body: verified.get(`expansion_state_${suffix}_layout`)?.body,
        expectedGeometryHash: state.layout_hash || state.text_geometry?.geometry_hash,
        expectedImageHash: state.image_hash,
      });
    }
  }

  const textBody = verified.get("text")?.body;
  let storedText;
  try {
    storedText = new TextDecoder("utf-8", { fatal: true }).decode(textBody);
  } catch (error) {
    throw new Error(`Approved snapshot artifact verification failed for text: invalid UTF-8 (${error.message}).`);
  }
  const semanticText = storedText.replace(/\r?\n$/u, "");
  assertSemanticArtifactHash({
    role: "text",
    expected: capture.text_hash,
    actual: sha256(Buffer.from(semanticText, "utf8")),
  });

  return verified;
}

function verifyGeometryArtifact({ role, body, expectedGeometryHash, expectedImageHash }) {
  const geometryHash = normalizedSha256(expectedGeometryHash);
  const imageHash = normalizedSha256(expectedImageHash);
  if (!geometryHash || !imageHash) {
    throw new Error(
      `Approved snapshot artifact verification failed for ${role}: valid geometry and image hashes are required.`,
    );
  }
  let geometry;
  try {
    geometry = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch (error) {
    throw new Error(
      `Approved snapshot artifact verification failed for ${role}: layout is not valid UTF-8 JSON (${error.message}).`,
    );
  }
  if (normalizedSha256(geometry?.geometry_hash) !== geometryHash) {
    throw new Error(
      `Approved snapshot artifact verification failed for ${role}: geometry hash does not match the layout artifact.`,
    );
  }
  const binding = verifyVisualTextGeometryBinding(geometry, imageHash);
  if (!binding.valid) {
    throw new Error(
      `Approved snapshot artifact verification failed for ${role}: ${binding.reason}.`,
    );
  }
}

function assertSemanticArtifactHash({ role, expected, actual }) {
  const expectedHash = normalizedSha256(expected);
  const actualHash = normalizedSha256(actual);
  if (!expectedHash || !actualHash || expectedHash !== actualHash) {
    throw new Error(
      `Approved snapshot artifact verification failed for ${role}: semantic hash does not match the retained artifact.`,
    );
  }
}

function normalizedSha256(value) {
  const hash = cleanText(value).toLowerCase();
  return isSha256(hash) ? hash : null;
}

function isSha256(value) {
  return /^[a-f0-9]{64}$/u.test(String(value || ""));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function captureHashes(capture) {
  return {
    image_hash: capture.image_hash || null,
    text_hash: capture.text_hash || null,
    body_text_hash: capture.body_text_hash || null,
    main_content_hash: capture.main_content_hash || null,
    nav_header_footer_hash: capture.nav_header_footer_hash || null,
    expansion_hash: capture.expansion_hash || null,
    layout_hash: capture.layout_hash || capture.text_geometry?.geometry_hash || null,
    expansion_states_hash: approvedExpansionStatesHash(capture),
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
    layout_hash: capture.layout_hash || capture.text_geometry?.geometry_hash || null,
    text_geometry: capture.text_geometry || null,
    expansion_state_count: approvedExpansionStateValues(capture).length,
    expansion_state_screenshots: approvedExpansionStateValues(capture).map((state, index) => ({
      state_id: state.state_id || null,
      index: Number.isFinite(Number(state.index)) ? Number(state.index) : index,
      label: state.label || null,
      captured_at: state.captured_at || capture.captured_at || null,
      image_hash: state.image_hash || null,
      layout_hash: state.layout_hash || state.text_geometry?.geometry_hash || null,
      text_geometry: state.text_geometry || null,
      text_hash: state.text_hash || null,
      text_length: state.text_length ?? null,
      page_bytes: state.page_bytes ?? null,
      isolation: state.isolation || null,
    })),
    page_count: capture.page_count || null,
    baseline_facts: capture.baseline_facts || null,
    baseline_facts_metadata: capture.baseline_facts_metadata || null,
    localization: capture.localization || null,
    localization_evidence: capture.kind === "webpage"
      ? {
          status: "exact_geometry_available",
          main_layout_hash: capture.layout_hash || capture.text_geometry?.geometry_hash || null,
          expansion_state_count: approvedExpansionStateValues(capture).length,
        }
      : { status: "not_applicable" },
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
  const compared = [
    "text_hash",
    "image_hash",
    "file_hash",
    "layout_hash",
    "expansion_states_hash",
  ].filter(
    (key) => cleanText(expected?.[key]),
  );
  return Boolean(compared.length) && compared.every(
    (key) => cleanText(actual[key]) === cleanText(expected[key]),
  );
}

function sameCoreSnapshotHashes(value, expected) {
  const actual = objectValue(value);
  const compared = ["text_hash", "image_hash", "file_hash"].filter(
    (key) => cleanText(expected?.[key]),
  );
  return Boolean(compared.length) && compared.every(
    (key) => cleanText(actual[key]) === cleanText(expected[key]),
  );
}

function canRepairMissingGeometry(value, expected) {
  if (!sameCoreSnapshotHashes(value, expected)) return false;
  const actual = objectValue(value);
  return ["layout_hash", "expansion_states_hash"].some(
    (key) => cleanText(expected?.[key]) && !cleanText(actual[key]),
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
