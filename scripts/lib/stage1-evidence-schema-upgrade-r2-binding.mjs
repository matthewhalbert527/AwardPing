import { createHash } from "node:crypto";
import {
  legacyExpansionStateCaptureCoverageFromMetadata,
} from "./expansion-state-descriptor-canonicalization.mjs";

export const STAGE1_EVIDENCE_SCHEMA_UPGRADE_R2_BINDING_SCHEMA =
  "awardping.stage1.evidence-schema-upgrade-r2-binding.v1";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const IMMUTABLE_GENERATION_PATTERN = /^[0-9a-f]{32}$/u;

const FIXED_ROLE_CONTRACT = Object.freeze({
  page: Object.freeze({ fileName: "page.jpg", contentType: "image/jpeg" }),
  thumb: Object.freeze({ fileName: "thumb.jpg", contentType: "image/jpeg" }),
  pdf: Object.freeze({ fileName: "document.pdf", contentType: "application/pdf" }),
  text: Object.freeze({
    fileName: "text.txt",
    contentType: "text/plain; charset=utf-8",
  }),
  layout: Object.freeze({
    fileName: "layout.json",
    contentType: "application/json; charset=utf-8",
  }),
  meta: Object.freeze({
    fileName: "meta.json",
    contentType: "application/json; charset=utf-8",
  }),
});

const REQUIRED_ROLES = Object.freeze({
  webpage: Object.freeze(["page", "thumb", "text", "meta"]),
  pdf: Object.freeze(["pdf", "text", "meta"]),
});

const OPTIONAL_HASH_FIELDS = Object.freeze({
  webpage: Object.freeze([
    "body_text_hash",
    "main_content_hash",
    "nav_header_footer_hash",
    "expansion_hash",
    "layout_hash",
  ]),
  pdf: Object.freeze(["image_hash"]),
});

export class Stage1EvidenceSchemaUpgradeR2BindingError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "Stage1EvidenceSchemaUpgradeR2BindingError";
    this.code = code;
  }
}

/**
 * Verifies that the legacy local baseline generation and the authoritative R2
 * latest generation are byte-for-byte the same before an evidence-schema
 * upgrade is allowed to prepare a replacement. This function is deliberately
 * pure: callers supply already-read local and remote objects and it performs no
 * filesystem, database, R2, queue, or provider operations.
 */
export function verifyStage1EvidenceSchemaUpgradeR2Binding({
  sourceId,
  sourceKind,
  existingBaseline,
  existingCapture,
  localPreparedArtifacts,
  r2Pointer,
  remoteArtifactsByRole,
} = {}) {
  const canonicalSourceId = requiredSourceId(sourceId);
  const kind = requiredKind(sourceKind);
  const baseline = requiredObject(existingBaseline, "existing_baseline_missing");
  const capture = requiredObject(existingCapture, "existing_capture_missing");
  const pointer = requiredObject(r2Pointer, "r2_pointer_missing");

  assertCaptureAndBaselineEnvelope({
    sourceId: canonicalSourceId,
    kind,
    baseline,
    capture,
    pointer,
  });

  const local = validateLocalPreparedArtifacts({
    sourceId: canonicalSourceId,
    kind,
    capture,
    baseline,
    prepared: localPreparedArtifacts,
  });
  const pointerBinding = validatePointer({
    sourceId: canonicalSourceId,
    kind,
    baseline,
    capture,
    pointer,
    local,
  });
  const remote = validateRemoteArtifacts({
    pointerRoles: pointerBinding.roles,
    pointerKeys: pointerBinding.objectKeys,
    pointerBindings: pointerBinding.artifactBindings,
    localArtifacts: local.byRole,
    remoteArtifactsByRole,
  });
  const metadata = parseJsonObject(local.byRole.get("meta").body, "raw_metadata_malformed");
  const semanticText = validateSemanticAndCoreIdentity({
    sourceId: canonicalSourceId,
    kind,
    baseline,
    capture,
    pointer,
    metadata,
    local,
  });
  const limitations = collectLegacyLimitations({
    kind,
    baseline,
    capture,
    pointer,
    metadata,
    roles: pointerBinding.roles,
    localRoles: local.roles,
    pointerBindingsDerived: pointerBinding.bindingsDerived,
  });

  const pointerProjection = {
    shared_award_source_id: canonicalSourceId,
    kind,
    bucket: requiredText(pointer.bucket, "r2_pointer_bucket_missing"),
    latest_captured_at: pointer.latest_captured_at,
    latest_object_keys: cloneJson(pointer.latest_object_keys),
    latest_hashes: cloneJson(pointer.latest_hashes),
    latest_metadata_sha256: sha256(stableJson(pointer.latest_metadata)),
    immutable_generation: pointerBinding.generation,
  };
  const previousProjection = {
    verification_scope: "report_only_not_validated",
    preserved: true,
    previous_captured_at: pointer.previous_captured_at ?? null,
    previous_object_keys: cloneJson(pointer.previous_object_keys ?? {}),
    previous_hashes: cloneJson(pointer.previous_hashes ?? {}),
    previous_metadata: cloneJson(pointer.previous_metadata ?? {}),
  };
  previousProjection.projection_sha256 = sha256(stableJson(previousProjection));

  const receiptContent = {
    schema: STAGE1_EVIDENCE_SCHEMA_UPGRADE_R2_BINDING_SCHEMA,
    status: "verified",
    source_id: canonicalSourceId,
    kind,
    captured_at: capture.captured_at,
    creates_api_charge: false,
    mutation_performed: false,
    pointer_identity: {
      ...pointerProjection,
      pointer_sha256: sha256(stableJson(pointerProjection)),
    },
    previous_pointer: previousProjection,
    artifact_binding_verification: {
      status: pointerBinding.bindingsDerived
        ? "derived_from_exact_local_and_remote_bytes"
        : "pointer_v1_bindings_verified",
      pointer_claim_present: !pointerBinding.bindingsDerived,
      derived_binding_count: pointerBinding.bindingsDerived
        ? pointerBinding.roles.length
        : 0,
    },
    verified_roles: pointerBinding.roles.map((role) => ({
      role,
      key: pointerBinding.objectKeys[role],
      sha256: pointerBinding.artifactBindings[role].sha256,
      byte_length: pointerBinding.artifactBindings[role].byte_length,
      content_type: pointerBinding.artifactBindings[role].content_type,
      remote_body_verified: remote.verifiedRoles.has(role),
    })),
    semantic_text: {
      sha256: semanticText.sha256,
      character_length: semanticText.text.length,
      object_byte_length: local.byRole.get("text").body.length,
      writer_framing: semanticText.framing,
    },
    limitations,
  };
  return {
    ...receiptContent,
    receipt_sha256: stage1EvidenceSchemaUpgradeR2BindingReceiptSha256(receiptContent),
  };
}

