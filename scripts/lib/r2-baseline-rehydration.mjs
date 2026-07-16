import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { GetObjectCommand, HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";

import { atomicWriteJson } from "./visual-baseline-lock.mjs";
import { bindVisualTextGeometry } from "./visual-event-localization.mjs";
import { visualSnapshotArtifactManifest } from "./visual-review-queue.mjs";

const sourceIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab0-9a-f][0-9a-f]{3}-[0-9a-f]{12}$/i;
const sha256Pattern = /^[0-9a-f]{64}$/i;
const immutableVersionPattern = /^[0-9a-f]{32}$/i;
const fixedSlots = {
  page: { fileName: "page.jpg", contentType: "image/jpeg" },
  thumb: { fileName: "thumb.jpg", contentType: "image/jpeg" },
  pdf: { fileName: "document.pdf", contentType: "application/pdf" },
  text: { fileName: "text.txt", contentType: "text/plain" },
  layout: { fileName: "layout.json", contentType: "application/json" },
  meta: { fileName: "meta.json", contentType: "application/json" },
};
const coreHashFields = ["image_hash", "text_hash", "file_hash"];
const initialDocumentArtifactFiles = {
  pdf: "document.pdf",
  text: "text.txt",
  meta: "meta.json",
};

/**
 * Restores only the immutable local artifact paths already sealed into an
 * initial-official-document candidate. R2 bytes must match both the source
 * generation pointer and every candidate artifact SHA/length binding.
 */
export async function restoreInitialOfficialDocumentCandidateArtifactsFromR2({
  archiveRoot,
  source,
  candidate,
  snapshotRecord,
  bucket: bucketValue = null,
  client = null,
  config = null,
  sendCommand = null,
} = {}) {
  let stageDir = null;
  let ownedClient = null;

  try {
    const bucket = String(bucketValue || config?.bucket || "").trim();
    const identity = validateInitialDocumentCandidateRestoreInputs({
      archiveRoot,
      source,
      candidate,
      snapshotRecord,
      bucket,
      client,
      config,
      sendCommand,
    });
    const r2Client = client || createCandidateRestoreR2Client(config);
    if (!client) ownedClient = r2Client;

    validateSnapshotIdentity({
      snapshotRecord,
      source,
      baseline: identity.baseline,
      bucket,
    });
    const generation = selectExactGeneration(snapshotRecord, identity.baseline);
    if (!generation) {
      refuse(
        "exact_r2_generation_unavailable",
        "Neither the latest nor previous R2 generation exactly matches the candidate timestamp and core hashes.",
      );
    }

    const manifest = validateObjectManifest({
      sourceId: source.id,
      kind: "pdf",
      objectKeys: generation.objectKeys,
    });
    const remoteRoles = manifest.entries.map((entry) => entry.slot).sort();
    if (stableJson(remoteRoles) !== stableJson(Object.keys(initialDocumentArtifactFiles).sort())) {
      refuse(
        "candidate_restore_r2_generation_ambiguous",
        "The selected PDF generation contains artifacts outside the candidate-bound restore set.",
      );
    }

    const localState = inspectInitialDocumentCandidateTargets(identity.targets);
    if (!localState.missingRoles.length) {
      return {
        restored: true,
        already_present: true,
        reason: "candidate_artifacts_already_present",
        generation: generation.name,
        family: manifest.family,
        version: manifest.version,
        artifact_count: 0,
        restored_roles: [],
        historical_direct_paths_ignored: identity.targets.historicalDirectPaths,
      };
    }

    const artifacts = await Promise.all(
      manifest.entries.map((entry) => downloadAndValidateArtifact({
        client: r2Client,
        sendCommand,
        bucket,
        entry,
        generation,
      })),
    );
    const artifactBySlot = Object.fromEntries(
      artifacts.map((artifact) => [artifact.entry.slot, artifact]),
    );
    const rawMeta = parseJsonBytes(
      artifactBySlot.meta.body,
      "r2_meta_json_invalid",
      "The R2 generation metadata is not valid JSON.",
    );
    validateDownloadedMeta({
      meta: rawMeta,
      source,
      baseline: identity.baseline,
      generation,
    });
    for (const [role, target] of Object.entries(identity.targets.byRole)) {
      const body = artifactBySlot[role]?.body;
      if (
        !Buffer.isBuffer(body) ||
        body.length !== target.byteLength ||
        !sameHash(sha256(body), target.sha256)
      ) {
        refuse(
          "candidate_restore_r2_artifact_mismatch",
          `The verified R2 ${role} bytes do not match the immutable candidate artifact binding.`,
        );
      }
    }

    ensureInitialDocumentCandidateRestoreDirectories(identity.targets);
    stageDir = join(identity.targets.capturesDir, `.r2-candidate-restore-${randomUUID()}`);
    mkdirSync(stageDir);
    assertSafeCandidateRestoreDirectory(stageDir, identity.targets.archiveRoot);

    for (const role of localState.missingRoles) {
      const target = identity.targets.byRole[role];
      const body = artifactBySlot[role].body;
      const stagedPath = join(stageDir, initialDocumentArtifactFiles[role]);
      writeFileSync(stagedPath, body, { flag: "wx" });
      validateCandidateRestoreFile(stagedPath, target, "candidate_restore_staging_mismatch");
    }

    const restoredRoles = [];
    for (const role of localState.missingRoles) {
      const target = identity.targets.byRole[role];
      const stagedPath = join(stageDir, initialDocumentArtifactFiles[role]);
      assertSafeCandidateRestoreDirectory(identity.targets.captureDir, identity.targets.archiveRoot);
      try {
        // A hard-link publish is atomic and refuses to replace an existing
        // path, so immutable candidate identity cannot be overwritten by a
        // concurrent or stale recovery attempt.
        linkSync(stagedPath, target.path);
        restoredRoles.push(role);
      } catch (error) {
        if (!pathEntryExists(target.path)) {
          refuse(
            "candidate_restore_local_publish_failed",
            `Could not publish the verified ${role} artifact: ${cleanErrorMessage(error)}`,
          );
        }
        validateCandidateRestoreFile(
          target.path,
          target,
          "candidate_restore_target_conflict",
        );
      }
    }

    inspectInitialDocumentCandidateTargets(identity.targets, { requireComplete: true });
    return {
      restored: true,
      already_present: false,
      reason: "exact_candidate_r2_generation_restored",
      generation: generation.name,
      family: manifest.family,
      version: manifest.version,
      artifact_count: restoredRoles.length,
      restored_roles: restoredRoles,
      historical_direct_paths_ignored: identity.targets.historicalDirectPaths,
    };
  } catch (error) {
    return {
      restored: false,
      reason: error?.rehydrationReason || "candidate_r2_restore_failed",
      detail: cleanErrorMessage(error),
    };
  } finally {
    if (stageDir && existsSync(stageDir)) safeRemoveDirectory(stageDir);
    try {
      ownedClient?.destroy?.();
    } catch {
      // The verified local result is independent of client cleanup.
    }
  }
}

function validateInitialDocumentCandidateRestoreInputs({
  archiveRoot,
  source,
  candidate,
  snapshotRecord,
  bucket,
  client,
  config,
  sendCommand,
}) {
  const rootValue = String(archiveRoot || "").trim();
  if (!rootValue) {
    refuse("invalid_candidate_restore_input", "archiveRoot is required.");
  }
  const root = resolve(rootValue);
  let rootStat;
  try {
    rootStat = lstatSync(root);
  } catch {
    refuse("invalid_candidate_restore_input", "archiveRoot does not exist.");
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    refuse("candidate_restore_archive_root_unsafe", "archiveRoot must be a real directory.");
  }
  if (!sourceIdPattern.test(String(source?.id || ""))) {
    refuse("invalid_candidate_restore_input", "source.id must be a UUID.");
  }
  if (!String(candidate?.id || "").trim() || !String(candidate?.candidate_signature || "").trim()) {
    refuse("invalid_candidate_restore_input", "The candidate ID and signature are required.");
  }
  if (candidate?.candidate_scope !== "initial_official_document") {
    refuse(
      "candidate_restore_scope_mismatch",
      "Only initial_official_document candidates can use this recovery path.",
    );
  }
  if (candidate.shared_award_source_id !== source.id) {
    refuse("candidate_restore_source_mismatch", "The candidate belongs to a different source.");
  }
  if (
    source.shared_award_id &&
    candidate.shared_award_id !== source.shared_award_id
  ) {
    refuse("candidate_restore_award_mismatch", "The candidate belongs to a different award.");
  }
  if (!isObject(snapshotRecord)) {
    refuse("r2_snapshot_record_missing", "No R2 snapshot pointer exists for this source.");
  }
  if (!bucket) {
    refuse("invalid_candidate_restore_input", "An R2 bucket is required.");
  }
  if (client && typeof client.send !== "function") {
    refuse("invalid_candidate_restore_input", "The supplied R2 client is invalid.");
  }
  if (!client && !completeR2ClientConfig(config)) {
    refuse("invalid_candidate_restore_input", "Complete R2 credentials are required.");
  }
  if (sendCommand != null && typeof sendCommand !== "function") {
    refuse("invalid_candidate_restore_input", "sendCommand must be a function when supplied.");
  }

  const directRef = objectValue(candidate.new_snapshot_ref);
  const prompt = objectValue(candidate.prompt_payload);
  const promptRef = objectValue(prompt.new_snapshot_ref);
  const ref = Object.keys(directRef).length ? directRef : promptRef;
  if (!Object.keys(ref).length) {
    refuse("candidate_restore_snapshot_ref_missing", "The candidate has no current snapshot reference.");
  }
  if (ref.kind !== "pdf") {
    refuse("candidate_restore_kind_mismatch", "The candidate current snapshot is not a PDF.");
  }
  if (!validTimestamp(ref.captured_at)) {
    refuse("candidate_restore_captured_at_invalid", "The candidate captured_at is invalid.");
  }

  const promptHashes = objectValue(prompt.hashes);
  const fileHash = requireMatchingCandidateRestoreHashes("file_hash", [
    candidate.new_file_hash,
    ref.file_hash,
    promptHashes.new_file_hash,
  ]);
  const textHash = requireMatchingCandidateRestoreHashes("text_hash", [
    candidate.new_text_hash,
    ref.text_hash,
    promptHashes.new_text_hash,
  ]);

  const computedManifest = visualSnapshotArtifactManifest(ref);
  const storedManifest = objectValue(ref.artifact_manifest);
  const computedDigest = String(computedManifest.digest || "").toLowerCase();
  const refDigest = String(ref.artifact_manifest_digest || "").toLowerCase();
  const storedDigest = String(storedManifest.digest || "").toLowerCase();
  const promptDigest = String(promptHashes.new_artifact_manifest_digest || "").toLowerCase();
  const roles = computedManifest.artifacts.map((artifact) => artifact.role).sort();
  if (
    computedManifest.complete !== true ||
    storedManifest.complete !== true ||
    stableJson(roles) !== stableJson(Object.keys(initialDocumentArtifactFiles).sort()) ||
    !sha256Pattern.test(computedDigest) ||
    !sameHash(refDigest, computedDigest) ||
    !sameHash(storedDigest, computedDigest) ||
    !sameHash(promptDigest, computedDigest) ||
    stableJson(storedManifest) !== stableJson(computedManifest)
  ) {
    refuse(
      "candidate_restore_manifest_mismatch",
      "The candidate artifact manifest is incomplete or no longer matches its immutable bindings.",
    );
  }

  const targets = validateInitialDocumentCandidateTargets({
    archiveRoot: root,
    sourceId: source.id,
    ref,
  });
  return {
    ref,
    targets,
    baseline: {
      kind: "pdf",
      captured_at: ref.captured_at,
      file_hash: fileHash,
      text_hash: textHash,
    },
  };
}

