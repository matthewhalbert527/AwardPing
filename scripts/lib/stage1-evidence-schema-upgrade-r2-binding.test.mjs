import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  STAGE1_EVIDENCE_SCHEMA_UPGRADE_R2_BINDING_SCHEMA,
  assertStage1EvidenceSchemaUpgradeR2BindingReceipt,
  verifyStage1EvidenceSchemaUpgradeR2Binding,
} from "./stage1-evidence-schema-upgrade-r2-binding.mjs";
import { prepareR2CaptureArtifacts } from "./r2-capture-artifact-bindings.mjs";

const sourceId = "11111111-1111-4111-8111-111111111111";
const capturedAt = "2026-08-14T18:00:00.000Z";
const localGeneration = "2026-08-14T18-00-00-000Z";
const remoteGeneration = "a".repeat(32);
const semanticText = "Applicants must be enrolled full time.";

describe("Stage 1 legacy local/R2 core binding", () => {
  it("verifies a valid legacy webpage and seals explicit schema limitations", () => {
    const fixture = webpageFixture();
    const receipt = verify(fixture);

    expect(receipt).toMatchObject({
      schema: STAGE1_EVIDENCE_SCHEMA_UPGRADE_R2_BINDING_SCHEMA,
      status: "verified",
      source_id: sourceId,
      kind: "webpage",
      captured_at: capturedAt,
      creates_api_charge: false,
      mutation_performed: false,
      semantic_text: {
        sha256: sha256(Buffer.from(semanticText)),
        character_length: semanticText.length,
        writer_framing: "lf",
      },
      pointer_identity: {
        immutable_generation: remoteGeneration,
      },
      previous_pointer: {
        verification_scope: "report_only_not_validated",
        preserved: true,
      },
    });
    expect(receipt.verified_roles.map((entry) => entry.role)).toEqual([
      "meta",
      "page",
      "text",
      "thumb",
    ]);
    expect(receipt.limitations).toEqual([
      "baseline_expansion_state_capture_coverage_missing",
      "baseline_retained_artifact_projection_missing",
      "pointer_expansion_state_capture_coverage_missing",
      "pointer_retained_artifact_projection_missing",
      "raw_metadata_expansion_state_capture_coverage_missing",
      "raw_metadata_retained_artifact_projection_missing",
    ]);
    expect(assertStage1EvidenceSchemaUpgradeR2BindingReceipt(receipt)).toBe(true);

    const tampered = structuredClone(receipt);
    tampered.pointer_identity.bucket = "another-bucket";
    expectCode(
      () => assertStage1EvidenceSchemaUpgradeR2BindingReceipt(tampered),
      "r2_binding_receipt_seal_invalid",
    );
  });

  it("verifies a valid legacy PDF without inventing webpage coverage", () => {
    const receipt = verify(pdfFixture());

    expect(receipt).toMatchObject({
      status: "verified",
      kind: "pdf",
      creates_api_charge: false,
      verified_roles: [
        expect.objectContaining({ role: "meta" }),
        expect.objectContaining({ role: "pdf" }),
        expect.objectContaining({ role: "text" }),
      ],
    });
    expect(receipt.limitations).toEqual([
      "baseline_retained_artifact_projection_missing",
      "pointer_retained_artifact_projection_missing",
      "raw_metadata_retained_artifact_projection_missing",
    ]);
  });

  it("bootstraps wholly absent legacy pointer bindings from exact local and remote bytes", () => {
    const fixture = webpageFixture();
    delete fixture.r2Pointer.latest_metadata.artifact_bindings_schema;
    delete fixture.r2Pointer.latest_metadata.artifact_bindings;

    const receipt = verify(fixture);
    expect(receipt).toMatchObject({
      status: "verified",
      artifact_binding_verification: {
        status: "derived_from_exact_local_and_remote_bytes",
        pointer_claim_present: false,
        derived_binding_count: 4,
      },
    });
    expect(receipt.limitations).toContain(
      "pointer_legacy_artifact_bindings_absent_derived_from_verified_bytes",
    );
    expect(receipt.verified_roles).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: "page",
        sha256: fixture.localPreparedArtifacts.artifactBindings.page.sha256,
        remote_body_verified: true,
      }),
    ]));
    expect(assertStage1EvidenceSchemaUpgradeR2BindingReceipt(receipt)).toBe(true);
  });

  it("accepts the audited Supabase +00:00 timestamp spelling for an exact local Z generation", () => {
    const fixture = webpageFixture();
    fixture.r2Pointer.latest_captured_at = "2026-08-14T18:00:00.000+00:00";

    expect(verify(fixture)).toMatchObject({
      status: "verified",
      captured_at: capturedAt,
      pointer_identity: {
        latest_captured_at: "2026-08-14T18:00:00.000+00:00",
      },
    });
  });

  it("keeps audited FAQ expansion pairs local-only and never reports them as R2-verified", () => {
    const fixture = webpageFixture();
    addLocalExpansionPair(fixture, 1);
    const scalarCoverage = legacyScalarCoverage(1);
    const metadata = metadataBody(fixture);
    Object.assign(metadata, scalarCoverage);
    replaceArtifact(fixture, "meta", Buffer.from(JSON.stringify(metadata)));
    Object.assign(fixture.r2Pointer.latest_metadata, scalarCoverage);
    delete fixture.r2Pointer.latest_metadata.artifact_bindings_schema;
    delete fixture.r2Pointer.latest_metadata.artifact_bindings;

    const receipt = verify(fixture);
    expect(receipt.verified_roles.map((entry) => entry.role)).toEqual([
      "meta",
      "page",
      "text",
      "thumb",
    ]);
    expect(receipt.limitations).toEqual(expect.arrayContaining([
      "local_expansion_state_pairs_not_r2_authoritative:1",
      "local_diagnostic_role_not_in_r2:expansion_state_01",
      "local_diagnostic_role_not_in_r2:expansion_state_01_layout",
      "pointer_expansion_state_count_missing",
      "raw_metadata_expansion_state_count_missing",
    ]));
    expect(receipt.verified_roles).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "expansion_state_01" }),
    ]));
  });

  it("accepts audited legacy scalar coverage whose only absent field is expansion_state_count", () => {
    const fixture = webpageFixture();
    const scalarCoverage = legacyScalarCoverage(0);
    const metadata = metadataBody(fixture);
    Object.assign(metadata, scalarCoverage);
    replaceArtifact(fixture, "meta", Buffer.from(JSON.stringify(metadata)));
    Object.assign(fixture.r2Pointer.latest_metadata, scalarCoverage);

    expect(verify(fixture).limitations).toEqual(expect.arrayContaining([
      "pointer_expansion_state_count_missing",
      "raw_metadata_expansion_state_count_missing",
    ]));
  });

  it("ignores audited PDF-only zero segment lengths absent from immutable raw metadata", () => {
    const fixture = pdfFixture();
    Object.assign(fixture.r2Pointer.latest_metadata, {
      body_text_length: 0,
      main_content_text_length: 0,
      nav_header_footer_text_length: 0,
      expansion_text_length: 0,
    });

    expect(verify(fixture)).toMatchObject({ status: "verified", kind: "pdf" });
    expect(metadataBody(fixture)).not.toHaveProperty("body_text_length");
  });

  it("advances exact latest evidence while preserving an explicitly unvalidated legacy previous pointer", () => {
    const fixture = webpageFixture();
    fixture.r2Pointer.previous_captured_at = "2026-07-01T00:00:00.000+00:00";
    fixture.r2Pointer.previous_object_keys = {
      text: "legacy/unrecoverable/previous-text.txt",
    };
    fixture.r2Pointer.previous_hashes = { text_hash: "not-recoverable" };
    fixture.r2Pointer.previous_metadata = { availability: "unrecoverable" };

    const receipt = verify(fixture);
    expect(receipt).toMatchObject({
      status: "verified",
      previous_pointer: {
        verification_scope: "report_only_not_validated",
        preserved: true,
        previous_hashes: { text_hash: "not-recoverable" },
        previous_metadata: { availability: "unrecoverable" },
      },
    });
  });

  it("rejects missing-binding bootstrap when remote bytes do not match local bytes", () => {
    const fixture = webpageFixture();
    delete fixture.r2Pointer.latest_metadata.artifact_bindings_schema;
    delete fixture.r2Pointer.latest_metadata.artifact_bindings;
    fixture.remoteArtifactsByRole.page.body = Buffer.from("wrong retained R2 page");

    expectCode(() => verify(fixture), "remote_artifact_bytes_mismatch");
  });

  it("rejects partial legacy pointer binding claims instead of deriving around them", () => {
    const missingSchema = webpageFixture();
    delete missingSchema.r2Pointer.latest_metadata.artifact_bindings_schema;
    expectCode(
      () => verify(missingSchema),
      "r2_pointer_artifact_bindings_partial",
    );

    const missingBindings = webpageFixture();
    delete missingBindings.r2Pointer.latest_metadata.artifact_bindings;
    expectCode(
      () => verify(missingBindings),
      "r2_pointer_artifact_bindings_partial",
    );
  });

  it("rejects a missing downloaded R2 object", () => {
    const fixture = webpageFixture();
    fixture.remoteArtifactsByRole.page = null;

    expectCode(() => verify(fixture), "remote_artifact_missing:page");
  });

  it("rejects key/role swaps and local capture-path swaps", () => {
    const remoteSwap = webpageFixture();
    const pageKey = remoteSwap.r2Pointer.latest_object_keys.page;
    remoteSwap.r2Pointer.latest_object_keys.page =
      remoteSwap.r2Pointer.latest_object_keys.thumb;
    remoteSwap.r2Pointer.latest_object_keys.thumb = pageKey;
    remoteSwap.remoteArtifactsByRole.page.key =
      remoteSwap.r2Pointer.latest_object_keys.page;
    remoteSwap.remoteArtifactsByRole.thumb.key =
      remoteSwap.r2Pointer.latest_object_keys.thumb;
    expectCode(() => verify(remoteSwap), "r2_pointer_key_binding_invalid");

    const localSwap = webpageFixture();
    const pageArtifact = artifact(localSwap, "page");
    pageArtifact.path = localSwap.existingCapture.thumb_path;
    expectCode(() => verify(localSwap), "local_artifact_path_binding_invalid");
  });

  it.each([
    [
      "a sibling source directory",
      (path) => path.replace(sourceId, "22222222-2222-4222-8222-222222222222"),
    ],
    [
      "a parent traversal",
      (path) => path.replace("/page.jpg", "/../page.jpg"),
    ],
    [
      "a mutable latest alias",
      (path) => path.replace(localGeneration, "latest"),
    ],
  ])("rejects a prepared local artifact rebound through %s", (_label, rebind) => {
    const fixture = webpageFixture();
    const pageArtifact = artifact(fixture, "page");
    pageArtifact.path = rebind(pageArtifact.path.replaceAll("\\", "/"));

    expectCode(() => verify(fixture), "local_artifact_path_binding_invalid");
  });

  it("rejects self-consistently rebound but stale raw metadata", () => {
    const fixture = webpageFixture();
    const metadata = metadataBody(fixture);
    metadata.captured_at = "2026-08-14T17:59:59.000Z";
    replaceArtifact(fixture, "meta", Buffer.from(JSON.stringify(metadata)));

    expectCode(() => verify(fixture), "raw_metadata_identity_mismatch");
  });

  it("rejects byte, hash, and length mismatches independently", () => {
    const bytes = webpageFixture();
    bytes.remoteArtifactsByRole.page.body = Buffer.from("another remote page");
    expectCode(() => verify(bytes), "remote_artifact_bytes_mismatch");

    const hash = webpageFixture();
    hash.r2Pointer.latest_hashes.image_hash = "b".repeat(64);
    expectCode(() => verify(hash), "r2_pointer_core_hash_mismatch");

    const length = webpageFixture();
    length.r2Pointer.latest_metadata.page_bytes += 1;
    expectCode(() => verify(length), "core_length_identity_mismatch");
  });

  it("rejects source, kind, and timestamp mismatches", () => {
    const source = webpageFixture();
    source.r2Pointer.shared_award_source_id =
      "22222222-2222-4222-8222-222222222222";
    expectCode(() => verify(source), "source_id_mismatch");

    const kind = webpageFixture();
    kind.r2Pointer.kind = "pdf";
    expectCode(() => verify(kind), "source_kind_mismatch");

    const timestamp = webpageFixture();
    timestamp.r2Pointer.latest_captured_at = "2026-08-14T18:00:01.000Z";
    expectCode(() => verify(timestamp), "latest_captured_at_mismatch");
  });

  it("rejects duplicate generation keys", () => {
    const fixture = webpageFixture();
    fixture.r2Pointer.latest_object_keys.thumb =
      fixture.r2Pointer.latest_object_keys.page;
    fixture.remoteArtifactsByRole.thumb.key =
      fixture.r2Pointer.latest_object_keys.thumb;

    expectCode(() => verify(fixture), "r2_pointer_keys_duplicate");
  });

  it("rejects malformed or stale raw artifact bindings", () => {
    const pointer = webpageFixture();
    delete pointer.r2Pointer.latest_metadata.artifact_bindings.page.hash_mode;
    expectCode(() => verify(pointer), "r2_pointer_artifact_binding_mismatch");

    const malformedSchema = webpageFixture();
    malformedSchema.r2Pointer.latest_metadata.artifact_bindings_schema =
      "awardping.r2.capture-artifact-bindings.v0";
    expectCode(
      () => verify(malformedSchema),
      "r2_pointer_artifact_bindings_schema_invalid",
    );

    const local = webpageFixture();
    local.localPreparedArtifacts.artifactBindings.page.byte_length += 1;
    expectCode(() => verify(local), "local_artifact_binding_mismatch");
  });

  it("rejects text writer-newline and semantic-hash mismatches", () => {
    const newline = webpageFixture();
    replaceArtifact(newline, "text", Buffer.from(semanticText));
    expectCode(() => verify(newline), "semantic_text_writer_framing_invalid");

    const hash = webpageFixture();
    const metadata = metadataBody(hash);
    metadata.text_hash = "c".repeat(64);
    replaceArtifact(hash, "meta", Buffer.from(JSON.stringify(metadata)));
    expectCode(() => verify(hash), "core_hash_identity_mismatch");
  });

  it("rejects a remote role with no prepared local counterpart", () => {
    const fixture = webpageFixture();
    const layoutBody = Buffer.from("{}");
    const layoutBinding = binding(layoutBody, "application/json; charset=utf-8");
    fixture.r2Pointer.latest_object_keys.layout = remoteKey("layout.json");
    fixture.r2Pointer.latest_metadata.artifact_bindings.layout = layoutBinding;
    fixture.remoteArtifactsByRole.layout = {
      key: remoteKey("layout.json"),
      body: layoutBody,
    };

    expectCode(() => verify(fixture), "r2_role_absent_from_local_prepared");
  });

  it("does not bless present malformed legacy projection or coverage claims", () => {
    const projection = webpageFixture();
    projection.r2Pointer.latest_metadata.retained_artifact_projection = {
      schema: "awardping.capture-retained-artifact-projection.v1",
      kind: "pdf",
      authoritative: {
        layout_retained: false,
        layout_hash: null,
        expansion_state_count: 0,
      },
    };
    expectCode(
      () => verify(projection),
      "legacy_retained_artifact_projection_contradiction",
    );

    const coverage = webpageFixture();
    coverage.r2Pointer.latest_metadata.expansion_state_capture_coverage = {
      status: "verified_complete",
      complete: true,
    };
    expectCode(() => verify(coverage), "legacy_expansion_coverage_malformed");
  });

  it("accepts complete legacy scalar coverage only as an explicit incomplete limitation", () => {
    const fixture = webpageFixture();
    const metadata = metadataBody(fixture);
    Object.assign(metadata, {
      expansion_state_count: 0,
      expansion_state_screenshots: [],
      expansion_state_attempted: 0,
      expansion_state_candidates: 0,
      expansion_state_capture_limit: 24,
      expansion_state_capture_complete: true,
      expansion_state_truncated: false,
      expansion_state_truncated_count: 0,
      expansion_state_failures: [],
    });
    replaceArtifact(fixture, "meta", Buffer.from(JSON.stringify(metadata)));

    const receipt = verify(fixture);
    expect(receipt.limitations).toEqual(expect.arrayContaining([
      "raw_metadata_expansion_state_capture_coverage_missing",
      "raw_metadata_expansion_state_capture_coverage_incomplete",
    ]));

    metadata.expansion_state_truncated = true;
    replaceArtifact(fixture, "meta", Buffer.from(JSON.stringify(metadata)));
    expectCode(() => verify(fixture), "legacy_expansion_coverage_malformed");
  });
});