export function stage1EvidenceSchemaUpgradeR2BindingReceiptSha256(receipt) {
  const content = cloneJson(receipt);
  delete content.receipt_sha256;
  return sha256(stableJson(content));
}

export function assertStage1EvidenceSchemaUpgradeR2BindingReceipt(receipt) {
  const value = requiredObject(receipt, "r2_binding_receipt_missing");
  if (
    value.schema !== STAGE1_EVIDENCE_SCHEMA_UPGRADE_R2_BINDING_SCHEMA
    || value.status !== "verified"
    || value.creates_api_charge !== false
    || value.mutation_performed !== false
    || !isSha256(value.receipt_sha256)
    || value.receipt_sha256
      !== stage1EvidenceSchemaUpgradeR2BindingReceiptSha256(value)
  ) {
    refuse(
      "r2_binding_receipt_seal_invalid",
      "The Stage 1 legacy local/R2 binding receipt is missing or has been altered.",
    );
  }
  const pointerIdentity = requiredObject(
    value.pointer_identity,
    "r2_binding_receipt_seal_invalid",
  );
  const pointerContent = cloneJson(pointerIdentity);
  const pointerSha256 = pointerContent.pointer_sha256;
  delete pointerContent.pointer_sha256;
  const previousPointer = requiredObject(
    value.previous_pointer,
    "r2_binding_receipt_seal_invalid",
  );
  const previousContent = cloneJson(previousPointer);
  const previousSha256 = previousContent.projection_sha256;
  delete previousContent.projection_sha256;
  if (
    !isSha256(pointerSha256)
    || pointerSha256 !== sha256(stableJson(pointerContent))
    || !isSha256(previousSha256)
    || previousSha256 !== sha256(stableJson(previousContent))
  ) {
    refuse(
      "r2_binding_receipt_seal_invalid",
      "The Stage 1 receipt's nested pointer identities have been altered.",
    );
  }
  return true;
}

function assertCaptureAndBaselineEnvelope({ sourceId, kind, baseline, capture, pointer }) {
  if (capture.kind !== kind || baseline.kind !== kind || pointer.kind !== kind) {
    refuse(
      "source_kind_mismatch",
      "The source, local baseline, local capture, and R2 pointer kinds must match exactly.",
    );
  }
  if (
    cleanText(capture.source?.id) !== sourceId
    || cleanText(baseline.source?.id) !== sourceId
    || cleanText(pointer.shared_award_source_id) !== sourceId
  ) {
    refuse(
      "source_id_mismatch",
      "The local baseline, local capture, and R2 pointer must belong to the requested source.",
    );
  }
  const capturedAt = requiredTimestamp(capture.captured_at, "capture_timestamp_invalid");
  const baselineAt = requiredTimestamp(baseline.captured_at, "baseline_timestamp_invalid");
  const pointerAt = requiredTimestamp(
    pointer.latest_captured_at,
    "r2_pointer_timestamp_invalid",
  );
  if (baselineAt !== capturedAt || pointerAt !== capturedAt) {
    refuse(
      "latest_captured_at_mismatch",
      "The local baseline, local capture, and R2 latest pointer timestamps must match exactly.",
    );
  }
}