function requireMatchingCandidateRestoreHashes(field, values) {
  if (values.some((value) => !sha256Pattern.test(String(value || "")))) {
    refuse(
      "candidate_restore_core_hash_missing",
      `The candidate ${field} bindings are incomplete.`,
    );
  }
  const normalized = values.map((value) => String(value).toLowerCase());
  if (new Set(normalized).size !== 1) {
    refuse(
      "candidate_restore_core_hash_mismatch",
      `The candidate ${field} bindings disagree.`,
    );
  }
  return normalized[0];
}

function validateInitialDocumentCandidateTargets({ archiveRoot, sourceId, ref }) {
  const capturesDir = resolve(archiveRoot, "sources", sourceId, "captures");
  const byRole = {};
  const historicalDirectPaths = {};
  let captureDir = null;

  for (const [role, fileName] of Object.entries(initialDocumentArtifactFiles)) {
    const artifactRef = objectValue(objectValue(ref.local_paths)[role]);
    const archivePath = String(artifactRef.archive_relative || "").trim().replaceAll("\\", "/");
    const byteLength = optionalNonNegativeInteger(artifactRef.byte_length ?? artifactRef.bytes);
    const artifactHash = String(artifactRef.sha256 || "").trim().toLowerCase();
    if (
      !archivePath ||
      isAbsolute(archivePath) ||
      archivePath.split("/").some((part) => !part || part === "." || part === "..") ||
      !sha256Pattern.test(artifactHash) ||
      byteLength === null
    ) {
      refuse(
        "candidate_restore_artifact_ref_invalid",
        `The candidate ${role} artifact reference is incomplete or unsafe.`,
      );
    }
    const targetPath = resolve(archiveRoot, ...archivePath.split("/"));
    if (!pathIsWithin(capturesDir, targetPath) || basename(targetPath) !== fileName) {
      refuse(
        "candidate_restore_artifact_path_unsafe",
        `The candidate ${role} path is outside this source's capture archive.`,
      );
    }
    const targetDir = dirname(targetPath);
    if (captureDir && targetDir !== captureDir) {
      refuse(
        "candidate_restore_capture_directory_mismatch",
        "The candidate artifacts do not share one immutable capture directory.",
      );
    }
    captureDir = targetDir;

    const directPath = String(artifactRef.path || "").trim();
    if (directPath && !isAbsolute(directPath)) {
      refuse(
        "candidate_restore_artifact_path_unsafe",
        `The candidate ${role} direct path is not absolute.`,
      );
    }
    if (directPath && resolve(directPath) !== targetPath) {
      // Absolute paths record where the capture lived on the originating PC;
      // archive_relative is the portable, manifest-bound identity. An old
      // mounted drive must not veto recovery into the configured archive root.
      historicalDirectPaths[role] = directPath;
    }
    byRole[role] = {
      path: targetPath,
      archiveRelative: archivePath,
      sha256: artifactHash,
      byteLength,
    };
  }

  const captureRef = objectValue(ref.capture_dir);
  const captureArchivePath = String(captureRef.archive_relative || "").trim().replaceAll("\\", "/");
  if (
    !captureArchivePath ||
    isAbsolute(captureArchivePath) ||
    captureArchivePath.split("/").some((part) => !part || part === "." || part === "..") ||
    resolve(archiveRoot, ...captureArchivePath.split("/")) !== captureDir
  ) {
    refuse(
      "candidate_restore_capture_directory_mismatch",
      "The candidate capture directory does not bind the artifact target directory.",
    );
  }
  return { archiveRoot, capturesDir, captureDir, byRole, historicalDirectPaths };
}

function inspectInitialDocumentCandidateTargets(targets, { requireComplete = false } = {}) {
  const missingRoles = [];
  for (const [role, target] of Object.entries(targets.byRole)) {
    if (!pathEntryExists(target.path)) {
      missingRoles.push(role);
      continue;
    }
    let stat;
    try {
      stat = lstatSync(target.path);
    } catch {
      refuse("candidate_restore_target_conflict", `The candidate ${role} target could not be inspected.`);
    }
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      !pathIsWithin(realpathSync(targets.archiveRoot), realpathSync(target.path))
    ) {
      refuse("candidate_restore_target_conflict", `The candidate ${role} target is unsafe.`);
    }
    validateCandidateRestoreFile(target.path, target, "candidate_restore_target_conflict");
  }
  if (requireComplete && missingRoles.length) {
    refuse(
      "candidate_restore_local_publish_incomplete",
      `Candidate artifacts remain missing after restore: ${missingRoles.join(", ")}.`,
    );
  }
  return { missingRoles };
}

function validateCandidateRestoreFile(path, target, reason) {
  let stat;
  let body;
  try {
    stat = lstatSync(path);
    body = readFileSync(path);
  } catch {
    refuse(reason, `The candidate artifact could not be read at ${path}.`);
  }
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    body.length !== target.byteLength ||
    !sameHash(sha256(body), target.sha256)
  ) {
    refuse(reason, `The candidate artifact bytes differ at ${path}.`);
  }
}

function ensureInitialDocumentCandidateRestoreDirectories(targets) {
  assertSafeCandidateRestoreDirectory(targets.capturesDir, targets.archiveRoot);
  assertSafeCandidateRestoreDirectory(targets.captureDir, targets.archiveRoot);
  mkdirSync(targets.captureDir, { recursive: true });
  assertSafeCandidateRestoreDirectory(targets.capturesDir, targets.archiveRoot, { requireExists: true });
  assertSafeCandidateRestoreDirectory(targets.captureDir, targets.archiveRoot, { requireExists: true });
}

function assertSafeCandidateRestoreDirectory(
  candidatePath,
  archiveRoot,
  { requireExists = false } = {},
) {
  const root = resolve(archiveRoot);
  const candidate = resolve(candidatePath);
  if (!pathIsWithin(root, candidate)) {
    refuse("candidate_restore_directory_unsafe", "A candidate recovery directory escapes archiveRoot.");
  }
  let cursor = root;
  for (const segment of relative(root, candidate).split(sep).filter(Boolean)) {
    cursor = join(cursor, segment);
    if (!pathEntryExists(cursor)) break;
    const stat = lstatSync(cursor);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      refuse(
        "candidate_restore_directory_unsafe",
        `Candidate recovery path contains a non-directory or symbolic link: ${cursor}.`,
      );
    }
  }
  if (!pathEntryExists(candidate)) {
    if (requireExists) {
      refuse("candidate_restore_directory_unsafe", `Candidate recovery directory is missing: ${candidate}.`);
    }
    return;
  }
  const stat = lstatSync(candidate);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    !pathIsWithin(realpathSync(root), realpathSync(candidate))
  ) {
    refuse("candidate_restore_directory_unsafe", `Candidate recovery directory is unsafe: ${candidate}.`);
  }
}

function completeR2ClientConfig(config) {
  return Boolean(
    config?.endpoint &&
    config?.accessKeyId &&
    config?.secretAccessKey,
  );
}

function createCandidateRestoreR2Client(config) {
  return new S3Client({
    region: "auto",
    endpoint: config.endpoint,
    forcePathStyle: true,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });
}