function verify(fixture) {
  return verifyStage1EvidenceSchemaUpgradeR2Binding({
    sourceId,
    sourceKind: fixture.kind,
    existingBaseline: fixture.existingBaseline,
    existingCapture: fixture.existingCapture,
    localPreparedArtifacts: fixture.localPreparedArtifacts,
    r2Pointer: fixture.r2Pointer,
    remoteArtifactsByRole: fixture.remoteArtifactsByRole,
  });
}

function webpageFixture() {
  const kind = "webpage";
  const page = Buffer.from("legacy full page image");
  const thumb = Buffer.from("legacy thumbnail image");
  const text = Buffer.from(`${semanticText}\n`);
  const pageHash = sha256(page);
  const textHash = sha256(Buffer.from(semanticText));
  const prefix = localPrefix();
  const relative = relativePrefix();
  const metadata = {
    version: 1,
    kind,
    source: { id: sourceId },
    captured_at: capturedAt,
    final_url: "https://example.org/award/eligibility",
    image_hash: pageHash,
    text_hash: textHash,
    text_length: semanticText.length,
    page_bytes: page.length,
    thumb_bytes: thumb.length,
    files: {
      page: `${relative}page.jpg`,
      thumb: `${relative}thumb.jpg`,
      text: `${relative}text.txt`,
      meta: `${relative}meta.json`,
    },
  };
  const prepared = prepare({
    page: ["page.jpg", "image/jpeg", page],
    thumb: ["thumb.jpg", "image/jpeg", thumb],
    text: ["text.txt", "text/plain; charset=utf-8", text],
    meta: [
      "meta.json",
      "application/json; charset=utf-8",
      Buffer.from(JSON.stringify(metadata)),
    ],
  });
  const capture = {
    version: 1,
    kind,
    source: { id: sourceId },
    captured_at: capturedAt,
    final_url: metadata.final_url,
    text: semanticText,
    text_hash: textHash,
    text_length: semanticText.length,
    image_hash: pageHash,
    page_bytes: page.length,
    thumb_bytes: thumb.length,
    page_path: `${prefix}page.jpg`,
    thumb_path: `${prefix}thumb.jpg`,
    text_path: `${prefix}text.txt`,
    meta_path: `${prefix}meta.json`,
  };
  const baseline = {
    version: 1,
    kind,
    source: { id: sourceId },
    captured_at: capturedAt,
    final_url: metadata.final_url,
    text_hash: textHash,
    text_length: semanticText.length,
    image_hash: pageHash,
    capture: {
      page: `${relative}page.jpg`,
      thumb: `${relative}thumb.jpg`,
      text: `${relative}text.txt`,
      meta: `${relative}meta.json`,
    },
    summary_metadata: {},
  };
  return finishFixture({ kind, capture, baseline, prepared, metadata });
}

