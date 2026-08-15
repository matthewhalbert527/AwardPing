import crypto from "node:crypto";
import {
  verifyVisualTextGeometryBinding,
  visualTextGeometryLayoutFingerprint,
} from "./visual-event-localization.mjs";
import {
  canonicalExpansionStateCaptureCoverage,
  legacyExpansionStateCaptureCoverageFromMetadata,
  sameExpansionStateCaptureCoverage,
} from "./expansion-state-descriptor-canonicalization.mjs";

export const r2CaptureArtifactBindingsSchema =
  "awardping.r2.capture-artifact-bindings.v1";
export const retainedCaptureArtifactProjectionSchema =
  "awardping.capture-retained-artifact-projection.v1";
const retainedCaptureMaterializationProjectionCache = new WeakMap();

export function isR2CaptureGeometryReady(capture) {
  const geometry = objectValue(capture?.text_geometry);
  const screenshot = objectValue(geometry.screenshot);
  const paintStack = objectValue(geometry.paint_stack);
  const captureVerification = objectValue(geometry.capture_verification);
  const availabilityStatus = String(geometry.availability_status || "").trim();
  const expectedImageHash = String(
    capture?.image_hash || screenshot.image_hash || "",
  ).trim();
  const binding = verifyVisualTextGeometryBinding(geometry, expectedImageHash);
  const capturedLayoutFingerprint = visualTextGeometryLayoutFingerprint({
    ...geometry,
    version: 1,
  });

  return Boolean(
    capture?.kind !== "pdf"
      && !availabilityStatus.startsWith("unavailable_")
      && Number(geometry.run_count || 0) > 0
      && binding.valid
      && paintStack.contract === "browser-paint-stack-v1"
      && paintStack.status === "verified"
      && captureVerification.contract === "visual-screenshot-layout-binding-v1"
      && captureVerification.status === "verified"
      && captureVerification.before_fingerprint === capturedLayoutFingerprint
      && captureVerification.after_fingerprint === capturedLayoutFingerprint
      && screenshot.alignment_status === "verified",
  );
}

export function collectR2CaptureArtifactFiles(capture, { exists = () => true } = {}) {
  const files = [];
  const projection = projectRetainedCaptureArtifacts(capture, { exists });
  const addIfPresent = (name, fileName, path, contentType) => {
    if (!path || !exists(path)) return;
    files.push({ name, fileName, path, contentType });
  };

  addIfPresent("page", "page.jpg", capture?.page_path, "image/jpeg");
  addIfPresent("thumb", "thumb.jpg", capture?.thumb_path, "image/jpeg");
  addIfPresent("pdf", "document.pdf", capture?.pdf_path, "application/pdf");
  addIfPresent("text", "text.txt", capture?.text_path, "text/plain; charset=utf-8");
  if (projection.layoutRetained) {
    addIfPresent(
      "layout",
      "layout.json",
      capture?.layout_path,
      "application/json; charset=utf-8",
    );
  }
  addIfPresent("meta", "meta.json", capture?.meta_path, "application/json; charset=utf-8");
  const expansionStates = projection.retainedExpansionStates;
  for (const [index, state] of expansionStates.entries()) {
    const suffix = String(index + 1).padStart(2, "0");
    addIfPresent(
      `expansion_state_${suffix}`,
      `expansion-state-${suffix}.jpg`,
      state.page_path,
      "image/jpeg",
    );
    addIfPresent(
      `expansion_state_${suffix}_layout`,
      `expansion-state-${suffix}-layout.json`,
      state.layout_path,
      "application/json; charset=utf-8",
    );
  }
  return files;
}

/**
 * Selects the one authoritative layout/expansion artifact set used by local
 * baselines, immutable R2 objects, and snapshot pointer metadata. Files that
 * fail this contract may remain in the local capture directory for diagnosis,
 * but no authoritative field may reference them.
 */