function pathEntryExists(path) {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Restores the exact R2 generation already named by an incomplete local
 * baseline. The caller must hold the per-source visual-baseline lock.
 */
export async function rehydrateLocalBaselineFromR2({
  archiveRoot,
  source,
  baseline,
  snapshotRecord,
  bucket,
  client,
  sendCommand = null,
  now = new Date().toISOString(),
} = {}) {
  let stageDir = null;
  let sourceStageDir = null;
  let finalDir = null;
  let createdFinalDir = false;
  let baselineCommitted = false;

  try {
    const input = validateInputs({
      archiveRoot,
      source,
      baseline,
      snapshotRecord,
      bucket,
      client,
      sendCommand,
    });
    const sourceDir = join(input.archiveRoot, "sources", source.id);
    const baselinePath = join(sourceDir, "baseline.json");
    const missingLocalBaseline = baseline == null;
    const sourceDirectoryWasMissing = !pathEntryExists(sourceDir);
    let originalBaselineBytes = null;
    let currentBaseline;

    if (missingLocalBaseline) {
      validateMissingLocalBaselineTarget({
        archiveRoot: input.archiveRoot,
        sourceDir,
        baselinePath,
      });
      currentBaseline = authoritativeBaselineIdentityFromSnapshot({
        source,
        snapshotRecord,
      });
    } else {
      validateLocalBaselinePath({
        archiveRoot: input.archiveRoot,
        sourceDir,
        baselinePath,
      });
      originalBaselineBytes = requiredFileBytes(
        baselinePath,
        "local_baseline_missing",
        "The local baseline disappeared before R2 recovery started.",
      );
      currentBaseline = parseJsonBytes(
        originalBaselineBytes,
        "local_baseline_json_invalid",
        "The current local baseline is not valid JSON.",
      );
      if (stableJson(currentBaseline) !== stableJson(baseline)) {
        refuse(
          "local_baseline_changed_before_rehydration",
          "The baseline supplied to recovery is no longer the baseline on disk.",
        );
      }
    }

    validateBaselineIdentity({ baseline: currentBaseline, source });
    validateSnapshotIdentity({ snapshotRecord, source, baseline: currentBaseline, bucket });
    const generation = missingLocalBaseline
      ? selectAuthoritativeLatestGeneration(snapshotRecord, currentBaseline)
      : selectExactGeneration(snapshotRecord, currentBaseline);
    if (!generation) {
      refuse(
        "exact_r2_generation_unavailable",
        missingLocalBaseline
          ? "The authoritative latest R2 generation is incomplete or does not match its own pointer identity."
          : "Neither the latest nor previous R2 generation exactly matches the local baseline timestamp and core hashes.",
      );
    }

    const manifest = validateObjectManifest({
      sourceId: source.id,
      kind: currentBaseline.kind,
      objectKeys: generation.objectKeys,
    });
    const artifacts = await Promise.all(
      manifest.entries.map((entry) => downloadAndValidateArtifact({
        client,
        sendCommand,
        bucket,
        entry,
        generation,
      })),
    );

    const artifactBySlot = Object.fromEntries(
      artifacts.map((artifact) => [artifact.entry.slot, artifact]),
    );
    const rawMeta = parseJsonBytes(
      artifactBySlot.meta.body,
      "r2_meta_json_invalid",
      "The R2 generation metadata is not valid JSON.",
    );
    validateDownloadedMeta({
      meta: rawMeta,
      source,
      baseline: currentBaseline,
      generation,
    });
    validateDownloadedLengthBindings({
      meta: rawMeta,
      baseline: currentBaseline,
      generation,
      artifactBySlot,
      requireComplete: missingLocalBaseline,
    });
    validateDownloadedLayouts({ artifactBySlot, generation });
    if (missingLocalBaseline) {
      validateAuthoritativeLayoutBindings({
        baseline: currentBaseline,
        generation,
        manifest,
        rawMeta,
      });
    }
    const localizationRecovery = assessLocalizationRecovery({
      kind: currentBaseline.kind,
      manifest,
      generation,
      rawMeta,
    });

    const capturesDir = join(sourceDir, "captures");
    const family = manifest.family === "approved" ? "approved" : "capture";
    const localGenerationId = randomUUID().slice(0, 8);
    finalDir = join(
      capturesDir,
      `r2-rehydrated-${family}-${manifest.version}-${localGenerationId}`,
    );

    const localPaths = localArtifactPaths({
      archiveRoot: input.archiveRoot,
      finalDir,
      manifest,
    });
    const sanitizedLayouts = sanitizeDownloadedLayoutArtifacts({
      artifactBySlot,
      localPaths,
      generation,
    });
    const sanitizedMeta = sanitizeDownloadedMeta({
      meta: rawMeta,
      localPaths,
      generation,
      manifest,
      layoutHashes: sanitizedLayouts.hashes,
      localizationRecovery,
    });
    const outputBuffers = new Map(
      artifacts.map((artifact) => [artifact.entry.fileName, artifact.body]),
    );
    for (const [fileName, body] of sanitizedLayouts.buffers) {
      outputBuffers.set(fileName, body);
    }
    outputBuffers.set("meta.json", Buffer.from(`${JSON.stringify(sanitizedMeta, null, 2)}\n`, "utf8"));

    const baselineTemplate = missingLocalBaseline
      ? buildAuthoritativeBaselineFromR2({
          source,
          snapshotRecord,
          generation,
          rawMeta,
        })
      : currentBaseline;
    const rehydratedBaseline = buildRehydratedBaseline({
      baseline: baselineTemplate,
      localPaths,
      rawMeta,
      generation,
      manifest,
      layoutHashes: sanitizedLayouts.hashes,
      localizationRecovery,
      bucket,
      snapshotUpdatedAt: snapshotRecord.updated_at || null,
      now,
      missingLocalBaseline,
    });

    if (missingLocalBaseline && sourceDirectoryWasMissing) {
      const sourcesDir = ensureSafeSourcesDirectory(input.archiveRoot);
      sourceStageDir = join(
        sourcesDir,
        `.r2-source-rehydrate-${source.id}-${randomUUID()}`,
      );
      mkdirSync(sourceStageDir);
      const stagedCaptureDir = join(
        sourceStageDir,
        "captures",
        basename(finalDir),
      );
      mkdirSync(stagedCaptureDir, { recursive: true });
      for (const [fileName, body] of outputBuffers) {
        writeFileSync(join(stagedCaptureDir, fileName), body, { flag: "wx" });
      }
      atomicWriteJson(join(sourceStageDir, "baseline.json"), rehydratedBaseline);
      if (pathEntryExists(sourceDir)) {
        refuse(
          "local_source_directory_conflict",
          "The source directory appeared while its authoritative R2 baseline was being restored.",
        );
      }
      try {
        renameSync(sourceStageDir, sourceDir);
      } catch (error) {
        refuse(
          "local_source_directory_publish_failed",
          `The verified source directory could not be published atomically: ${cleanErrorMessage(error)}`,
        );
      }
      sourceStageDir = null;
      baselineCommitted = true;
    } else {
      mkdirSync(capturesDir, { recursive: true });
      validateLocalCapturesDirectory({
        archiveRoot: input.archiveRoot,
        sourceDir,
        capturesDir,
      });
      stageDir = join(capturesDir, `.r2-rehydrate-${randomUUID()}`);
      mkdirSync(stageDir);

      for (const [fileName, body] of outputBuffers) {
        writeFileSync(join(stageDir, fileName), body, { flag: "wx" });
      }

      if (existsSync(finalDir)) {
        validateExistingTarget(finalDir, outputBuffers);
        rmSync(stageDir, { recursive: true, force: true });
        stageDir = null;
      } else {
        renameSync(stageDir, finalDir);
        stageDir = null;
        createdFinalDir = true;
      }

      if (missingLocalBaseline) {
        if (pathEntryExists(baselinePath)) {
          refuse(
            "local_baseline_appeared_during_rehydration",
            "A local baseline appeared while the authoritative R2 generation was being validated.",
          );
        }
      } else if (!readFileSync(baselinePath).equals(originalBaselineBytes)) {
        refuse(
          "local_baseline_changed_during_rehydration",
          "The local baseline changed while the R2 generation was being validated.",
        );
      }

      atomicWriteJson(baselinePath, rehydratedBaseline);
      baselineCommitted = true;
    }

    return {
      rehydrated: true,
      reason: localizationRecovery.reason,
      generation: generation.name,
      family: manifest.family,
      version: manifest.version,
      artifact_count: outputBuffers.size,
      recovery_scope: localizationRecovery.recovery_scope,
      localization_recovered: localizationRecovery.localization_recovered,
      localization_status: localizationRecovery.status,
      restored_missing_baseline: missingLocalBaseline,
      restored_missing_source_directory: missingLocalBaseline && sourceDirectoryWasMissing,
      baseline: rehydratedBaseline,
      baseline_path: baselinePath,
      capture_dir: finalDir,
    };
  } catch (error) {
    if (stageDir && existsSync(stageDir)) safeRemoveDirectory(stageDir);
    if (sourceStageDir && existsSync(sourceStageDir)) safeRemoveDirectory(sourceStageDir);
    if (createdFinalDir && !baselineCommitted && finalDir && existsSync(finalDir)) {
      safeRemoveDirectory(finalDir);
    }
    return {
      rehydrated: false,
      reason: error?.rehydrationReason || "r2_local_rehydration_failed",
      detail: cleanErrorMessage(error),
    };
  }
}

function validateInputs({ archiveRoot, source, baseline, snapshotRecord, bucket, client, sendCommand }) {
  const root = resolve(String(archiveRoot || "").trim());
  if (!String(archiveRoot || "").trim()) {
    refuse("invalid_rehydration_input", "archiveRoot is required.");
  }
  validateArchiveRoot(root);
  if (!sourceIdPattern.test(String(source?.id || ""))) {
    refuse("invalid_rehydration_input", "source.id must be a UUID.");
  }
  if (baseline != null && !isObject(baseline)) {
    refuse("invalid_rehydration_input", "baseline must be an object when supplied.");
  }
  if (!isObject(snapshotRecord)) {
    refuse("r2_snapshot_record_missing", "No R2 snapshot pointer exists for this source.");
  }
  if (!String(bucket || "").trim()) {
    refuse("invalid_rehydration_input", "bucket is required.");
  }
  if (!client || typeof client.send !== "function") {
    refuse("invalid_rehydration_input", "An R2 client is required.");
  }
  if (sendCommand != null && typeof sendCommand !== "function") {
    refuse("invalid_rehydration_input", "sendCommand must be a function when supplied.");
  }
  return { archiveRoot: root };
}

function authoritativeBaselineIdentityFromSnapshot({ source, snapshotRecord }) {
  const hashes = objectValue(snapshotRecord.latest_hashes);
  return {
    version: 1,
    kind: snapshotRecord.kind,
    source: {
      id: source.id,
      shared_award_id: source.shared_award_id || null,
      url: source.url || null,
    },
    captured_at: snapshotRecord.latest_captured_at,
    image_hash: hashes.image_hash || null,
    text_hash: hashes.text_hash || null,
    file_hash: hashes.file_hash || null,
  };
}

function validateBaselineIdentity({ baseline, source }) {
  if (baseline.source?.id !== source.id) {
    refuse("local_baseline_source_mismatch", "The local baseline belongs to a different source.");
  }
  if (
    source.shared_award_id &&
    baseline.source?.shared_award_id !== source.shared_award_id
  ) {
    refuse("local_baseline_award_mismatch", "The local baseline belongs to a different award.");
  }
  if (!new Set(["webpage", "pdf"]).has(baseline.kind)) {
    refuse("local_baseline_kind_invalid", "The local baseline kind is not recoverable.");
  }
  if (!validTimestamp(baseline.captured_at)) {
    refuse("local_baseline_captured_at_invalid", "The local baseline captured_at is invalid.");
  }
  for (const field of requiredCoreHashes(baseline.kind)) {
    if (!sha256Pattern.test(String(baseline[field] || ""))) {
      refuse("local_baseline_core_hash_invalid", `The local baseline ${field} is missing or invalid.`);
    }
  }
}

function validateSnapshotIdentity({ snapshotRecord, source, baseline, bucket }) {
  if (snapshotRecord.shared_award_source_id !== source.id) {
    refuse("r2_snapshot_source_mismatch", "The R2 pointer belongs to a different source.");
  }
  if (
    source.shared_award_id &&
    snapshotRecord.shared_award_id !== source.shared_award_id
  ) {
    refuse("r2_snapshot_award_mismatch", "The R2 pointer belongs to a different award.");
  }
  if (snapshotRecord.kind !== baseline.kind) {
    refuse("r2_snapshot_kind_mismatch", "The R2 pointer kind differs from the local baseline.");
  }
  if (snapshotRecord.bucket !== bucket) {
    refuse("r2_snapshot_bucket_mismatch", "The R2 pointer names a different bucket.");
  }
}

function selectExactGeneration(snapshotRecord, baseline) {
  for (const name of ["latest", "previous"]) {
    const generation = {
      name,
      capturedAt: snapshotRecord[`${name}_captured_at`],
      objectKeys: objectValue(snapshotRecord[`${name}_object_keys`]),
      hashes: objectValue(snapshotRecord[`${name}_hashes`]),
      metadata: objectValue(snapshotRecord[`${name}_metadata`]),
    };
    if (!Object.keys(generation.objectKeys).length) continue;
    if (!sameTimestamp(generation.capturedAt, baseline.captured_at)) continue;
    if (!coreHashesMatch(generation.hashes, baseline)) continue;
    return generation;
  }
  return null;
}

function selectAuthoritativeLatestGeneration(snapshotRecord, baseline) {
  const generation = {
    name: "latest",
    capturedAt: snapshotRecord.latest_captured_at,
    objectKeys: objectValue(snapshotRecord.latest_object_keys),
    hashes: objectValue(snapshotRecord.latest_hashes),
    metadata: objectValue(snapshotRecord.latest_metadata),
  };
  if (!Object.keys(generation.objectKeys).length) return null;
  if (!sameTimestamp(generation.capturedAt, baseline.captured_at)) return null;
  if (!coreHashesMatch(generation.hashes, baseline)) return null;
  return generation;
}

function coreHashesMatch(hashes, baseline) {
  for (const field of requiredCoreHashes(baseline.kind)) {
    if (!sameHash(hashes[field], baseline[field])) return false;
  }
  for (const field of coreHashFields) {
    if (baseline[field] && hashes[field] && !sameHash(hashes[field], baseline[field])) return false;
  }
  return true;
}

function validateObjectManifest({ sourceId, kind, objectKeys }) {
  const entries = [];
  const keySet = new Set();
  let family = null;
  let version = null;

  for (const [slot, keyValue] of Object.entries(objectKeys)) {
    const key = String(keyValue || "");
    const definition = slotDefinition(slot);
    if (!definition) {
      refuse("r2_object_slot_unknown", `The R2 generation contains an unknown slot: ${slot}.`);
    }
    if (key.includes("\\") || key.includes("..") || /[\u0000-\u001f]/.test(key)) {
      refuse("r2_object_key_not_immutable", `The R2 key for ${slot} is unsafe.`);
    }
    const prefix = `visual-snapshots/sources/${sourceId}/`;
    if (!key.startsWith(prefix)) {
      refuse("r2_object_key_source_mismatch", `The R2 key for ${slot} belongs to another source.`);
    }
    const remainder = key.slice(prefix.length);
    const parts = remainder.split("/");
    if (
      parts.length !== 3 ||
      !new Set(["captures", "approved"]).has(parts[0]) ||
      !immutableVersionPattern.test(parts[1]) ||
      parts[2] !== definition.fileName
    ) {
      refuse("r2_object_key_not_immutable", `The R2 key for ${slot} is not an immutable generation key.`);
    }
    if (family && family !== parts[0]) {
      refuse("r2_generation_mixed_prefixes", "The R2 pointer mixes capture families.");
    }
    if (version && version !== parts[1]) {
      refuse("r2_generation_mixed_prefixes", "The R2 pointer mixes immutable versions.");
    }
    if (keySet.has(key)) {
      refuse("r2_generation_duplicate_key", "The R2 pointer aliases two slots to one object.");
    }
    family = parts[0];
    version = parts[1];
    keySet.add(key);
    entries.push({ slot, key, ...definition });
  }

  const required = kind === "pdf" ? ["pdf", "text", "meta"] : ["page", "thumb", "text", "meta"];
  for (const slot of required) {
    if (!entries.some((entry) => entry.slot === slot)) {
      refuse("r2_generation_incomplete", `The R2 generation is missing required slot ${slot}.`);
    }
  }
  if (kind === "pdf" && entries.some((entry) => entry.slot === "page" || entry.slot === "thumb")) {
    refuse("r2_generation_kind_ambiguous", "A PDF generation also contains webpage image slots.");
  }
  if (kind === "webpage" && entries.some((entry) => entry.slot === "pdf")) {
    refuse("r2_generation_kind_ambiguous", "A webpage generation also contains a PDF slot.");
  }

  entries.sort((left, right) => left.slot.localeCompare(right.slot));
  return { entries, family, version };
}

function assessLocalizationRecovery({ kind, manifest, generation, rawMeta }) {
  if (kind === "pdf") {
    return {
      status: "not_applicable",
      reason: "exact_r2_generation_rehydrated",
      recovery_scope: "baseline_evidence",
      localization_recovered: false,
      main_geometry_available: false,
      expected_expansion_states: 0,
      complete_expansion_states: 0,
      legacy_approved_without_geometry: false,
    };
  }

  const slots = new Set(manifest.entries.map((entry) => entry.slot));
  const mainGeometryAvailable = slots.has("layout");
  const rawStates = Array.isArray(rawMeta.expansion_state_screenshots)
    ? rawMeta.expansion_state_screenshots
    : [];
  const pointerStates = Array.isArray(generation.metadata.expansion_state_screenshots)
    ? generation.metadata.expansion_state_screenshots
    : [];
  const declaredCount = Math.max(
    optionalNonNegativeInteger(generation.metadata.expansion_state_count) || 0,
    rawStates.length,
    pointerStates.length,
    ...manifest.entries
      .map((entry) => entry.expansionIndex || 0),
  );
  let completeExpansionStates = 0;
  for (let index = 1; index <= declaredCount; index += 1) {
    const suffix = String(index).padStart(2, "0");
    if (slots.has(`expansion_state_${suffix}`) && slots.has(`expansion_state_${suffix}_layout`)) {
      completeExpansionStates += 1;
    }
  }
  const expansionGeometryComplete = completeExpansionStates === declaredCount;
  const localizationRecovered = mainGeometryAvailable && expansionGeometryComplete;
  const legacyApprovedWithoutGeometry = manifest.family === "approved" && !mainGeometryAvailable;
  const status = !mainGeometryAvailable
    ? "evidence_only_geometry_unavailable"
    : expansionGeometryComplete
      ? "exact_geometry_available"
      : "evidence_only_expansion_geometry_incomplete";
  const reason = status === "exact_geometry_available"
    ? "exact_r2_generation_rehydrated"
    : status === "evidence_only_geometry_unavailable"
      ? "exact_r2_generation_rehydrated_evidence_only_geometry_unavailable"
      : "exact_r2_generation_rehydrated_evidence_only_expansion_geometry_incomplete";
  return {
    status,
    reason,
    recovery_scope: localizationRecovered
      ? "baseline_and_localization_evidence"
      : "baseline_evidence_only",
    localization_recovered: localizationRecovered,
    main_geometry_available: mainGeometryAvailable,
    expected_expansion_states: declaredCount,
    complete_expansion_states: completeExpansionStates,
    legacy_approved_without_geometry: legacyApprovedWithoutGeometry,
  };
}

function slotDefinition(slot) {
  if (fixedSlots[slot]) return fixedSlots[slot];
  const pageMatch = /^expansion_state_(\d{2})$/.exec(slot);
  if (pageMatch) {
    if (Number(pageMatch[1]) < 1) return null;
    return {
      fileName: `expansion-state-${pageMatch[1]}.jpg`,
      contentType: "image/jpeg",
      expansionIndex: Number(pageMatch[1]),
      expansionKind: "page",
    };
  }
  const layoutMatch = /^expansion_state_(\d{2})_layout$/.exec(slot);
  if (layoutMatch) {
    if (Number(layoutMatch[1]) < 1) return null;
    return {
      fileName: `expansion-state-${layoutMatch[1]}-layout.json`,
      contentType: "application/json",
      expansionIndex: Number(layoutMatch[1]),
      expansionKind: "layout",
    };
  }
  return null;
}

async function downloadAndValidateArtifact({ client, sendCommand, bucket, entry, generation }) {
  let head;
  let object;
  const send = sendCommand || ((createCommand) => client.send(createCommand()));
  try {
    head = await send(
      () => new HeadObjectCommand({ Bucket: bucket, Key: entry.key }),
      `head ${entry.key}`,
    );
    object = await send(
      () => new GetObjectCommand({ Bucket: bucket, Key: entry.key }),
      `get ${entry.key}`,
    );
  } catch (error) {
    refuse("r2_object_download_failed", `Could not download ${entry.slot}: ${cleanErrorMessage(error)}`);
  }
  const body = await bodyBuffer(object?.Body, entry.slot);
  validateObjectResponse({ head, object, body, entry });
  validateArtifactPayload({ body, entry, generation });
  return { entry, body };
}

async function bodyBuffer(body, slot) {
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (body && typeof body.transformToByteArray === "function") {
    return Buffer.from(await body.transformToByteArray());
  }
  if (body && typeof body[Symbol.asyncIterator] === "function") {
    const chunks = [];
    for await (const chunk of body) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
  }
  refuse("r2_object_body_missing", `The downloaded ${slot} object has no readable body.`);
}

function validateObjectResponse({ head, object, body, entry }) {
  for (const length of [head?.ContentLength, object?.ContentLength]) {
    if (length != null && Number(length) !== body.length) {
      refuse("r2_object_length_mismatch", `The downloaded ${entry.slot} byte count differs from R2 metadata.`);
    }
  }
  const contentTypes = [head?.ContentType, object?.ContentType].filter(Boolean);
  for (const value of contentTypes) {
    if (String(value).split(";", 1)[0].trim().toLowerCase() !== entry.contentType) {
      refuse("r2_object_content_type_mismatch", `The downloaded ${entry.slot} content type is unexpected.`);
    }
  }

  const bodySha256 = sha256(body);
  for (const response of [head, object]) {
    const metadataHash = metadataSha256(response?.Metadata);
    if (metadataHash && !sameHash(metadataHash, bodySha256)) {
      refuse("r2_object_sha256_mismatch", `The downloaded ${entry.slot} bytes differ from R2 SHA-256 metadata.`);
    }
    const checksum = String(response?.ChecksumSHA256 || "").trim();
    if (checksum && checksum !== createHash("sha256").update(body).digest("base64")) {
      refuse("r2_object_sha256_mismatch", `The downloaded ${entry.slot} bytes differ from the R2 checksum.`);
    }
    validateUsableEtag(response?.ETag, body, entry.slot);
  }
  if (head?.ETag && object?.ETag && normalizeEtag(head.ETag) !== normalizeEtag(object.ETag)) {
    refuse("r2_object_etag_changed", `The ${entry.slot} object changed between HEAD and GET.`);
  }
}

function validateArtifactPayload({ body, entry, generation }) {
  if (entry.slot === "page") {
    requireBodyHash(body, generation.hashes.image_hash, "page");
    requireExpectedLength(body, generation.metadata.page_bytes, "page");
    return;
  }
  if (entry.slot === "pdf") {
    requireBodyHash(body, generation.hashes.file_hash, "pdf");
    requireExpectedLength(body, generation.metadata.file_bytes, "pdf");
    return;
  }
  if (entry.slot === "thumb") {
    requireExpectedLength(body, generation.metadata.thumb_bytes, "thumb");
    return;
  }
  if (entry.slot === "text") {
    const text = decodeUtf8(body, "r2_text_utf8_invalid");
    const content = text.endsWith("\r\n")
      ? text.slice(0, -2)
      : text.endsWith("\n")
        ? text.slice(0, -1)
        : text;
    if (!sameHash(sha256(Buffer.from(content, "utf8")), generation.hashes.text_hash)) {
      refuse("r2_text_hash_mismatch", "The downloaded text does not match the generation text hash.");
    }
    const expectedLength = optionalNonNegativeInteger(generation.metadata.text_length);
    if (expectedLength != null && content.length !== expectedLength) {
      refuse("r2_text_length_mismatch", "The downloaded text length differs from generation metadata.");
    }
    return;
  }
  if (entry.expansionKind === "page") {
    const expected = expansionMetadata(generation, entry.expansionIndex)?.image_hash;
    if (expected) requireBodyHash(body, expected, entry.slot);
  }
}

function validateDownloadedMeta({ meta, source, baseline, generation }) {
  if (meta.source?.id !== source.id) {
    refuse("r2_meta_source_mismatch", "The downloaded metadata belongs to a different source.");
  }
  if (
    source.shared_award_id &&
    meta.source?.shared_award_id !== source.shared_award_id
  ) {
    refuse("r2_meta_award_mismatch", "The downloaded metadata belongs to a different award.");
  }
  if (meta.kind !== baseline.kind) {
    refuse("r2_meta_kind_mismatch", "The downloaded metadata kind differs from the local baseline.");
  }
  if (!sameTimestamp(meta.captured_at, baseline.captured_at)) {
    refuse("r2_meta_captured_at_mismatch", "The downloaded metadata timestamp differs from the local baseline.");
  }
  for (const field of requiredCoreHashes(baseline.kind)) {
    if (!sameHash(meta[field], baseline[field]) || !sameHash(meta[field], generation.hashes[field])) {
      refuse("r2_meta_core_hash_mismatch", `The downloaded metadata ${field} is not the selected generation.`);
    }
  }
  for (const field of coreHashFields) {
    if (baseline[field] && meta[field] && !sameHash(meta[field], baseline[field])) {
      refuse("r2_meta_core_hash_mismatch", `The downloaded metadata ${field} differs from the local baseline.`);
    }
  }
}

function validateDownloadedLengthBindings({
  meta,
  baseline,
  generation,
  artifactBySlot,
  requireComplete = false,
}) {
  const specifications = baseline.kind === "pdf"
    ? [
        ["file_bytes", "pdf", artifactBySlot.pdf?.body?.length ?? null],
        ["text_length", "text", downloadedTextLength(artifactBySlot.text?.body)],
      ]
    : [
        ["page_bytes", "page", artifactBySlot.page?.body?.length ?? null],
        ["thumb_bytes", "thumb", artifactBySlot.thumb?.body?.length ?? null],
        ["text_length", "text", downloadedTextLength(artifactBySlot.text?.body)],
      ];

  for (const [field, slot, actual] of specifications) {
    const pointerLength = optionalNonNegativeInteger(generation.metadata[field]);
    const metaLength = optionalNonNegativeInteger(meta[field]);
    if (requireComplete && (pointerLength === null || metaLength === null || actual === null)) {
      refuse(
        "r2_authoritative_length_binding_missing",
        `The authoritative R2 ${slot} length is not completely bound by the pointer and metadata.`,
      );
    }
    for (const [label, value] of [["pointer", pointerLength], ["metadata", metaLength]]) {
      if (value !== null && actual !== null && value !== actual) {
        refuse(
          "r2_authoritative_length_binding_mismatch",
          `The authoritative R2 ${slot} ${label} length differs from the downloaded artifact.`,
        );
      }
    }
    if (pointerLength !== null && metaLength !== null && pointerLength !== metaLength) {
      refuse(
        "r2_authoritative_length_binding_mismatch",
        `The authoritative R2 ${slot} pointer and metadata lengths disagree.`,
      );
    }
  }
}

function downloadedTextLength(body) {
  if (!Buffer.isBuffer(body)) return null;
  const text = decodeUtf8(body, "r2_text_utf8_invalid");
  const content = text.endsWith("\r\n")
    ? text.slice(0, -2)
    : text.endsWith("\n")
      ? text.slice(0, -1)
      : text;
  return content.length;
}

function validateDownloadedLayouts({ artifactBySlot, generation }) {
  for (const [slot, artifact] of Object.entries(artifactBySlot)) {
    if (slot !== "layout" && artifact.entry.expansionKind !== "layout") continue;
    const layout = parseJsonBytes(
      artifact.body,
      "r2_layout_json_invalid",
      `The downloaded ${slot} object is not valid JSON.`,
    );
    const expectedLayoutHash = slot === "layout"
      ? generation.hashes.layout_hash || generation.metadata.layout_hash
      : expansionMetadata(generation, artifact.entry.expansionIndex)?.layout_hash;
    if (expectedLayoutHash && !sameHash(layout.geometry_hash, expectedLayoutHash)) {
      refuse("r2_layout_hash_mismatch", `The downloaded ${slot} geometry hash differs from generation metadata.`);
    }
    const expectedImageHash = slot === "layout"
      ? generation.hashes.image_hash
      : expansionMetadata(generation, artifact.entry.expansionIndex)?.image_hash;
    if (
      expectedImageHash &&
      !sameHash(layout.screenshot?.image_hash, expectedImageHash)
    ) {
      refuse("r2_layout_image_mismatch", `The downloaded ${slot} is bound to a different screenshot.`);
    }
  }
}

function validateAuthoritativeLayoutBindings({ baseline, generation, manifest, rawMeta }) {
  if (baseline.kind === "pdf") return;
  const slots = new Set(manifest.entries.map((entry) => entry.slot));
  if (!slots.has("layout")) {
    refuse(
      "r2_authoritative_layout_missing",
      "The authoritative webpage generation has no structured text-layout object.",
    );
  }
  const expectedMainHash = generation.hashes.layout_hash || generation.metadata.layout_hash;
  const metaMainHash = rawMeta.layout_hash || rawMeta.text_geometry?.geometry_hash;
  if (
    !sha256Pattern.test(String(expectedMainHash || "")) ||
    !sameHash(metaMainHash, expectedMainHash)
  ) {
    refuse(
      "r2_authoritative_layout_binding_invalid",
      "The authoritative webpage layout is not hash-bound by both the pointer and metadata.",
    );
  }

  const expansionIndexes = [...new Set(
    manifest.entries
      .map((entry) => entry.expansionIndex)
      .filter((value) => Number.isInteger(value)),
  )];
  for (const index of expansionIndexes) {
    const suffix = String(index).padStart(2, "0");
    if (
      !slots.has(`expansion_state_${suffix}`) ||
      !slots.has(`expansion_state_${suffix}_layout`)
    ) {
      refuse(
        "r2_authoritative_expansion_layout_incomplete",
        `The authoritative expansion state ${suffix} is missing its screenshot or layout pair.`,
      );
    }
    const pointer = expansionMetadata(generation, index);
    if (
      !sha256Pattern.test(String(pointer?.image_hash || "")) ||
      !sha256Pattern.test(String(pointer?.layout_hash || ""))
    ) {
      refuse(
        "r2_authoritative_expansion_layout_binding_invalid",
        `The authoritative expansion state ${suffix} is not hash-bound by the pointer.`,
      );
    }
  }
}

function localArtifactPaths({ archiveRoot, finalDir, manifest }) {
  const bySlot = {};
  for (const entry of manifest.entries) {
    bySlot[entry.slot] = archiveRelative(archiveRoot, join(finalDir, entry.fileName));
  }
  return {
    dir: archiveRelative(archiveRoot, finalDir),
    bySlot,
  };
}

function sanitizeDownloadedMeta({
  meta,
  localPaths,
  generation,
  manifest,
  layoutHashes,
  localizationRecovery,
}) {
  const value = stripLocalPathFields(structuredClone(meta));
  const omittedArtifacts = omittedLocalOnlyArtifacts(meta, manifest);
  const expansionStates = buildExpansionStates({
    meta: value,
    localPaths,
    generation,
    manifest,
    layoutHashes,
  });
  value.files = {
    page: localPaths.bySlot.page || null,
    thumb: localPaths.bySlot.thumb || null,
    pdf: localPaths.bySlot.pdf || null,
    text: localPaths.bySlot.text || null,
    expansion_text: null,
    sections_text: null,
    sections_json: null,
    layout: localPaths.bySlot.layout || null,
    meta: localPaths.bySlot.meta,
    expansion_states: expansionStates.map((state) => ({
      state_id: state.state_id,
      label: state.label,
      page: state.page,
      layout: state.layout,
    })),
  };
  value.text_geometry = localizationRecovery.main_geometry_available
    ? sanitizeGeometry(value.text_geometry, {
        file: localPaths.bySlot.layout || null,
        imageRef: localPaths.bySlot.page || null,
        imageHash: generation.hashes.image_hash || null,
        geometryHash: layoutHashes.layout || value.text_geometry?.geometry_hash || null,
      })
    : null;
  value.layout_hash = localizationRecovery.main_geometry_available
    ? layoutHashes.layout || value.layout_hash || null
    : null;
  if (isObject(value.localization) && layoutHashes.layout) {
    value.localization.geometry_hash = layoutHashes.layout;
  }
  if (!localizationRecovery.localization_recovered) {
    value.localization = {
      ...objectValue(value.localization),
      status: "unavailable",
      unavailable_reason: localizationRecovery.status,
    };
  }
  value.expansion_state_screenshots = expansionStates;
  value.r2_local_rehydration = {
    generation: generation.name,
    immutable_family: manifest.family,
    immutable_version: manifest.version,
    integrity: "verified_before_local_publish",
    recovery_scope: localizationRecovery.recovery_scope,
    localization_status: localizationRecovery.status,
    localization_recovered: localizationRecovery.localization_recovered,
    legacy_approved_without_geometry: localizationRecovery.legacy_approved_without_geometry,
    optional_local_only_artifacts_restored: false,
    omitted_local_only_artifacts: omittedArtifacts,
  };
  assertSanitizedPaths(value, localPaths.dir);
  return value;
}

function buildExpansionStates({ meta, localPaths, generation, manifest, layoutHashes = {} }) {
  const indexes = [...new Set(
    manifest.entries
      .filter((entry) => entry.expansionIndex)
      .map((entry) => entry.expansionIndex),
  )].sort((left, right) => left - right);
  const rawStates = Array.isArray(meta.expansion_state_screenshots)
    ? meta.expansion_state_screenshots
    : [];
  return indexes.map((index) => {
    const suffix = String(index).padStart(2, "0");
    const raw = stripLocalPathFields(objectValue(rawStates[index - 1]));
    const pointer = objectValue(expansionMetadata(generation, index));
    const page = localPaths.bySlot[`expansion_state_${suffix}`] || null;
    const layout = localPaths.bySlot[`expansion_state_${suffix}_layout`] || null;
    const geometryAvailable = Boolean(page && layout);
    return {
      ...raw,
      state_id: raw.state_id || pointer.state_id || null,
      index: optionalNonNegativeInteger(raw.index) ?? index,
      r2_slot_index: index,
      label: raw.label || pointer.label || null,
      captured_at: raw.captured_at || generation.capturedAt || null,
      image_hash: raw.image_hash || pointer.image_hash || null,
      layout_hash: geometryAvailable
        ? layoutHashes[`expansion_state_${suffix}_layout`] ||
          raw.layout_hash ||
          pointer.layout_hash ||
          null
        : null,
      page,
      layout,
      text_geometry: geometryAvailable
        ? sanitizeGeometry(raw.text_geometry || pointer.text_geometry, {
            file: layout,
            imageRef: page,
            imageHash: raw.image_hash || pointer.image_hash || null,
            geometryHash:
              layoutHashes[`expansion_state_${suffix}_layout`] ||
              raw.text_geometry?.geometry_hash ||
              pointer.text_geometry?.geometry_hash ||
              null,
          })
        : null,
    };
  });
}

function sanitizeGeometry(value, { file, imageRef, imageHash, geometryHash }) {
  if (!isObject(value)) return null;
  const geometry = stripLocalPathFields(structuredClone(value));
  geometry.file = file || null;
  if (isObject(geometry.screenshot)) {
    geometry.screenshot.image_ref = imageRef || null;
    if (imageHash) geometry.screenshot.image_hash = imageHash;
  }
  if (geometryHash) geometry.geometry_hash = geometryHash;
  return geometry;
}

function sanitizeDownloadedLayoutArtifacts({ artifactBySlot, localPaths, generation }) {
  const buffers = new Map();
  const hashes = {};
  for (const [slot, artifact] of Object.entries(artifactBySlot)) {
    if (slot !== "layout" && artifact.entry.expansionKind !== "layout") continue;
    const layout = parseJsonBytes(
      artifact.body,
      "r2_layout_json_invalid",
      `The downloaded ${slot} object is not valid JSON.`,
    );
    const suffix = artifact.entry.expansionIndex
      ? String(artifact.entry.expansionIndex).padStart(2, "0")
      : null;
    const pageSlot = suffix ? `expansion_state_${suffix}` : "page";
    const pointer = suffix
      ? expansionMetadata(generation, artifact.entry.expansionIndex)
      : generation.hashes;
    const rebound = bindVisualTextGeometry(stripLocalPathFields(layout), {
      capturedAt: layout.captured_at || generation.capturedAt,
      imageHash: pointer?.image_hash || null,
      imageRef: localPaths.bySlot[pageSlot] || null,
      screenshot: layout.screenshot || null,
    });
    buffers.set(artifact.entry.fileName, Buffer.from(`${JSON.stringify(rebound, null, 2)}\n`, "utf8"));
    hashes[slot] = rebound.geometry_hash;
  }
  return { buffers, hashes };
}

function stripLocalPathFields(value) {
  if (Array.isArray(value)) return value.map(stripLocalPathFields);
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !/(?:^|_)(?:path|paths|dir|directory|image_ref)$/i.test(key))
      .filter(([key]) => key !== "file")
      .map(([key, entry]) => [key, stripLocalPathFields(entry)]),
  );
}