function pdfFixture() {
  const kind = "pdf";
  const pdf = Buffer.from("%PDF-1.7 legacy official document bytes");
  const text = Buffer.from(`${semanticText}\n`);
  const fileHash = sha256(pdf);
  const textHash = sha256(Buffer.from(semanticText));
  const prefix = localPrefix();
  const relative = relativePrefix();
  const metadata = {
    version: 1,
    kind,
    source: { id: sourceId },
    captured_at: capturedAt,
    final_url: "https://example.org/award/rules.pdf",
    file_hash: fileHash,
    text_hash: textHash,
    text_length: semanticText.length,
    file_bytes: pdf.length,
    expansion_state_capture_coverage: null,
    files: {
      pdf: `${relative}document.pdf`,
      text: `${relative}text.txt`,
      meta: `${relative}meta.json`,
    },
  };
  const prepared = prepare({
    pdf: ["document.pdf", "application/pdf", pdf],
    text: ["text.txt", "text/plain; charset=utf-8", text],
    meta: [
      "meta.json",
      "application/json; charset=utf-8",
      Buffer.from(JSON.stringify(metadata)),
    ],
  });
  const capture = {
    version: 1,
    kind,
    source: { id: sourceId },
    captured_at: capturedAt,
    final_url: metadata.final_url,
    text: semanticText,
    text_hash: textHash,
    text_length: semanticText.length,
    file_hash: fileHash,
    file_bytes: pdf.length,
    pdf_path: `${prefix}document.pdf`,
    text_path: `${prefix}text.txt`,
    meta_path: `${prefix}meta.json`,
    expansion_state_capture_coverage: null,
  };
  const baseline = {
    version: 1,
    kind,
    source: { id: sourceId },
    captured_at: capturedAt,
    final_url: metadata.final_url,
    text_hash: textHash,
    text_length: semanticText.length,
    file_hash: fileHash,
    file_bytes: pdf.length,
    capture: {
      pdf: `${relative}document.pdf`,
      text: `${relative}text.txt`,
      meta: `${relative}meta.json`,
    },
    summary_metadata: {},
  };
  return finishFixture({ kind, capture, baseline, prepared, metadata });
}