function validateLocalPreparedArtifacts({ sourceId, kind, capture, baseline, prepared }) {
  const supplied = requiredObject(
    localPreparedArtifactsObject(prepared),
    "local_prepared_artifacts_missing",
  );
  if (!Array.isArray(supplied.artifacts) || supplied.artifacts.length === 0) {
    refuse("local_prepared_artifacts_missing", "No prepared local artifacts were supplied.");
  }
  const suppliedBindings = requiredObject(
    supplied.artifactBindings,
    "local_artifact_bindings_missing",
  );
  const byRole = new Map();
  const localGenerations = new Set();
  for (const rawArtifact of supplied.artifacts) {
    const artifact = requiredObject(rawArtifact, "local_artifact_malformed");
    const role = requiredText(artifact.name, "local_artifact_role_missing");
    if (byRole.has(role)) {
      refuse("local_artifact_role_duplicate", `Local artifact role ${role} is duplicated.`);
    }
    const contract = roleContract(role);
    if (!contract) {
      refuse("local_artifact_role_unsupported", `Local artifact role ${role} is unsupported.`);
    }
    const body = requiredBody(artifact.body, `local_artifact_body_missing:${role}`);
    const fileName = requiredText(
      artifact.fileName,
      `local_artifact_filename_missing:${role}`,
    );
    const contentType = requiredText(
      artifact.contentType,
      `local_artifact_content_type_missing:${role}`,
    );
    if (fileName !== contract.fileName || contentType !== contract.contentType) {
      refuse(
        "local_artifact_contract_mismatch",
        `Local artifact ${role} has the wrong filename or content type.`,
      );
    }
    const path = normalizedPath(artifact.path);
    const pathBinding = parseLocalGenerationPath(path, sourceId, contract.fileName);
    if (!pathBinding) {
      refuse(
        "local_artifact_path_binding_invalid",
        `Local artifact ${role} is not in the requested source's capture generation.`,
      );
    }
    localGenerations.add(pathBinding.generation);
    const expectedCapturePath = normalizedPath(capturePathForRole(capture, role));
    if (expectedCapturePath && expectedCapturePath !== path) {
      refuse(
        "local_artifact_capture_path_mismatch",
        `Local artifact ${role} differs from the parsed capture path.`,
      );
    }
    const computedBinding = rawBinding(body, contentType);
    if (
      !sameJson(artifact.binding, computedBinding)
      || !sameJson(suppliedBindings[role], computedBinding)
    ) {
      refuse(
        "local_artifact_binding_mismatch",
        `Local artifact ${role} has a stale or malformed body binding.`,
      );
    }
    byRole.set(role, {
      role,
      path,
      fileName,
      contentType,
      body,
      binding: computedBinding,
    });
  }
  if (localGenerations.size !== 1) {
    refuse(
      "local_artifacts_mixed_generations",
      "Prepared local artifacts span more than one capture generation.",
    );
  }
  const localRoles = [...byRole.keys()].sort();
  if (!sameJson(Object.keys(suppliedBindings).sort(), localRoles)) {
    refuse(
      "local_artifact_binding_roles_mismatch",
      "Prepared local artifact bindings do not exactly match their artifact roles.",
    );
  }
  for (const role of REQUIRED_ROLES[kind]) {
    if (!byRole.has(role)) {
      refuse(
        "local_core_artifact_missing",
        `Prepared local ${kind} evidence is missing required ${role} bytes.`,
      );
    }
    assertBaselineCapturePath({ baseline, role, artifact: byRole.get(role) });
  }
  assertRoleTopology(kind, new Set(localRoles), "local");
  return { byRole, roles: localRoles, generation: [...localGenerations][0] };
}

function validatePointer({ sourceId, kind, baseline, capture, pointer, local }) {
  const objectKeys = requiredObject(
    pointer.latest_object_keys,
    "r2_pointer_object_keys_missing",
  );
  const hashes = requiredObject(pointer.latest_hashes, "r2_pointer_hashes_missing");
  const latestMetadata = requiredObject(
    pointer.latest_metadata,
    "r2_pointer_metadata_missing",
  );
  const roles = Object.keys(objectKeys).sort();
  if (!roles.length) {
    refuse("r2_pointer_object_keys_missing", "The R2 latest pointer has no object keys.");
  }
  const hasBindingSchema = Object.hasOwn(latestMetadata, "artifact_bindings_schema");
  const hasArtifactBindings = Object.hasOwn(latestMetadata, "artifact_bindings");
  if (hasBindingSchema !== hasArtifactBindings) {
    refuse(
      "r2_pointer_artifact_bindings_partial",
      "The R2 latest pointer contains only part of an artifact-binding claim.",
    );
  }
  const bindingsDerived = !hasBindingSchema && !hasArtifactBindings;
  let artifactBindings;
  if (bindingsDerived) {
    artifactBindings = Object.fromEntries(roles.map((role) => {
      const localArtifact = local.byRole.get(role);
      if (!localArtifact) {
        refuse(
          "r2_role_absent_from_local_prepared",
          `R2 role ${role} has no matching prepared local artifact.`,
        );
      }
      return [role, cloneJson(localArtifact.binding)];
    }));
  } else {
    if (
      latestMetadata.artifact_bindings_schema
        !== "awardping.r2.capture-artifact-bindings.v1"
    ) {
      refuse(
        "r2_pointer_artifact_bindings_schema_invalid",
        "The R2 latest pointer has an unsupported raw artifact-binding schema.",
      );
    }
    artifactBindings = requiredObject(
      latestMetadata.artifact_bindings,
      "r2_pointer_artifact_bindings_missing",
    );
  }
  if (!sameJson(Object.keys(artifactBindings).sort(), roles)) {
    refuse(
      "r2_pointer_binding_roles_mismatch",
      "The R2 latest pointer keys and raw artifact bindings claim different roles.",
    );
  }
  assertRoleTopology(kind, new Set(roles), "r2_pointer");

  const seenKeys = new Set();
  let generation = null;
  for (const role of roles) {
    const localArtifact = local.byRole.get(role);
    if (!localArtifact) {
      refuse(
        "r2_role_absent_from_local_prepared",
        `R2 role ${role} has no matching prepared local artifact.`,
      );
    }
    const contract = roleContract(role);
    const key = requiredText(objectKeys[role], `r2_pointer_key_missing:${role}`);
    if (seenKeys.has(key)) {
      refuse("r2_pointer_keys_duplicate", "Two R2 artifact roles use the same object key.");
    }
    seenKeys.add(key);
    const keyBinding = parseImmutableR2Key(key, sourceId, contract?.fileName);
    if (!keyBinding) {
      refuse(
        "r2_pointer_key_binding_invalid",
        `R2 role ${role} does not use its immutable source-generation filename.`,
      );
    }
    if (generation && generation !== keyBinding.generation) {
      refuse(
        "r2_pointer_keys_mixed_generations",
        "R2 latest artifact keys span more than one immutable generation.",
      );
    }
    generation ||= keyBinding.generation;
    if (!sameJson(artifactBindings[role], localArtifact.binding)) {
      refuse(
        "r2_pointer_artifact_binding_mismatch",
        `R2 latest metadata binding for ${role} differs from the verified local bytes.`,
      );
    }
  }

  assertRequiredCoreHashes({ kind, hashes, baseline, capture });
  return {
    objectKeys,
    hashes,
    latestMetadata,
    artifactBindings,
    roles,
    generation,
    bindingsDerived,
  };
}