function assertSanitizedPaths(meta, captureDir) {
  const paths = [
    ...Object.entries(objectValue(meta.files))
      .filter(([field, value]) => field !== "expansion_states" && typeof value === "string")
      .map(([, value]) => value),
    ...((Array.isArray(meta.files?.expansion_states) ? meta.files.expansion_states : [])
      .flatMap((state) => [state?.page, state?.layout])
      .filter((value) => typeof value === "string")),
    meta.text_geometry?.file,
    meta.text_geometry?.screenshot?.image_ref,
    ...((Array.isArray(meta.expansion_state_screenshots) ? meta.expansion_state_screenshots : [])
      .flatMap((state) => [
        state?.page,
        state?.layout,
        state?.text_geometry?.file,
        state?.text_geometry?.screenshot?.image_ref,
      ])
      .filter((value) => typeof value === "string")),
  ];
  for (const path of paths.filter((value) => typeof value === "string")) {
    const normalized = path.replaceAll("\\", "/");
    if (
      /^[A-Za-z]:\//.test(normalized) ||
      normalized.startsWith("//") ||
      normalized.split("/").includes("..") ||
      !(normalized === captureDir || normalized.startsWith(`${captureDir}/`))
    ) {
      refuse("sanitized_meta_path_invalid", "A sanitized metadata path escapes the restored capture directory.");
    }
  }
}