function finishFixture({ kind, capture, baseline, prepared, metadata }) {
  const latestMetadata = {
    artifact_bindings_schema: "awardping.r2.capture-artifact-bindings.v1",
    artifact_bindings: structuredClone(prepared.artifactBindings),
    text_length: metadata.text_length,
    ...(kind === "webpage"
      ? {
          page_bytes: metadata.page_bytes,
          thumb_bytes: metadata.thumb_bytes,
        }
      : {
          file_bytes: metadata.file_bytes,
          expansion_state_capture_coverage: null,
        }),
  };
  const objectKeys = Object.fromEntries(
    prepared.artifacts.map((item) => [item.name, remoteKey(item.fileName)]),
  );
  const r2Pointer = {
    shared_award_source_id: sourceId,
    shared_award_id: "33333333-3333-4333-8333-333333333333",
    kind,
    bucket: "awardping-snapshots",
    latest_captured_at: capturedAt,
    latest_object_keys: objectKeys,
    latest_hashes: kind === "webpage"
      ? { image_hash: metadata.image_hash, text_hash: metadata.text_hash }
      : { file_hash: metadata.file_hash, text_hash: metadata.text_hash },
    latest_metadata: latestMetadata,
    previous_captured_at: "2026-08-13T18:00:00.000Z",
    previous_object_keys: { text: "preserved/previous/text.txt" },
    previous_hashes: { text_hash: "d".repeat(64) },
    previous_metadata: { schema: "legacy" },
  };
  const remoteArtifactsByRole = Object.fromEntries(
    prepared.artifacts.map((item) => [item.name, {
      key: objectKeys[item.name],
      body: Buffer.from(item.body),
      content_type: item.contentType,
      byte_length: item.body.length,
      binding: structuredClone(item.binding),
    }]),
  );
  return {
    kind,
    existingBaseline: baseline,
    existingCapture: capture,
    localPreparedArtifacts: prepared,
    r2Pointer,
    remoteArtifactsByRole,
  };
}