function validateRemoteArtifacts({
  pointerRoles,
  pointerKeys,
  pointerBindings,
  localArtifacts,
  remoteArtifactsByRole,
}) {
  const remoteObject = remoteArtifactsByRole instanceof Map
    ? Object.fromEntries(remoteArtifactsByRole)
    : requiredObject(remoteArtifactsByRole, "remote_artifacts_missing");
  const remoteRoles = Object.keys(remoteObject).sort();
  if (!sameJson(remoteRoles, pointerRoles)) {
    refuse(
      "remote_artifact_roles_mismatch",
      "Downloaded R2 artifacts do not exactly match every latest pointer role.",
    );
  }
  const verifiedRoles = new Set();
  for (const role of pointerRoles) {
    const remote = requiredObject(
      remoteObject[role],
      `remote_artifact_missing:${role}`,
    );
    const key = requiredText(remote.key, `remote_artifact_key_missing:${role}`);
    if (key !== pointerKeys[role]) {
      refuse(
        "remote_artifact_key_mismatch",
        `Downloaded R2 artifact ${role} came from another object key.`,
      );
    }
    const body = requiredBody(remote.body, `remote_artifact_body_missing:${role}`);
    const local = localArtifacts.get(role);
    const binding = rawBinding(body, local.contentType);
    if (
      !body.equals(local.body)
      || !sameJson(binding, local.binding)
      || !sameJson(binding, pointerBindings[role])
    ) {
      refuse(
        "remote_artifact_bytes_mismatch",
        `Downloaded R2 artifact ${role} differs from the prepared local bytes or binding.`,
      );
    }
    const suppliedContentType = cleanText(remote.content_type ?? remote.contentType);
    if (suppliedContentType && suppliedContentType !== local.contentType) {
      refuse(
        "remote_artifact_content_type_mismatch",
        `Downloaded R2 artifact ${role} has the wrong content type.`,
      );
    }
    const suppliedLength = remote.byte_length ?? remote.contentLength;
    if (suppliedLength !== undefined && suppliedLength !== null) {
      if (!Number.isSafeInteger(suppliedLength) || suppliedLength !== body.length) {
        refuse(
          "remote_artifact_length_mismatch",
          `Downloaded R2 artifact ${role} has a stale byte length.`,
        );
      }
    }
    if (remote.binding !== undefined && !sameJson(remote.binding, binding)) {
      refuse(
        "remote_artifact_binding_mismatch",
        `Downloaded R2 artifact ${role} has a stale supplied binding.`,
      );
    }
    verifiedRoles.add(role);
  }
  return { verifiedRoles };
}