function buildAuthoritativeBaselineFromR2({
  source,
  snapshotRecord,
  generation,
  rawMeta,
}) {
  const meta = stripLocalPathFields(structuredClone(rawMeta));
  const hashes = generation.hashes;
  const metadata = generation.metadata;
  return {
    version: optionalNonNegativeInteger(meta.version) || 1,
    kind: snapshotRecord.kind,
    capture_behavior_version: optionalNonNegativeInteger(meta.capture_behavior_version),
    capture_behavior_name: cleanNullableString(meta.capture_behavior_name),
    capture_profile: cleanNullableString(metadata.capture_profile || meta.capture_profile),
    section_extraction_profile: cleanNullableString(
      metadata.section_extraction_profile || meta.section_extraction_profile,
    ),
    source: {
      id: source.id,
      shared_award_id: source.shared_award_id || null,
      url: source.url || snapshotRecord.source_url || null,
      title: source.title || source.display_title || meta.source?.title || null,
    },
    captured_at: generation.capturedAt,
    final_url: cleanNullableString(metadata.final_url || meta.final_url || snapshotRecord.source_url),
    page_title: cleanNullableString(metadata.page_title || meta.page_title),
    text_hash: hashes.text_hash,
    body_text_hash: hashes.body_text_hash || meta.body_text_hash || null,
    main_content_hash: hashes.main_content_hash || meta.main_content_hash || null,
    nav_header_footer_hash: hashes.nav_header_footer_hash || meta.nav_header_footer_hash || null,
    expansion_hash: hashes.expansion_hash || meta.expansion_hash || null,
    expandable_sections_hash:
      hashes.expandable_sections_hash || meta.expandable_sections_hash || null,
    image_hash: hashes.image_hash || null,
    layout_hash: hashes.layout_hash || metadata.layout_hash || meta.layout_hash || null,
    text_geometry: isObject(meta.text_geometry) ? meta.text_geometry : null,
    file_hash: hashes.file_hash || null,
    file_bytes: optionalNonNegativeInteger(metadata.file_bytes ?? meta.file_bytes),
    text_length: optionalNonNegativeInteger(metadata.text_length ?? meta.text_length),
    body_text_length: optionalNonNegativeInteger(
      metadata.body_text_length ?? meta.body_text_length,
    ),
    main_content_text_length: optionalNonNegativeInteger(
      metadata.main_content_text_length ?? meta.main_content_text_length,
    ),
    nav_header_footer_text_length: optionalNonNegativeInteger(
      metadata.nav_header_footer_text_length ?? meta.nav_header_footer_text_length,
    ),
    expansion_text_length: optionalNonNegativeInteger(
      metadata.expansion_text_length ?? meta.expansion_text_length,
    ),
    section_text_length: optionalNonNegativeInteger(
      metadata.section_text_length ?? meta.section_text_length,
    ),
    expandable_sections: Array.isArray(meta.expandable_sections)
      ? meta.expandable_sections
      : [],
    dimensions: isObject(metadata.dimensions)
      ? metadata.dimensions
      : isObject(meta.dimensions)
        ? meta.dimensions
        : null,
    hidden_noise_counts: isObject(meta.hidden_noise_counts) ? meta.hidden_noise_counts : null,
    summary_metadata: {
      reason: "r2_authoritative_local_cache_restore",
      previous_baseline: null,
      previous_baseline_capture: null,
      baseline_facts: isObject(meta.baseline_facts) ? meta.baseline_facts : null,
      baseline_facts_metadata: isObject(meta.baseline_facts_metadata)
        ? meta.baseline_facts_metadata
        : null,
    },
  };
}