function prepare(definitions) {
  const bodies = new Map();
  const files = Object.entries(definitions).map(([name, [fileName, contentType, value]]) => {
    const path = `${localPrefix()}${fileName}`;
    bodies.set(path, Buffer.from(value));
    return { name, fileName, contentType, path };
  });
  return prepareR2CaptureArtifacts(files, {
    readFile: (path) => bodies.get(path),
  });
}

function addLocalExpansionPair(fixture, number) {
  const suffix = String(number).padStart(2, "0");
  const page = Buffer.from(`local-only expansion screenshot ${suffix}`);
  const layout = Buffer.from(`{"state":"${suffix}"}`);
  const definitions = [
    [
      `expansion_state_${suffix}`,
      `expansion-state-${suffix}.jpg`,
      "image/jpeg",
      page,
    ],
    [
      `expansion_state_${suffix}_layout`,
      `expansion-state-${suffix}-layout.json`,
      "application/json; charset=utf-8",
      layout,
    ],
  ];
  for (const [name, fileName, contentType, body] of definitions) {
    const item = {
      name,
      fileName,
      contentType,
      path: `${localPrefix()}${fileName}`,
      body,
      binding: binding(body, contentType),
    };
    fixture.localPreparedArtifacts.artifacts.push(item);
    fixture.localPreparedArtifacts.artifactBindings[name] = structuredClone(item.binding);
  }
  fixture.localPreparedArtifacts.artifacts.sort((left, right) => left.name.localeCompare(right.name));
  fixture.existingCapture.expansion_state_screenshots = [{
    state_id: `expansion-state-${suffix}`,
    page_path: `${localPrefix()}expansion-state-${suffix}.jpg`,
    layout_path: `${localPrefix()}expansion-state-${suffix}-layout.json`,
  }];
}