function validateSemanticAndCoreIdentity({
  sourceId,
  kind,
  baseline,
  capture,
  pointer,
  metadata,
  local,
}) {
  if (
    metadata.kind !== kind
    || cleanText(metadata.source?.id) !== sourceId
    || metadata.captured_at !== capture.captured_at
  ) {
    refuse(
      "raw_metadata_identity_mismatch",
      "The retained raw metadata belongs to another source, kind, or capture timestamp.",
    );
  }
  const expectedFinalUrl = cleanText(capture.final_url);
  if (
    !expectedFinalUrl
    || cleanText(baseline.final_url) !== expectedFinalUrl
    || cleanText(metadata.final_url) !== expectedFinalUrl
    || (
      cleanText(pointer.latest_metadata?.final_url)
      && cleanText(pointer.latest_metadata.final_url) !== expectedFinalUrl
    )
  ) {
    refuse(
      "final_url_identity_mismatch",
      "The local baseline, raw metadata, and R2 latest metadata final URLs disagree.",
    );
  }
  assertRawMetadataPaths({ sourceId, kind, metadata, local });

  const textArtifact = local.byRole.get("text");
  const semantic = decodeWriterText(textArtifact.body);
  const textHash = sha256(Buffer.from(semantic.text, "utf8"));
  const textLength = semantic.text.length;
  assertExactHashClaims("text_hash", textHash, [
    ["baseline", baseline.text_hash],
    ["capture", capture.text_hash],
    ["raw_metadata", metadata.text_hash],
    ["r2_pointer_hashes", pointer.latest_hashes?.text_hash],
  ]);
  assertExactLengthClaims("text_length", textLength, [
    ["baseline", baseline.text_length],
    ["capture", capture.text_length],
    ["raw_metadata", metadata.text_length],
    ["r2_pointer_metadata", pointer.latest_metadata?.text_length],
  ], { allowZero: true });
  if (
    typeof capture.text === "string"
    && capture.text !== semantic.text
    && capture.text !== semantic.raw
  ) {
    refuse(
      "semantic_text_capture_mismatch",
      "Parsed capture text differs from the exactly framed retained text object.",
    );
  }

  if (kind === "webpage") {
    const page = local.byRole.get("page");
    assertExactHashClaims("image_hash", page.binding.sha256, [
      ["baseline", baseline.image_hash],
      ["capture", capture.image_hash],
      ["raw_metadata", metadata.image_hash],
      ["r2_pointer_hashes", pointer.latest_hashes?.image_hash],
    ]);
    assertExactLengthClaims("page_bytes", page.body.length, [
      ["capture", capture.page_bytes],
      ["raw_metadata", metadata.page_bytes],
      ["r2_pointer_metadata", pointer.latest_metadata?.page_bytes],
      ...(baseline.page_bytes == null ? [] : [["baseline", baseline.page_bytes]]),
    ]);
    const thumb = local.byRole.get("thumb");
    assertExactLengthClaims("thumb_bytes", thumb.body.length, [
      ["capture", capture.thumb_bytes],
      ["raw_metadata", metadata.thumb_bytes],
      ["r2_pointer_metadata", pointer.latest_metadata?.thumb_bytes],
      ...(baseline.thumb_bytes == null ? [] : [["baseline", baseline.thumb_bytes]]),
    ]);
  } else {
    const pdf = local.byRole.get("pdf");
    assertExactHashClaims("file_hash", pdf.binding.sha256, [
      ["baseline", baseline.file_hash],
      ["capture", capture.file_hash],
      ["raw_metadata", metadata.file_hash],
      ["r2_pointer_hashes", pointer.latest_hashes?.file_hash],
    ]);
    assertExactLengthClaims("file_bytes", pdf.body.length, [
      ["baseline", baseline.file_bytes],
      ["capture", capture.file_bytes],
      ["raw_metadata", metadata.file_bytes],
      ["r2_pointer_metadata", pointer.latest_metadata?.file_bytes],
    ]);
  }

  assertOptionalPointerHashes({ kind, baseline, capture, metadata, pointer });
  return { ...semantic, sha256: textHash };
}

function collectLegacyLimitations({
  kind,
  baseline,
  capture,
  pointer,
  metadata,
  roles,
  localRoles,
  pointerBindingsDerived,
}) {
  const limitations = [];
  if (pointerBindingsDerived) {
    limitations.push(
      "pointer_legacy_artifact_bindings_absent_derived_from_verified_bytes",
    );
  }
  const expansionCount = roles.filter((role) => /^expansion_state_\d{2,}$/u.test(role)).length;
  const localExpansionCount = localRoles.filter(
    (role) => /^expansion_state_\d{2,}$/u.test(role),
  ).length;
  const localOnlyExpansionCount = localExpansionCount - expansionCount;
  if (localOnlyExpansionCount < 0) {
    refuse(
      "r2_expansion_roles_absent_from_local",
      "The R2 latest pointer contains expansion roles absent from prepared local evidence.",
    );
  }
  if (localOnlyExpansionCount > 0) {
    limitations.push(
      `local_expansion_state_pairs_not_r2_authoritative:${localOnlyExpansionCount}`,
    );
  }
  inspectProjection(
    pointer.latest_metadata?.retained_artifact_projection,
    "pointer",
    kind,
    roles,
    expansionCount,
    limitations,
    pointer.latest_hashes?.layout_hash || pointer.latest_metadata?.layout_hash || null,
  );
  inspectProjection(
    metadata.retained_artifact_projection,
    "raw_metadata",
    kind,
    localRoles,
    localExpansionCount,
    limitations,
    metadata.layout_hash || null,
  );
  inspectProjection(
    baseline.summary_metadata?.retained_artifact_projection
      ?? capture.retained_artifact_projection,
    "baseline",
    kind,
    localRoles,
    localExpansionCount,
    limitations,
    baseline.layout_hash || capture.layout_hash || null,
  );

  if (kind === "webpage") {
    inspectCoverageContainer(
      pointer.latest_metadata,
      "pointer",
      localExpansionCount,
      limitations,
    );
    inspectCoverageContainer(
      metadata,
      "raw_metadata",
      localExpansionCount,
      limitations,
    );
    inspectCoverageContainer(
      baseline.summary_metadata?.expansion_state_capture_coverage != null
        ? baseline.summary_metadata
        : capture,
      "baseline",
      localExpansionCount,
      limitations,
    );
  } else {
    for (const [label, value] of [
      ["pointer", pointer.latest_metadata?.expansion_state_capture_coverage],
      ["raw_metadata", metadata.expansion_state_capture_coverage],
      [
        "baseline",
        baseline.summary_metadata?.expansion_state_capture_coverage
          ?? capture.expansion_state_capture_coverage,
      ],
    ]) {
      if (value !== null && value !== undefined) {
        refuse(
          "pdf_expansion_coverage_contradiction",
          `PDF ${label} evidence contains webpage expansion coverage.`,
        );
      }
    }
  }

  const pointerRoleSet = new Set(roles);
  for (const role of localRoles) {
    if (!pointerRoleSet.has(role)) limitations.push(`local_diagnostic_role_not_in_r2:${role}`);
  }
  return [...new Set(limitations)].sort();
}