function buildRehydratedBaseline({
  baseline,
  localPaths,
  rawMeta,
  generation,
  manifest,
  layoutHashes,
  localizationRecovery,
  bucket,
  snapshotUpdatedAt,
  now,
  missingLocalBaseline = false,
}) {
  const states = buildExpansionStates({
    meta: rawMeta,
    localPaths,
    generation,
    manifest,
    layoutHashes,
  });
  return {
    ...baseline,
    layout_hash: localizationRecovery.main_geometry_available
      ? layoutHashes.layout || baseline.layout_hash || null
      : null,
    text_geometry: localizationRecovery.main_geometry_available
      ? sanitizeGeometry(baseline.text_geometry || rawMeta.text_geometry, {
          file: localPaths.bySlot.layout || null,
          imageRef: localPaths.bySlot.page || null,
          imageHash: baseline.image_hash || null,
          geometryHash: layoutHashes.layout || baseline.text_geometry?.geometry_hash || null,
        })
      : null,
    capture: {
      dir: localPaths.dir,
      page: localPaths.bySlot.page || null,
      thumb: localPaths.bySlot.thumb || null,
      pdf: localPaths.bySlot.pdf || null,
      text: localPaths.bySlot.text,
      expansion_text: null,
      sections_text: null,
      sections_json: null,
      layout: localPaths.bySlot.layout || null,
      meta: localPaths.bySlot.meta,
      expansion_states: states,
    },
    summary_metadata: {
      ...objectValue(baseline.summary_metadata),
      reason: missingLocalBaseline
        ? "r2_authoritative_local_cache_restore"
        : objectValue(baseline.summary_metadata).reason,
      updated_at: now,
      r2_local_rehydration: {
        rehydrated_at: now,
        generation: generation.name,
        immutable_family: manifest.family,
        immutable_version: manifest.version,
        bucket,
        snapshot_updated_at: snapshotUpdatedAt,
        artifact_count: manifest.entries.length,
        integrity: "verified_before_atomic_baseline_repoint",
        recovery_scope: localizationRecovery.recovery_scope,
        localization_status: localizationRecovery.status,
        localization_recovered: localizationRecovery.localization_recovered,
        main_geometry_available: localizationRecovery.main_geometry_available,
        expected_expansion_states: localizationRecovery.expected_expansion_states,
        complete_expansion_states: localizationRecovery.complete_expansion_states,
        legacy_approved_without_geometry: localizationRecovery.legacy_approved_without_geometry,
        remote_layout_hash: generation.hashes.layout_hash || generation.metadata.layout_hash || null,
        omitted_local_only_artifacts: omittedLocalOnlyArtifacts(rawMeta, manifest),
        restored_missing_baseline: missingLocalBaseline,
      },
    },
  };
}