export function projectRetainedCaptureArtifacts(capture, {
  exists = () => true,
  artifactBindings = null,
} = {}) {
  const kind = capture?.kind === "pdf" ? "pdf" : "webpage";
  const bindings = artifactBindings && typeof artifactBindings === "object"
    ? artifactBindings
    : null;
  const slotAvailable = (slot, path) => Boolean(
    path
    && exists(path)
    && (!bindings || bindings[slot]),
  );

  const mainGeometryReady = kind === "webpage" && isR2CaptureGeometryReady(capture);
  const layoutRetained = Boolean(
    mainGeometryReady
    && slotAvailable("layout", capture?.layout_path),
  );
  const mainLayoutReason = kind === "pdf"
    ? "not_applicable_pdf"
    : !mainGeometryReady
      ? captureGeometryExclusionReason(capture)
      : !capture?.layout_path
        ? "layout_path_missing"
        : !exists(capture.layout_path)
          ? "layout_file_missing"
          : bindings && !bindings.layout
            ? "layout_binding_missing"
            : null;

  const retainedExpansionStates = [];
  const excludedExpansionStates = [];
  // Every expansion screenshot has its own image/layout binding. A failed main
  // layout must not erase otherwise exact accordion evidence.
  let contiguous = true;
  for (const [index, state] of (Array.isArray(capture?.expansion_state_screenshots)
    ? capture.expansion_state_screenshots
    : []).entries()) {
    const suffix = String(index + 1).padStart(2, "0");
    const pageSlot = `expansion_state_${suffix}`;
    const layoutSlot = `${pageSlot}_layout`;
    let reason = null;
    if (!contiguous) {
      reason = "non_contiguous_after_unretained_state";
    } else if (state?.state_id !== `expansion-state-${suffix}`) {
      reason = "state_id_not_canonical";
    } else if (!/^[0-9a-f]{64}$/.test(String(state?.text_hash || ""))) {
      reason = "text_hash_invalid";
    } else if (!Number.isSafeInteger(state?.text_length) || state.text_length < 0) {
      reason = "text_length_invalid";
    } else if (!isR2CaptureGeometryReady({
      kind: "webpage",
      image_hash: state?.image_hash,
      text_geometry: state?.text_geometry,
    })) {
      reason = captureGeometryExclusionReason({
        kind: "webpage",
        image_hash: state?.image_hash,
        text_geometry: state?.text_geometry,
      });
    } else if (!state?.page_path) {
      reason = "page_path_missing";
    } else if (!exists(state.page_path)) {
      reason = "page_file_missing";
    } else if (!state?.layout_path) {
      reason = "layout_path_missing";
    } else if (!exists(state.layout_path)) {
      reason = "layout_file_missing";
    } else if (bindings && !bindings[pageSlot]) {
      reason = "page_binding_missing";
    } else if (bindings && !bindings[layoutSlot]) {
      reason = "layout_binding_missing";
    }

    if (!reason) {
      retainedExpansionStates.push(state);
      continue;
    }
    contiguous = false;
    excludedExpansionStates.push({
      state_id: state?.state_id || null,
      index,
      label: state?.label || null,
      reason,
      observed_image_hash: sha256OrNull(state?.image_hash),
      observed_layout_hash: sha256OrNull(
        state?.layout_hash || state?.text_geometry?.geometry_hash,
      ),
    });
  }

  const localizationStatus = kind === "pdf"
    ? "not_applicable_pdf"
    : layoutRetained
      ? "exact_geometry_available"
      : "evidence_only_geometry_unavailable";
  const manifest = {
    schema: retainedCaptureArtifactProjectionSchema,
    kind,
    localization_status: localizationStatus,
    authoritative: {
      layout_retained: layoutRetained,
      layout_hash: layoutRetained
        ? sha256OrNull(capture?.layout_hash || capture?.text_geometry?.geometry_hash)
        : null,
      expansion_state_count: retainedExpansionStates.length,
    },
    diagnostics: {
      authority: "diagnostic_only",
      storage_scope: "local_capture_directory_only",
      main_layout: kind !== "webpage" || layoutRetained
        ? null
        : {
            present: Boolean(capture?.layout_path && exists(capture.layout_path)),
            reason: mainLayoutReason || "geometry_not_retained",
            observed_geometry_hash: sha256OrNull(
              capture?.layout_hash || capture?.text_geometry?.geometry_hash,
            ),
          },
      expansion_states: excludedExpansionStates,
      excluded_state_count: excludedExpansionStates.length,
    },
  };

  return {
    schema: retainedCaptureArtifactProjectionSchema,
    kind,
    layoutRetained,
    retainedExpansionStates,
    localizationStatus,
    manifest,
  };
}