function inspectProjection(
  value,
  label,
  kind,
  roles,
  expansionCount,
  limitations,
  expectedLayoutHash,
) {
  if (value === null || value === undefined) {
    limitations.push(`${label}_retained_artifact_projection_missing`);
    return;
  }
  if (!isPlainObject(value) || !isPlainObject(value.authoritative)) {
    refuse(
      "legacy_retained_artifact_projection_malformed",
      `${label} retained-artifact projection is present but malformed.`,
    );
  }
  const expectedLayout = kind === "webpage" && roles.includes("layout");
  const expectedLocalizationStatus = kind === "pdf"
    ? "not_applicable_pdf"
    : value.authoritative.layout_retained
      ? "exact_geometry_available"
      : "evidence_only_geometry_unavailable";
  const layoutHash = value.authoritative.layout_hash;
  if (
    value.schema !== "awardping.capture-retained-artifact-projection.v1"
    || value.kind !== kind
    || value.localization_status !== expectedLocalizationStatus
    || typeof value.authoritative.layout_retained !== "boolean"
    || !Number.isSafeInteger(value.authoritative.expansion_state_count)
    || value.authoritative.expansion_state_count < 0
    || value.authoritative.expansion_state_count !== expansionCount
    || (value.authoritative.layout_retained && !expectedLayout)
    || (value.authoritative.layout_retained && !isSha256(layoutHash))
    || (
      value.authoritative.layout_retained
      && (!isSha256(expectedLayoutHash) || layoutHash !== expectedLayoutHash)
    )
    || (!value.authoritative.layout_retained && layoutHash !== null)
  ) {
    refuse(
      "legacy_retained_artifact_projection_contradiction",
      `${label} retained-artifact projection contradicts the retained role set.`,
    );
  }
  if (!value.authoritative.layout_retained && expectedLayout) {
    limitations.push(`${label}_layout_retained_as_legacy_evidence_only`);
  }
}

function inspectCoverageContainer(containerValue, label, expansionCount, limitations) {
  const container = isPlainObject(containerValue) ? containerValue : {};
  const value = container.expansion_state_capture_coverage;
  const scalarClaimed = [
    "expansion_state_attempted",
    "expansion_state_candidates",
    "expansion_state_capture_limit",
    "expansion_state_capture_complete",
    "expansion_state_capture_status",
    "expansion_state_raw_candidates",
    "expansion_state_raw_candidate_count_exact",
    "expansion_state_candidate_count_exact",
    "expansion_state_truncated",
    "expansion_state_truncated_count",
    "expansion_state_truncated_count_exact",
    "expansion_state_failures",
  ].some((field) => Object.hasOwn(container, field));
  if (value === null || value === undefined) {
    limitations.push(`${label}_expansion_state_capture_coverage_missing`);
    if (!scalarClaimed) return;
    let legacyCoverage = legacyExpansionStateCaptureCoverageFromMetadata(container, {
      retainedStateCount: expansionCount,
    });
    if (!legacyCoverage && !Object.hasOwn(container, "expansion_state_count")) {
      legacyCoverage = legacyExpansionStateCaptureCoverageFromMetadata({
        ...container,
        expansion_state_count: expansionCount,
      }, { retainedStateCount: expansionCount });
      if (legacyCoverage) {
        limitations.push(`${label}_expansion_state_count_missing`);
      }
    }
    if (!legacyCoverage) {
      refuse(
        "legacy_expansion_coverage_malformed",
        `${label} legacy expansion-state scalar claims are malformed or contradictory.`,
      );
    }
    limitations.push(`${label}_expansion_state_capture_coverage_incomplete`);
    return;
  }
  const coverage = legacyExpansionStateCaptureCoverageFromMetadata(container, {
    retainedStateCount: expansionCount,
  });
  if (!coverage) {
    refuse(
      "legacy_expansion_coverage_malformed",
      `${label} expansion-state coverage is present but malformed or contradictory.`,
    );
  }
  if (
    coverage.complete !== true
    || coverage.status !== "verified_complete"
    || coverage.truncated
    || coverage.failure_count !== 0
  ) {
    limitations.push(`${label}_expansion_state_capture_coverage_incomplete`);
  }
}