function omittedLocalOnlyArtifacts(meta, manifest) {
  const files = objectValue(meta?.files);
  const omitted = ["expansion_text", "sections_text", "sections_json"]
    .filter((field) => Boolean(files[field]));
  const remoteExpansionPages = manifest.entries.filter(
    (entry) => entry.expansionKind === "page",
  ).length;
  const recordedExpansionStates = Array.isArray(meta?.expansion_state_screenshots)
    ? meta.expansion_state_screenshots.length
    : 0;
  if (recordedExpansionStates > remoteExpansionPages) omitted.push("expansion_states");
  return omitted;
}

function validateExistingTarget(finalDir, outputBuffers) {
  let targetStat;
  try {
    targetStat = lstatSync(finalDir);
  } catch {
    refuse("local_rehydration_target_conflict", "The immutable local recovery target could not be inspected.");
  }
  if (!targetStat.isDirectory() || targetStat.isSymbolicLink()) {
    refuse("local_rehydration_target_conflict", "The immutable local recovery target is not a regular directory.");
  }
  const expectedNames = [...outputBuffers.keys()].sort();
  const actualNames = readdirSync(finalDir).sort();
  if (stableJson(actualNames) !== stableJson(expectedNames)) {
    refuse("local_rehydration_target_conflict", "The immutable local recovery directory already exists with different files.");
  }
  for (const [fileName, expected] of outputBuffers) {
    const filePath = join(finalDir, fileName);
    let fileStat;
    try {
      fileStat = lstatSync(filePath);
    } catch {
      refuse("local_rehydration_target_conflict", "The immutable local recovery directory is incomplete.");
    }
    if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
      refuse("local_rehydration_target_conflict", `Existing restored file ${fileName} is not a regular file.`);
    }
    const existing = requiredFileBytes(
      filePath,
      "local_rehydration_target_conflict",
      "The immutable local recovery directory is incomplete.",
    );
    if (!existing.equals(expected)) {
      refuse("local_rehydration_target_conflict", `Existing restored file ${fileName} differs from the verified generation.`);
    }
  }
}