/**
 * Keeps the first diagnostic projection for one in-memory capture while the
 * worker materializes its authoritative subset. Materialization intentionally
 * removes excluded layout/state claims from the capture object, so recomputing
 * from that same object would otherwise erase the truthful failure evidence.
 * Persisted projections are never trusted: the cache is scoped to object
 * identity and an immutable capture/source signature.
 */
export function projectRetainedCaptureArtifactsForMaterialization(capture, {
  exists = () => true,
  identityScope = null,
} = {}) {
  if (!capture || typeof capture !== "object") {
    throw new Error("A capture is required for retained artifact materialization.");
  }
  const identity = JSON.stringify({
    scope: String(identityScope || "").trim() || null,
    kind: capture.kind === "pdf" ? "pdf" : "webpage",
    captured_at: String(capture.captured_at || "").trim() || null,
    primary_hash: sha256OrNull(
      capture.kind === "pdf" ? capture.file_hash : capture.image_hash,
    ),
    text_hash: sha256OrNull(capture.text_hash),
  });
  const cached = retainedCaptureMaterializationProjectionCache.get(capture);
  if (cached) {
    if (cached.identity !== identity) {
      throw new Error(
        "Capture identity changed after retained artifact materialization.",
      );
    }
    return cached.projection;
  }

  const projection = projectRetainedCaptureArtifacts(capture, { exists });
  retainedCaptureMaterializationProjectionCache.set(capture, {
    identity,
    projection,
  });
  return projection;
}