function assertRequiredCoreHashes({ kind, hashes, baseline, capture }) {
  const required = kind === "pdf" ? ["file_hash", "text_hash"] : ["image_hash", "text_hash"];
  for (const field of required) {
    const expected = requiredSha256(capture[field], `capture_${field}_invalid`);
    if (
      requiredSha256(baseline[field], `baseline_${field}_invalid`) !== expected
      || requiredSha256(hashes[field], `r2_pointer_${field}_invalid`) !== expected
    ) {
      refuse(
        "r2_pointer_core_hash_mismatch",
        `R2 latest ${field} differs from the local baseline or capture.`,
      );
    }
  }
}

function assertOptionalPointerHashes({ kind, baseline, capture, metadata, pointer }) {
  for (const field of OPTIONAL_HASH_FIELDS[kind]) {
    const claims = [
      pointer.latest_hashes?.[field],
      pointer.latest_metadata?.[field],
      baseline[field],
      capture[field],
      metadata[field],
    ].filter((value) => value !== null && value !== undefined && cleanText(value));
    if (!claims.length) continue;
    if (claims.some((value) => !isSha256(value)) || new Set(claims).size !== 1) {
      refuse(
        "optional_hash_claim_contradiction",
        `Retained ${field} claims are malformed or disagree across local and R2 evidence.`,
      );
    }
  }
}

function assertRawMetadataPaths({ sourceId, kind, metadata, local }) {
  const files = requiredObject(metadata.files, "raw_metadata_files_missing");
  for (const role of REQUIRED_ROLES[kind]) {
    const rawRef = files[role];
    const artifact = local.byRole.get(role);
    if (!rawRef || !normalizedPath(artifact.path).endsWith(normalizedPath(rawRef))) {
      refuse(
        "raw_metadata_file_path_mismatch",
        `Raw metadata ${role} path differs from its prepared local artifact.`,
      );
    }
    if (!parseLocalGenerationPath(artifact.path, sourceId, artifact.fileName)) {
      refuse(
        "raw_metadata_file_path_mismatch",
        `Raw metadata ${role} path is outside the requested source generation.`,
      );
    }
  }
}

function assertBaselineCapturePath({ baseline, role, artifact }) {
  const ref = baseline.capture?.[role];
  if (!ref || !normalizedPath(artifact.path).endsWith(normalizedPath(ref))) {
    refuse(
      "baseline_capture_path_mismatch",
      `Baseline ${role} path differs from its prepared local artifact.`,
    );
  }
}

function assertRoleTopology(kind, roles, label) {
  for (const role of REQUIRED_ROLES[kind]) {
    if (!roles.has(role)) {
      refuse(
        `${label}_core_role_missing`,
        `${label} ${kind} evidence is missing required ${role} bytes.`,
      );
    }
  }
  if (kind === "pdf") {
    if ([...roles].some((role) => !REQUIRED_ROLES.pdf.includes(role))) {
      refuse(
        `${label}_pdf_role_contradiction`,
        `${label} PDF evidence contains webpage-only artifact roles.`,
      );
    }
    return;
  }
  if (roles.has("pdf")) {
    refuse(`${label}_webpage_role_contradiction`, `${label} webpage evidence contains a PDF role.`);
  }
  const pages = [...roles]
    .map((role) => /^expansion_state_(\d{2,})$/u.exec(role)?.[1] ?? null)
    .filter(Boolean)
    .sort();
  const layouts = [...roles]
    .map((role) => /^expansion_state_(\d{2,})_layout$/u.exec(role)?.[1] ?? null)
    .filter(Boolean)
    .sort();
  if (!sameJson(pages, layouts)) {
    refuse(
      `${label}_expansion_role_pair_mismatch`,
      `${label} expansion screenshot/layout roles are not complete pairs.`,
    );
  }
  for (const [index, suffix] of pages.entries()) {
    if (suffix !== String(index + 1).padStart(2, "0")) {
      refuse(
        `${label}_expansion_roles_non_contiguous`,
        `${label} expansion roles are not contiguous from 01.`,
      );
    }
  }
}

function roleContract(role) {
  if (FIXED_ROLE_CONTRACT[role]) return FIXED_ROLE_CONTRACT[role];
  const page = /^expansion_state_(\d{2,})$/u.exec(role);
  if (page) {
    return {
      fileName: `expansion-state-${page[1]}.jpg`,
      contentType: "image/jpeg",
    };
  }
  const layout = /^expansion_state_(\d{2,})_layout$/u.exec(role);
  if (layout) {
    return {
      fileName: `expansion-state-${layout[1]}-layout.json`,
      contentType: "application/json; charset=utf-8",
    };
  }
  return null;
}

function capturePathForRole(capture, role) {
  if (role === "page") return capture.page_path;
  if (role === "thumb") return capture.thumb_path;
  if (role === "pdf") return capture.pdf_path;
  if (role === "text") return capture.text_path;
  if (role === "layout") return capture.layout_path;
  if (role === "meta") return capture.meta_path;
  const state = /^expansion_state_(\d{2,})(_layout)?$/u.exec(role);
  if (!state) return null;
  const index = Number(state[1]) - 1;
  const captureState = Array.isArray(capture.expansion_state_screenshots)
    ? capture.expansion_state_screenshots[index]
    : null;
  return state[2] ? captureState?.layout_path : captureState?.page_path;
}