function validateArchiveRoot(archiveRoot) {
  let rootStat;
  try {
    rootStat = lstatSync(archiveRoot);
  } catch {
    refuse("local_archive_root_missing", "The local archive root does not exist.");
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    refuse("local_archive_root_unsafe", "The local archive root is not a real directory.");
  }
  try {
    realpathSync(archiveRoot);
  } catch (error) {
    if (error?.rehydrationReason) throw error;
    refuse("local_archive_root_unsafe", "The local archive root could not be safely resolved.");
  }
}

function validateMissingLocalBaselineTarget({ archiveRoot, sourceDir, baselinePath }) {
  const sourcesDir = join(archiveRoot, "sources");
  if (pathEntryExists(sourcesDir)) {
    validateSafeDirectoryWithin({
      archiveRoot,
      directory: sourcesDir,
      parent: archiveRoot,
      reason: "local_sources_directory_unsafe",
    });
  }
  if (!pathEntryExists(sourceDir)) return;
  validateSafeDirectoryWithin({
    archiveRoot,
    directory: sourceDir,
    parent: sourcesDir,
    reason: "local_source_directory_conflict",
  });
  if (pathEntryExists(baselinePath)) {
    refuse(
      "local_baseline_path_conflict",
      "A local baseline path exists even though recovery was told the baseline is missing.",
    );
  }
}

function ensureSafeSourcesDirectory(archiveRoot) {
  const sourcesDir = join(archiveRoot, "sources");
  if (!pathEntryExists(sourcesDir)) {
    try {
      mkdirSync(sourcesDir);
    } catch (error) {
      if (!pathEntryExists(sourcesDir)) {
        refuse(
          "local_sources_directory_publish_failed",
          `The local sources directory could not be created: ${cleanErrorMessage(error)}`,
        );
      }
    }
  }
  validateSafeDirectoryWithin({
    archiveRoot,
    directory: sourcesDir,
    parent: archiveRoot,
    reason: "local_sources_directory_unsafe",
  });
  return sourcesDir;
}

function validateSafeDirectoryWithin({ archiveRoot, directory, parent, reason }) {
  let stat;
  let realArchive;
  let realParent;
  let realDirectory;
  try {
    stat = lstatSync(directory);
    realArchive = realpathSync(archiveRoot);
    realParent = realpathSync(parent);
    realDirectory = realpathSync(directory);
  } catch {
    refuse(reason, "A local recovery directory could not be safely inspected.");
  }
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    !pathIsWithin(realArchive, realParent) ||
    !pathIsWithin(realParent, realDirectory)
  ) {
    refuse(reason, "A local recovery directory escapes its verified archive parent.");
  }
}

function validateLocalBaselinePath({ archiveRoot, sourceDir, baselinePath }) {
  let realArchive;
  let realSource;
  let baselineStat;
  try {
    realArchive = realpathSync(archiveRoot);
    realSource = realpathSync(sourceDir);
    baselineStat = lstatSync(baselinePath);
  } catch {
    refuse("local_baseline_missing", "The local baseline path could not be safely inspected.");
  }
  if (!pathIsWithin(realArchive, realSource)) {
    refuse("local_baseline_path_unsafe", "The source directory resolves outside the archive root.");
  }
  if (!baselineStat.isFile() || baselineStat.isSymbolicLink()) {
    refuse("local_baseline_path_unsafe", "The local baseline is not a regular file.");
  }
  if (!pathIsWithin(realSource, realpathSync(baselinePath))) {
    refuse("local_baseline_path_unsafe", "The local baseline resolves outside its source directory.");
  }
}

function validateLocalCapturesDirectory({ archiveRoot, sourceDir, capturesDir }) {
  let capturesStat;
  let realArchive;
  let realSource;
  let realCaptures;
  try {
    capturesStat = lstatSync(capturesDir);
    realArchive = realpathSync(archiveRoot);
    realSource = realpathSync(sourceDir);
    realCaptures = realpathSync(capturesDir);
  } catch {
    refuse("local_capture_directory_unsafe", "The local captures directory could not be safely inspected.");
  }
  if (
    !capturesStat.isDirectory() ||
    capturesStat.isSymbolicLink() ||
    !pathIsWithin(realArchive, realSource) ||
    !pathIsWithin(realSource, realCaptures)
  ) {
    refuse("local_capture_directory_unsafe", "The local captures directory resolves outside its source directory.");
  }
}

function pathIsWithin(parent, candidate) {
  const path = relative(resolve(parent), resolve(candidate));
  return path === "" || (
    path !== ".." &&
    !path.startsWith(`..${sep}`) &&
    !isAbsolute(path)
  );
}

function safeRemoveDirectory(path) {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {
    // The baseline still points to its prior capture; cleanup is best effort.
  }
}

function requireBodyHash(body, expected, slot) {
  if (!sha256Pattern.test(String(expected || ""))) {
    refuse("r2_generation_core_hash_invalid", `The ${slot} generation hash is missing or invalid.`);
  }
  if (!sameHash(sha256(body), expected)) {
    refuse("r2_object_sha256_mismatch", `The downloaded ${slot} bytes differ from the generation SHA-256.`);
  }
}

function requireExpectedLength(body, expected, slot) {
  const length = optionalNonNegativeInteger(expected);
  if (length != null && body.length !== length) {
    refuse("r2_object_length_mismatch", `The downloaded ${slot} byte count differs from generation metadata.`);
  }
}

function validateUsableEtag(value, body, slot) {
  const etag = normalizeEtag(value);
  if (!/^[0-9a-f]{32}$/i.test(etag)) return;
  const md5 = createHash("md5").update(body).digest("hex");
  if (etag.toLowerCase() !== md5) {
    refuse("r2_object_etag_mismatch", `The downloaded ${slot} bytes differ from the usable R2 ETag.`);
  }
}

function metadataSha256(metadata) {
  const value = objectValue(metadata);
  const candidates = [
    value.sha256,
    value.content_sha256,
    value["content-sha256"],
    value.checksum_sha256,
  ].map((entry) => String(entry || "").trim()).filter(Boolean);
  if (!candidates.length) return null;
  if (candidates.some((entry) => !sha256Pattern.test(entry))) {
    refuse("r2_object_sha256_metadata_invalid", "R2 SHA-256 metadata is malformed.");
  }
  if (new Set(candidates.map((entry) => entry.toLowerCase())).size !== 1) {
    refuse("r2_object_sha256_metadata_conflict", "R2 SHA-256 metadata fields conflict.");
  }
  return candidates[0];
}

function expansionMetadata(generation, index) {
  const states = Array.isArray(generation.metadata.expansion_state_screenshots)
    ? generation.metadata.expansion_state_screenshots
    : [];
  return states[index - 1] || null;
}

function requiredCoreHashes(kind) {
  return kind === "pdf" ? ["file_hash", "text_hash"] : ["image_hash", "text_hash"];
}

function sameTimestamp(left, right) {
  return validTimestamp(left) && validTimestamp(right) && Date.parse(left) === Date.parse(right);
}

function validTimestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function sameHash(left, right) {
  return sha256Pattern.test(String(left || "")) &&
    sha256Pattern.test(String(right || "")) &&
    String(left).toLowerCase() === String(right).toLowerCase();
}

function optionalNonNegativeInteger(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : null;
}

function cleanNullableString(value) {
  const text = String(value || "").trim();
  return text || null;
}

function archiveRelative(archiveRoot, path) {
  const value = relative(resolve(archiveRoot), resolve(path)).split(sep).join("/");
  if (!value || value === ".." || value.startsWith("../")) {
    refuse("local_rehydration_path_outside_archive", "A local recovery path escapes the archive root.");
  }
  return value;
}

function requiredFileBytes(path, reason, message) {
  try {
    return readFileSync(path);
  } catch {
    refuse(reason, message);
  }
}

function parseJsonBytes(bytes, reason, message) {
  try {
    return JSON.parse(decodeUtf8(bytes, reason));
  } catch (error) {
    if (error?.rehydrationReason) throw error;
    refuse(reason, message);
  }
}

function decodeUtf8(bytes, reason) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    refuse(reason, "The downloaded UTF-8 artifact is invalid.");
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeEtag(value) {
  return String(value || "").trim().replace(/^W\//, "").replace(/^"|"$/g, "");
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function objectValue(value) {
  return isObject(value) ? value : {};
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function refuse(reason, message) {
  const error = new Error(message);
  error.rehydrationReason = reason;
  throw error;
}

function cleanErrorMessage(error) {
  return String(error?.message || error || "Unknown R2 baseline rehydration failure.").slice(0, 1000);
}