function legacyScalarCoverage(count) {
  return {
    expansion_state_attempted: count,
    expansion_state_candidates: count,
    expansion_state_capture_limit: 8,
    expansion_state_capture_complete: true,
    expansion_state_truncated: false,
    expansion_state_truncated_count: 0,
    expansion_state_failures: [],
    expansion_state_screenshots: Array.from({ length: count }, (_, index) => ({
      state_id: `expansion-state-${String(index + 1).padStart(2, "0")}`,
    })),
  };
}

function replaceArtifact(fixture, role, body) {
  const item = artifact(fixture, role);
  item.body = Buffer.from(body);
  item.binding = binding(item.body, item.contentType);
  fixture.localPreparedArtifacts.artifactBindings[role] = structuredClone(item.binding);
  fixture.r2Pointer.latest_metadata.artifact_bindings[role] = structuredClone(item.binding);
  fixture.remoteArtifactsByRole[role] = {
    key: fixture.r2Pointer.latest_object_keys[role],
    body: Buffer.from(item.body),
    content_type: item.contentType,
    byte_length: item.body.length,
    binding: structuredClone(item.binding),
  };
}

function artifact(fixture, role) {
  return fixture.localPreparedArtifacts.artifacts.find((item) => item.name === role);
}

function metadataBody(fixture) {
  return JSON.parse(artifact(fixture, "meta").body.toString("utf8"));
}

function binding(body, contentType) {
  return {
    sha256: sha256(body),
    byte_length: body.length,
    content_type: contentType,
    hash_mode: "raw_sha256",
  };
}

function localPrefix() {
  return `D:\\AwardPingVisualSnapshots\\sources\\${sourceId}\\captures\\${localGeneration}\\`;
}

function relativePrefix() {
  return `sources/${sourceId}/captures/${localGeneration}/`;
}

function remoteKey(fileName) {
  return `visual-snapshots/sources/${sourceId}/captures/${remoteGeneration}/${fileName}`;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function expectCode(operation, code) {
  try {
    operation();
    throw new Error(`Expected ${code}.`);
  } catch (error) {
    expect(error).toMatchObject({ code });
  }
}