function parseImmutableR2Key(key, sourceId, fileName) {
  if (
    !key
    || key.includes("\\")
    || key.includes("..")
    || /[\u0000-\u001f]/u.test(key)
  ) return null;
  const parts = key.split("/");
  if (
    parts.length !== 6
    || parts[0] !== "visual-snapshots"
    || parts[1] !== "sources"
    || parts[2] !== sourceId
    || parts[3] !== "captures"
    || !IMMUTABLE_GENERATION_PATTERN.test(parts[4])
    || parts[5] !== fileName
  ) return null;
  return { generation: parts[4] };
}

function parseLocalGenerationPath(path, sourceId, fileName) {
  if (!path || path.includes("..") || /[\u0000-\u001f]/u.test(path)) return null;
  const parts = path.split("/").filter(Boolean);
  const index = parts.lastIndexOf("sources");
  if (
    index < 0
    || parts[index + 1] !== sourceId
    || parts[index + 2] !== "captures"
    || !parts[index + 3]
    || parts[index + 4] !== fileName
    || index + 5 !== parts.length
  ) return null;
  if (new Set(["latest", "previous"]).has(parts[index + 3].toLowerCase())) return null;
  return { generation: parts[index + 3] };
}

function decodeWriterText(body) {
  let raw;
  try {
    raw = new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    refuse("semantic_text_utf8_invalid", "The retained text object is not valid UTF-8.");
  }
  const crlf = raw.endsWith("\r\n");
  const lf = !crlf && raw.endsWith("\n");
  const text = crlf ? raw.slice(0, -2) : lf ? raw.slice(0, -1) : null;
  if (text === null || text.endsWith("\n") || text.endsWith("\r")) {
    refuse(
      "semantic_text_writer_framing_invalid",
      "The retained text object must contain exactly one writer framing newline.",
    );
  }
  return { raw, text, framing: crlf ? "crlf" : "lf" };
}

function assertExactHashClaims(field, expected, claims) {
  for (const [label, value] of claims) {
    if (!isSha256(value) || value !== expected) {
      refuse(
        "core_hash_identity_mismatch",
        `${label} ${field} differs from the verified retained bytes.`,
      );
    }
  }
}

function assertExactLengthClaims(field, expected, claims, { allowZero = false } = {}) {
  for (const [label, value] of claims) {
    if (
      !Number.isSafeInteger(value)
      || value < (allowZero ? 0 : 1)
      || value !== expected
    ) {
      refuse(
        "core_length_identity_mismatch",
        `${label} ${field} differs from the verified retained bytes.`,
      );
    }
  }
}

function rawBinding(body, contentType) {
  return {
    sha256: sha256(body),
    byte_length: body.length,
    content_type: contentType,
    hash_mode: "raw_sha256",
  };
}

function localPreparedArtifactsObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function requiredSourceId(value) {
  const sourceId = cleanText(value).toLowerCase();
  if (!UUID_PATTERN.test(sourceId)) {
    refuse("source_id_invalid", "A canonical Stage 1 source UUID is required.");
  }
  return sourceId;
}

function requiredKind(value) {
  const kind = cleanText(value).toLowerCase();
  if (!new Set(["webpage", "pdf"]).has(kind)) {
    refuse("source_kind_invalid", "Stage 1 source kind must be webpage or pdf.");
  }
  return kind;
}

function requiredTimestamp(value, code) {
  const timestamp = cleanText(value);
  const milliseconds = Date.parse(timestamp);
  if (!timestamp || !Number.isFinite(milliseconds)) {
    refuse(code, "A valid capture timestamp is required.");
  }
  return new Date(milliseconds).toISOString();
}

function requiredSha256(value, code) {
  const hash = cleanText(value);
  if (!isSha256(hash)) refuse(code, "A lowercase SHA-256 value is required.");
  return hash;
}

function requiredText(value, code) {
  const text = cleanText(value);
  if (!text) refuse(code, "A required string value is missing.");
  return text;
}

function requiredObject(value, code) {
  if (!isPlainObject(value)) refuse(code, "A required object value is missing or malformed.");
  return value;
}

function requiredBody(value, code) {
  if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) {
    refuse(code, "Artifact bytes must be supplied as a Buffer or Uint8Array.");
  }
  const body = Buffer.from(value);
  if (!body.length) refuse(code, "Artifact bytes must not be empty.");
  return body;
}

function parseJsonObject(body, code) {
  try {
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
    if (!isPlainObject(value)) throw new Error();
    return value;
  } catch {
    refuse(code, "The retained raw metadata artifact is not a valid JSON object.");
  }
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, stableValue(value[key])]),
    );
  }
  if (
    value === null
    || typeof value === "string"
    || typeof value === "boolean"
    || (typeof value === "number" && Number.isFinite(value))
  ) return value;
  refuse("non_json_value", "Evidence receipts may contain only finite JSON values.");
}

function cloneJson(value) {
  return stableValue(value);
}

function sameJson(left, right) {
  try {
    return stableJson(left) === stableJson(right);
  } catch {
    return false;
  }
}

function normalizedPath(value) {
  return cleanText(value).replaceAll("\\", "/").replace(/^\.\//u, "");
}

function cleanText(value) {
  return String(value ?? "").trim();
}

function isSha256(value) {
  return SHA256_PATTERN.test(cleanText(value));
}

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function refuse(code, message) {
  throw new Stage1EvidenceSchemaUpgradeR2BindingError(code, message);
}