export function prepareR2CaptureArtifacts(files, { readFile } = {}) {
  if (!Array.isArray(files) || files.length < 1) {
    throw new Error("At least one R2 capture artifact is required.");
  }
  if (typeof readFile !== "function") {
    throw new Error("An R2 capture artifact reader is required.");
  }

  const names = new Set();
  const fileNames = new Set();
  const artifacts = files
    .map((file) => {
      const name = requiredText(file?.name, "R2 capture artifact slot");
      const fileName = requiredText(file?.fileName, `R2 capture filename for ${name}`);
      const path = requiredText(file?.path, `R2 capture path for ${name}`);
      const contentType = requiredText(
        file?.contentType,
        `R2 capture content type for ${name}`,
      );
      if (names.has(name) || fileNames.has(fileName)) {
        throw new Error(`Duplicate R2 capture artifact slot or filename: ${name}.`);
      }
      names.add(name);
      fileNames.add(fileName);

      const body = Buffer.from(readFile(path));
      if (body.length < 1) {
        throw new Error(`R2 capture artifact ${name} is empty.`);
      }
      return {
        name,
        fileName,
        path,
        contentType,
        body,
        binding: {
          sha256: crypto.createHash("sha256").update(body).digest("hex"),
          byte_length: body.length,
          content_type: contentType,
          hash_mode: "raw_sha256",
        },
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));

  return {
    artifacts,
    artifactBindings: Object.fromEntries(
      artifacts.map((artifact) => [artifact.name, artifact.binding]),
    ),
  };
}

export function assertR2CaptureArtifactSlots(kind, artifactBindings, {
  layoutClaimed = false,
  expansionStateCount = 0,
} = {}) {
  const slots = Object.keys(artifactBindings || {}).sort();
  const required = kind === "pdf"
    ? ["meta", "pdf", "text"]
    : ["meta", "page", "text", "thumb"];
  for (const slot of required) {
    if (!slots.includes(slot)) {
      throw new Error(`R2 ${kind || "webpage"} capture is missing required ${slot} evidence.`);
    }
  }

  if (kind === "pdf") {
    if (slots.some((slot) => !required.includes(slot))) {
      throw new Error("R2 PDF captures may contain only pdf, text, and meta evidence.");
    }
    return;
  }

  if (layoutClaimed && !slots.includes("layout")) {
    throw new Error("R2 webpage capture claims text geometry without a layout artifact.");
  }

  const expansionPages = new Set();
  const expansionLayouts = new Set();
  for (const slot of slots) {
    if (required.includes(slot) || slot === "layout") continue;
    const page = slot.match(/^expansion_state_(0[1-9]|[1-9][0-9]+)$/);
    const layout = slot.match(/^expansion_state_(0[1-9]|[1-9][0-9]+)_layout$/);
    if (page) expansionPages.add(Number(page[1]));
    else if (layout) expansionLayouts.add(Number(layout[1]));
    else throw new Error(`R2 webpage capture has an unsupported artifact slot: ${slot}.`);
  }

  if (expansionPages.size !== expansionLayouts.size) {
    throw new Error("R2 expansion screenshots and layouts must be complete pairs.");
  }
  const indexes = [...expansionPages].sort((left, right) => left - right);
  if (
    indexes.some((index, offset) => index !== offset + 1 || !expansionLayouts.has(index))
  ) {
    throw new Error("R2 expansion screenshot/layout pairs must be contiguous from 01.");
  }
  if (!Number.isSafeInteger(expansionStateCount) || expansionStateCount < 0) {
    throw new Error("R2 expansion state count is invalid.");
  }
  if (indexes.length !== expansionStateCount) {
    throw new Error("R2 retained expansion state count does not match its artifact pairs.");
  }
}

export function assertR2CaptureArtifactIdentity(capture, prepared, { sourceId } = {}) {
  const artifacts = new Map(
    (prepared?.artifacts || []).map((artifact) => [artifact.name, artifact]),
  );
  const kind = capture?.kind === "pdf" ? "pdf" : "webpage";
  const primarySlot = kind === "pdf" ? "pdf" : "page";
  const primaryHashField = kind === "pdf" ? "file_hash" : "image_hash";
  assertSameSha256(
    artifacts.get(primarySlot)?.binding?.sha256,
    capture?.[primaryHashField],
    `${primarySlot} bytes and capture ${primaryHashField}`,
  );

  const textArtifact = artifacts.get("text");
  if (!textArtifact) throw new Error("R2 capture text artifact is missing.");
  const text = decodeWriterTextArtifact(textArtifact.body);
  assertSameSha256(
    crypto.createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex"),
    capture?.text_hash,
    "text bytes and capture text_hash",
  );
  if (!Number.isSafeInteger(capture?.text_length) || capture.text_length !== text.length) {
    throw new Error("R2 text bytes and capture text_length do not match.");
  }

  const expectedImageHash = kind === "pdf" ? capture?.file_hash : capture?.image_hash;
  const layoutArtifact = artifacts.get("layout");
  if (layoutArtifact) {
    const layout = parseJsonArtifact(layoutArtifact.body, "main layout");
    const binding = verifyVisualTextGeometryBinding(layout, expectedImageHash);
    if (!binding.valid) {
      throw new Error(`R2 main layout binding is invalid: ${binding.reason}.`);
    }
    assertSameSha256(
      layout.geometry_hash,
      capture?.layout_hash || capture?.text_geometry?.geometry_hash,
      "main layout geometry identity",
    );
    assertSameSha256(
      layout.screenshot?.image_hash,
      expectedImageHash,
      "main layout screenshot identity",
    );
  }

  for (const [index, state] of (capture?.expansion_state_screenshots || []).entries()) {
    const suffix = String(index + 1).padStart(2, "0");
    if (!artifacts.has(`expansion_state_${suffix}`)) continue;
    const expectedStateId = `expansion-state-${suffix}`;
    if (state?.state_id !== expectedStateId) {
      throw new Error(`R2 expansion state ${suffix} has a non-canonical state ID.`);
    }
    assertSameSha256(
      artifacts.get(`expansion_state_${suffix}`)?.binding?.sha256,
      state?.image_hash,
      `expansion state ${suffix} screenshot identity`,
    );
    const stateLayout = parseJsonArtifact(
      artifacts.get(`expansion_state_${suffix}_layout`)?.body,
      `expansion state ${suffix} layout`,
    );
    if (stateLayout.state_id !== expectedStateId) {
      throw new Error(`R2 expansion state ${suffix} layout has the wrong state ID.`);
    }
    const stateBinding = verifyVisualTextGeometryBinding(stateLayout, state?.image_hash);
    if (!stateBinding.valid) {
      throw new Error(
        `R2 expansion state ${suffix} layout binding is invalid: ${stateBinding.reason}.`,
      );
    }
    assertSameSha256(
      stateLayout.geometry_hash,
      state?.layout_hash || state?.text_geometry?.geometry_hash,
      `expansion state ${suffix} layout identity`,
    );
    assertSameSha256(
      stateLayout.screenshot?.image_hash,
      state?.image_hash,
      `expansion state ${suffix} layout screenshot identity`,
    );
  }

  const metadata = parseJsonArtifact(artifacts.get("meta")?.body, "capture metadata");
  if (metadata.kind !== kind) {
    throw new Error("R2 metadata kind does not match the capture kind.");
  }
  if (sourceId && metadata.source?.id !== sourceId) {
    throw new Error("R2 metadata source ID does not match the pointer source.");
  }
  if (metadata.captured_at !== capture?.captured_at) {
    throw new Error("R2 metadata timestamp does not match the capture timestamp.");
  }
  assertRetainedArtifactProjectionParity({ capture, metadata, artifacts, kind });
  for (const field of ["text_hash", primaryHashField]) {
    assertSameSha256(metadata[field], capture?.[field], `metadata ${field} identity`);
  }
  if (!Number.isSafeInteger(metadata.text_length) || metadata.text_length < 0) {
    throw new Error("R2 metadata text_length is missing or invalid.");
  }
  if (metadata.text_length !== text.length) {
    throw new Error("R2 metadata text_length does not match the retained text artifact.");
  }
  const byteLengthBindings = kind === "pdf"
    ? [["pdf", "file_bytes"]]
    : [["page", "page_bytes"], ["thumb", "thumb_bytes"]];
  for (const [slot, field] of byteLengthBindings) {
    const retainedBytes = artifacts.get(slot)?.binding?.byte_length;
    if (
      !Number.isSafeInteger(retainedBytes)
      || retainedBytes < 1
      || !Number.isSafeInteger(capture?.[field])
      || capture[field] < 1
      || !Number.isSafeInteger(metadata[field])
      || metadata[field] < 1
      || capture[field] !== retainedBytes
      || metadata[field] !== retainedBytes
    ) {
      throw new Error(`R2 ${slot} byte length bindings do not match.`);
    }
  }
  const expectedLayoutHash = capture?.layout_hash || capture?.text_geometry?.geometry_hash || null;
  if (layoutArtifact && expectedLayoutHash) {
    assertSameSha256(metadata.layout_hash, expectedLayoutHash, "metadata layout identity");
    assertSameSha256(
      metadata.text_geometry?.geometry_hash,
      expectedLayoutHash,
      "metadata text geometry identity",
    );
    assertSameSha256(
      metadata.localization?.geometry_hash,
      expectedLayoutHash,
      "metadata localization geometry identity",
    );
    assertSameSha256(
      metadata.text_geometry?.screenshot?.image_hash,
      expectedImageHash,
      "metadata layout screenshot identity",
    );
    assertSameSha256(
      metadata.localization?.bound_image_hash,
      expectedImageHash,
      "metadata localization screenshot identity",
    );
    if (!metadata.files?.layout || !metadata.text_geometry?.file) {
      throw new Error("R2 metadata is missing its retained layout references.");
    }
  } else if (!layoutArtifact && metadataClaimsLayout(metadata)) {
    throw new Error("R2 metadata claims text geometry without a retained layout artifact.");
  } else if (
    kind === "webpage"
    && !layoutArtifact
    && !metadataLayoutExplicitlyUnavailable(metadata)
  ) {
    throw new Error("R2 metadata does not explicitly mark omitted layout geometry unavailable.");
  }

  const retainedExpansionCount = [...artifacts.keys()]
    .filter((slot) => /^expansion_state_[0-9]{2}$/.test(slot)).length;
  const metadataExpansionStates = Array.isArray(metadata.expansion_state_screenshots)
    ? metadata.expansion_state_screenshots
    : [];
  const metadataFileStates = Array.isArray(metadata.files?.expansion_states)
    ? metadata.files.expansion_states
    : [];
  if (
    kind === "webpage"
    && (!Number.isSafeInteger(metadata.expansion_state_count)
      || metadata.expansion_state_count < 0)
  ) {
    throw new Error("R2 metadata expansion state count is missing or invalid.");
  }
  const metadataExpansionCount = kind === "webpage"
    ? metadata.expansion_state_count
    : metadataExpansionStates.length;
  if (
    metadataExpansionCount !== retainedExpansionCount
    || metadataExpansionStates.length !== retainedExpansionCount
    || metadataFileStates.length !== retainedExpansionCount
  ) {
    throw new Error("R2 metadata expansion claims do not match retained artifact pairs.");
  }
  assertExpansionStateCaptureCoverageParity({
    capture,
    metadata,
    kind,
    retainedExpansionCount,
  });
  for (let index = 0; index < retainedExpansionCount; index += 1) {
    const suffix = String(index + 1).padStart(2, "0");
    const state = objectValue(capture?.expansion_state_screenshots?.[index]);
    const metadataState = objectValue(metadataExpansionStates[index]);
    const metadataFileState = objectValue(metadataFileStates[index]);
    const pageArtifactBytes = artifacts.get(`expansion_state_${suffix}`)
      ?.binding?.byte_length;
    const expectedStateId = `expansion-state-${suffix}`;
    if (
      state.state_id !== expectedStateId
      || metadataState.state_id !== expectedStateId
      || metadataFileState.state_id !== expectedStateId
    ) {
      throw new Error(`R2 metadata expansion state ${suffix} identity does not match.`);
    }
    for (const [field, expected] of [
      ["image_hash", state.image_hash],
      ["layout_hash", state.layout_hash || state.text_geometry?.geometry_hash],
      ["text_hash", state.text_hash],
    ]) {
      assertSameSha256(
        metadataState[field],
        expected,
        `metadata expansion state ${suffix} ${field}`,
      );
    }
    assertSameSha256(
      metadataState.text_geometry?.geometry_hash,
      state.layout_hash || state.text_geometry?.geometry_hash,
      `metadata expansion state ${suffix} geometry identity`,
    );
    assertSameSha256(
      metadataState.text_geometry?.screenshot?.image_hash,
      state.image_hash,
      `metadata expansion state ${suffix} screenshot identity`,
    );
    if (
      metadataState.text_length !== state.text_length
      || !Number.isSafeInteger(state.page_bytes)
      || state.page_bytes < 1
      || !Number.isSafeInteger(metadataState.page_bytes)
      || metadataState.page_bytes < 1
      || state.page_bytes !== pageArtifactBytes
      || metadataState.page_bytes !== pageArtifactBytes
      || !metadataState.page
      || !metadataState.layout
      || metadataFileState.page !== metadataState.page
      || metadataFileState.layout !== metadataState.layout
    ) {
      throw new Error(`R2 metadata expansion state ${suffix} references do not match.`);
    }
  }
}

function assertExpansionStateCaptureCoverageParity({
  capture,
  metadata,
  kind,
  retainedExpansionCount,
}) {
  if (kind === "pdf") {
    if (
      capture?.expansion_state_capture_coverage != null
      || metadata?.expansion_state_capture_coverage != null
    ) {
      throw new Error("R2 PDF capture contains expansion-state coverage metadata.");
    }
    return;
  }
  const options = { expectedRetainedStateCount: retainedExpansionCount };
  const captureCoverage = canonicalExpansionStateCaptureCoverage(
    capture?.expansion_state_capture_coverage,
    options,
  );
  const rawCoverage = legacyExpansionStateCaptureCoverageFromMetadata(metadata, {
    retainedStateCount: retainedExpansionCount,
  });
  if (!captureCoverage || !rawCoverage) {
    throw new Error("R2 expansion-state capture coverage is missing or invalid.");
  }
  if (!sameExpansionStateCaptureCoverage(captureCoverage, rawCoverage, options)) {
    throw new Error("R2 raw metadata and capture expansion-state coverage do not match.");
  }
}

function assertRetainedArtifactProjectionParity({ capture, metadata, artifacts, kind }) {
  const layoutRetained = artifacts.has("layout");
  const expansionStateCount = [...artifacts.keys()]
    .filter((slot) => /^expansion_state_[0-9]{2}$/.test(slot)).length;
  const layoutHash = layoutRetained
    ? sha256OrNull(capture?.layout_hash || capture?.text_geometry?.geometry_hash)
    : null;
  if (layoutRetained && !layoutHash) {
    throw new Error("R2 prepared layout slot does not have a valid semantic layout hash.");
  }
  const actual = {
    schema: retainedCaptureArtifactProjectionSchema,
    kind,
    localization_status: kind === "pdf"
      ? "not_applicable_pdf"
      : layoutRetained
        ? "exact_geometry_available"
        : "evidence_only_geometry_unavailable",
    authoritative: {
      layout_retained: layoutRetained,
      layout_hash: layoutHash,
      expansion_state_count: expansionStateCount,
    },
  };
  const captureProjection = canonicalRetainedArtifactProjection(
    capture?.retained_artifact_projection,
  );
  if (!captureProjection) {
    throw new Error("R2 capture retained artifact projection is missing or invalid.");
  }
  if (!sameProjectionAuthority(captureProjection, actual)) {
    throw new Error("R2 capture retained artifact projection does not match prepared artifact slots.");
  }
  const rawProjection = canonicalRetainedArtifactProjection(
    metadata?.retained_artifact_projection,
  );
  if (!rawProjection) {
    throw new Error("R2 raw metadata retained artifact projection is missing or invalid.");
  }
  if (!sameProjectionAuthority(rawProjection, captureProjection)) {
    throw new Error("R2 raw metadata and capture retained artifact projections do not match.");
  }
}

function canonicalRetainedArtifactProjection(value) {
  const projection = objectValue(value);
  const authority = objectValue(projection.authoritative);
  const kind = projection.kind;
  const expectedStatus = kind === "pdf"
    ? "not_applicable_pdf"
    : authority.layout_retained === true
      ? "exact_geometry_available"
      : "evidence_only_geometry_unavailable";
  const layoutHash = authority.layout_hash === null
    ? null
    : sha256OrNull(authority.layout_hash);
  if (
    projection.schema !== retainedCaptureArtifactProjectionSchema
    || !["webpage", "pdf"].includes(kind)
    || projection.localization_status !== expectedStatus
    || typeof authority.layout_retained !== "boolean"
    || !Number.isSafeInteger(authority.expansion_state_count)
    || authority.expansion_state_count < 0
    || (authority.layout_retained && !layoutHash)
    || (!authority.layout_retained && authority.layout_hash !== null)
    || (kind === "pdf" && (authority.layout_retained || authority.expansion_state_count !== 0))
  ) {
    return null;
  }
  return {
    schema: projection.schema,
    kind,
    localization_status: projection.localization_status,
    authoritative: {
      layout_retained: authority.layout_retained,
      layout_hash: layoutHash,
      expansion_state_count: authority.expansion_state_count,
    },
  };
}

function sameProjectionAuthority(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function requiredText(value, label) {
  const text = String(value || "").trim();
  if (!text) throw new Error(`${label} is required.`);
  return text;
}

function decodeWriterTextArtifact(body) {
  let raw;
  try {
    raw = new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    throw new Error("R2 capture text artifact is not valid UTF-8.");
  }
  const text = raw.endsWith("\r\n")
    ? raw.slice(0, -2)
    : raw.endsWith("\n")
      ? raw.slice(0, -1)
      : null;
  if (text === null || text.endsWith("\n") || text.endsWith("\r")) {
    throw new Error("R2 capture text must have exactly one writer framing newline.");
  }
  return text;
}

function parseJsonArtifact(body, label) {
  if (!body) throw new Error(`R2 ${label} artifact is missing.`);
  try {
    const value = JSON.parse(Buffer.from(body).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw new Error(`R2 ${label} artifact is not a JSON object.`);
  }
}

function assertSameSha256(actual, expected, label) {
  const left = String(actual || "").trim();
  const right = String(expected || "").trim();
  if (!/^[0-9a-f]{64}$/.test(left) || left !== right) {
    throw new Error(`R2 ${label} does not match.`);
  }
}

function captureGeometryExclusionReason(capture) {
  const geometry = objectValue(capture?.text_geometry);
  const availabilityStatus = String(geometry.availability_status || "").trim();
  if (availabilityStatus.startsWith("unavailable_")) return availabilityStatus;
  if (!Number(geometry.run_count || 0)) return "visible_text_runs_missing";
  const binding = verifyVisualTextGeometryBinding(
    geometry,
    capture?.image_hash || geometry.screenshot?.image_hash || null,
  );
  if (!binding.valid) return binding.reason;
  if (objectValue(geometry.paint_stack).status !== "verified") {
    return "paint_stack_not_verified";
  }
  if (objectValue(geometry.capture_verification).status !== "verified") {
    return "capture_verification_not_verified";
  }
  if (geometry.screenshot?.alignment_status !== "verified") {
    return "screenshot_alignment_not_verified";
  }
  return "capture_fingerprint_mismatch";
}

function metadataClaimsLayout(metadata) {
  const geometry = objectValue(metadata?.text_geometry);
  const localization = objectValue(metadata?.localization);
  return Boolean(
    metadata?.layout_hash
    || geometry.geometry_hash
    || geometry.file
    || geometry.screenshot?.image_hash
    || geometry.screenshot?.image_ref
    || metadata?.files?.layout
    || localization.geometry_hash
    || localization.bound_image_hash
    || localization.geometry_ready === true,
  );
}

function metadataLayoutExplicitlyUnavailable(metadata) {
  const geometryValue = metadata?.text_geometry;
  const geometry = objectValue(geometryValue);
  const localization = objectValue(metadata?.localization);
  const geometryAbsent = geometryValue === null || geometryValue === undefined;
  const geometryStatus = String(geometry.status || "").trim();
  const availabilityStatus = String(geometry.availability_status || "").trim();
  const unavailableStatus = (value) => value === "unavailable"
    || value.startsWith("unavailable_")
    || value === "capture_layout_unavailable"
    || value === "evidence_only_geometry_unavailable";
  const geometryUnavailable = geometryValue && typeof geometryValue === "object"
    && !Array.isArray(geometryValue)
    && unavailableStatus(geometryStatus)
    && (!availabilityStatus || unavailableStatus(availabilityStatus))
    && String(geometry.unavailable_reason || "").trim()
    && !String(geometry.geometry_hash || "").trim()
    && !String(geometry.file || "").trim()
    && (geometry.node_count == null || geometry.node_count === 0)
    && (geometry.run_count == null || geometry.run_count === 0)
    && !String(geometry.screenshot?.image_hash || "").trim()
    && !String(geometry.screenshot?.image_ref || "").trim();
  return Boolean(
    unavailableStatus(String(localization.status || "").trim())
    && localization.exact === false
    && localization.accounted_for === true
    && localization.geometry_ready === false
    && String(localization.unavailable_reason || "").trim()
    && !String(localization.geometry_hash || "").trim()
    && !String(localization.bound_image_hash || "").trim()
    && !String(metadata?.layout_hash || "").trim()
    && !String(metadata?.files?.layout || "").trim()
    && (geometryAbsent || geometryUnavailable)
  );
}

function sha256OrNull(value) {
  const text = String(value || "").trim().toLowerCase();
  return /^[0-9a-f]{64}$/.test(text) ? text : null;
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
