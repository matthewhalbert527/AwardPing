import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  STAGE1_EVIDENCE_SCHEMA_UPGRADE_COMMIT_BOUNDARIES,
  STAGE1_EVIDENCE_SCHEMA_UPGRADE_COMMIT_RECEIPT_SCHEMA,
  STAGE1_EVIDENCE_SCHEMA_UPGRADE_JOURNAL_ARCHIVE_ACCOUNTING_SCHEMA,
  STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_RECONCILIATION_EVIDENCE_SCHEMA,
  assertStage1EvidenceSchemaUpgradeReviewedReconciliationEvidence,
  assertStage1EvidenceSchemaUpgradeJournalArchiveAccounting,
  runStage1EvidenceSchemaUpgradeCommit,
} from "./stage1-evidence-schema-upgrade-commit.mjs";
import {
  STAGE1_EVIDENCE_SCHEMA_UPGRADE_JOURNAL_SCHEMA,
  STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_JOURNAL_SCHEMA,
  advanceStage1EvidenceSchemaUpgradeJournal,
  buildStage1EvidenceSchemaUpgradePrecommitSourceAuthority,
  buildStage1EvidenceSchemaUpgradeReviewedOperationBinding,
  buildStage1EvidenceSchemaUpgradeJournal,
} from "./stage1-evidence-schema-upgrade-transaction.mjs";
import {
  VISUAL_SNAPSHOT_POINTER_IDENTITY_SCHEMA,
  buildLatestOnlyVisualSnapshotPointerReplacement,
  visualSnapshotPointerIdentity,
} from "./visual-snapshot-latest-only-reconciliation.mjs";

const sourceId = "2ea41875-5c88-5794-81b3-afa8ddaf31c1";
const capturedAt = "2026-08-14T18:00:00.000Z";
const candidateSemanticText = "materially changed wording must not be absorbed";
const candidatePage = Buffer.from("candidate-image-bytes");
const candidateThumb = Buffer.from("candidate-thumbnail-bytes");
const candidateText = Buffer.from(`${candidateSemanticText}\n`, "utf8");
const candidateImageHash = sha256(candidatePage);
const candidateTextHash = sha256(Buffer.from(candidateSemanticText, "utf8"));
const candidateLayoutHash = sha256(Buffer.from("candidate-layout-geometry"));
const candidateLayout = Buffer.from(JSON.stringify({
  geometry_hash: candidateLayoutHash,
  screenshot: { image_hash: candidateImageHash },
}));
const candidateMeta = Buffer.from(JSON.stringify({
  kind: "webpage",
  source: { id: sourceId },
  captured_at: capturedAt,
  image_hash: candidateImageHash,
  text_hash: candidateTextHash,
  text_length: candidateSemanticText.length,
  page_bytes: candidatePage.length,
  thumb_bytes: candidateThumb.length,
  layout_hash: candidateLayoutHash,
}));
const oldBaseline = Buffer.from(
  '{"schema":"legacy","wording":"official unchanged wording"}\r\n',
  "utf8",
);
const candidateBaseline = Buffer.from(`${JSON.stringify({
  version: 1,
  kind: "webpage",
  source: { id: sourceId },
  captured_at: capturedAt,
  wording: candidateSemanticText,
  image_hash: candidateImageHash,
  text_hash: candidateTextHash,
  text_length: candidateSemanticText.length,
  body_text_hash: null,
  main_content_hash: null,
  nav_header_footer_hash: null,
  expansion_hash: null,
  layout_hash: candidateLayoutHash,
  file_hash: null,
})}\n`, "utf8");

const pdfSourceId = "719ffd9e-f97c-5c6d-8a5a-71b617cadf49";
const pdfCapturedAt = "2026-08-15T15:30:47.000Z";
const candidatePdfSemanticText =
  "Schwarzman Scholars 2026 application instructions and eligibility guidance";
const candidatePdf = Buffer.from(
  "%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n",
  "utf8",
);
const candidatePdfText = Buffer.from(`${candidatePdfSemanticText}\n`, "utf8");
const candidatePdfFileHash = sha256(candidatePdf);
const candidatePdfTextHash = sha256(Buffer.from(candidatePdfSemanticText, "utf8"));
const candidatePdfMeta = Buffer.from(JSON.stringify({
  version: 1,
  kind: "pdf",
  source: {
    id: pdfSourceId,
    title: "2026 Application Instructions",
  },
  captured_at: pdfCapturedAt,
  final_url: "https://www.schwarzmanscholars.org/admissions/application-instructions.pdf",
  content_type: "application/pdf",
  file_hash: candidatePdfFileHash,
  image_hash: candidatePdfFileHash,
  text_hash: candidatePdfTextHash,
  text_length: candidatePdfSemanticText.length,
  file_bytes: candidatePdf.length,
}));
const oldPdfBaseline = Buffer.from(
  '{"schema":"legacy-pdf","wording":"official unchanged wording"}\r\n',
  "utf8",
);
const candidatePdfBaseline = Buffer.from(`${JSON.stringify({
  version: 1,
  kind: "pdf",
  source: {
    id: pdfSourceId,
    title: "2026 Application Instructions",
  },
  captured_at: pdfCapturedAt,
  final_url: "https://www.schwarzmanscholars.org/admissions/application-instructions.pdf",
  page_title: "2026 Application Instructions",
  image_hash: candidatePdfFileHash,
  text_hash: candidatePdfTextHash,
  text_length: candidatePdfSemanticText.length,
  layout_hash: null,
  file_hash: candidatePdfFileHash,
  file_bytes: candidatePdf.length,
})}\n`, "utf8");

function oldPointer(overrides = {}) {
  return {
    shared_award_source_id: sourceId,
    shared_award_id: "award-1",
    source_url: "https://example.test/eligibility",
    source_title: "Eligibility",
    source_page_type: "eligibility",
    kind: "webpage",
    bucket: "awardping-evidence",
    latest_captured_at: "2026-08-14T18:00:00.000Z",
    latest_object_keys: {
      page: "visual-snapshots/sources/source-1/captures/generation-2/page.jpg",
      meta: "visual-snapshots/sources/source-1/captures/generation-2/meta.json",
    },
    latest_hashes: { image_hash: "old-image", text_hash: "old-text" },
    latest_metadata: { schema: "legacy", wording: "official unchanged wording" },
    previous_captured_at: "2026-08-13T18:00:00.000Z",
    previous_object_keys: {
      page: "visual-snapshots/sources/source-1/captures/generation-1/page.jpg",
    },
    previous_hashes: { image_hash: "previous-image" },
    previous_metadata: { schema: "legacy-previous" },
    updated_at: "2026-08-14T18:01:00.000Z",
    ...overrides,
  };
}

function candidatePointer(existing = oldPointer()) {
  const artifacts = candidateArtifacts();
  const bindings = Object.fromEntries(Object.entries(artifacts).map(([role, body]) => [
    role,
    {
      sha256: sha256(body),
      byte_length: body.length,
      content_type: artifactContentType(role),
      hash_mode: "raw_sha256",
    },
  ]));
  return buildLatestOnlyVisualSnapshotPointerReplacement({
    existing,
    replacement: {
      latest_captured_at: "2026-08-14T18:00:00.000Z",
      latest_object_keys: {
        page: "visual-snapshots/sources/source-1/captures/generation-3/page.jpg",
        thumb: "visual-snapshots/sources/source-1/captures/generation-3/thumb.jpg",
        text: "visual-snapshots/sources/source-1/captures/generation-3/text.txt",
        layout: "visual-snapshots/sources/source-1/captures/generation-3/layout.json",
        meta: "visual-snapshots/sources/source-1/captures/generation-3/meta.json",
      },
      latest_hashes: {
        image_hash: candidateImageHash,
        text_hash: candidateTextHash,
        body_text_hash: null,
        main_content_hash: null,
        nav_header_footer_hash: null,
        expansion_hash: null,
        layout_hash: candidateLayoutHash,
        file_hash: null,
      },
      latest_metadata: {
        artifact_bindings_schema: "awardping.r2.capture-artifact-bindings.v1",
        artifact_bindings: bindings,
        text_length: candidateSemanticText.length,
        text_object_bytes: candidateText.length,
        page_bytes: candidatePage.length,
        thumb_bytes: candidateThumb.length,
        layout_hash: candidateLayoutHash,
      },
    },
    updatedAt: "2026-08-14T18:02:00.000Z",
  });
}

function candidateArtifacts() {
  return {
    page: Buffer.from(candidatePage),
    thumb: Buffer.from(candidateThumb),
    text: Buffer.from(candidateText),
    layout: Buffer.from(candidateLayout),
    meta: Buffer.from(candidateMeta),
  };
}

function pdfOldPointer(overrides = {}) {
  return oldPointer({
    shared_award_source_id: pdfSourceId,
    source_url:
      "https://www.schwarzmanscholars.org/admissions/application-instructions.pdf",
    source_title: "2026 Application Instructions",
    source_page_type: "application_instructions",
    kind: "pdf",
    latest_captured_at: "2026-08-14T18:00:00.000Z",
    latest_object_keys: {
      pdf: "visual-snapshots/sources/schwarzman/captures/legacy/document.pdf",
      text: "visual-snapshots/sources/schwarzman/captures/legacy/text.txt",
      meta: "visual-snapshots/sources/schwarzman/captures/legacy/meta.json",
    },
    latest_hashes: {
      image_hash: sha256("legacy-pdf"),
      text_hash: sha256("legacy-pdf-text"),
      file_hash: sha256("legacy-pdf"),
    },
    latest_metadata: { schema: "legacy-pdf" },
    previous_captured_at: "2026-08-13T18:00:00.000Z",
    previous_object_keys: {
      pdf: "visual-snapshots/sources/schwarzman/captures/previous/document.pdf",
    },
    previous_hashes: {
      image_hash: sha256("previous-pdf"),
      file_hash: sha256("previous-pdf"),
    },
    previous_metadata: { schema: "legacy-pdf-previous" },
    ...overrides,
  });
}

function pdfCandidateArtifacts() {
  return {
    pdf: Buffer.from(candidatePdf),
    text: Buffer.from(candidatePdfText),
    meta: Buffer.from(candidatePdfMeta),
  };
}

function pdfCandidatePointer(existing = pdfOldPointer()) {
  const artifacts = pdfCandidateArtifacts();
  const bindings = Object.fromEntries(Object.entries(artifacts).map(([role, body]) => [
    role,
    {
      sha256: sha256(body),
      byte_length: body.length,
      content_type: artifactContentType(role),
      hash_mode: "raw_sha256",
    },
  ]));
  return buildLatestOnlyVisualSnapshotPointerReplacement({
    existing,
    replacement: {
      latest_captured_at: pdfCapturedAt,
      latest_object_keys: {
        pdf: `visual-snapshots/sources/${pdfSourceId}/captures/pdf-candidate/document.pdf`,
        text: `visual-snapshots/sources/${pdfSourceId}/captures/pdf-candidate/text.txt`,
        meta: `visual-snapshots/sources/${pdfSourceId}/captures/pdf-candidate/meta.json`,
      },
      latest_hashes: {
        image_hash: candidatePdfFileHash,
        text_hash: candidatePdfTextHash,
        body_text_hash: null,
        main_content_hash: null,
        nav_header_footer_hash: null,
        expansion_hash: null,
        layout_hash: null,
        file_hash: candidatePdfFileHash,
      },
      latest_metadata: {
        artifact_bindings_schema: "awardping.r2.capture-artifact-bindings.v1",
        artifact_bindings: bindings,
        text_length: candidatePdfSemanticText.length,
        text_object_bytes: candidatePdfText.length,
        file_bytes: candidatePdf.length,
      },
    },
    updatedAt: "2026-08-15T15:31:00.000Z",
  });
}

function pdfCandidateFixture() {
  const before = pdfOldPointer();
  return {
    sourceId: pdfSourceId,
    before,
    oldBaselineBytes: oldPdfBaseline,
    candidateBaselineBytes: candidatePdfBaseline,
    candidate: pdfCandidatePointer(before),
    candidateArtifacts: pdfCandidateArtifacts(),
  };
}

function artifactContentType(role) {
  if (new Set(["page", "thumb"]).has(role)) return "image/jpeg";
  if (role === "pdf") return "application/pdf";
  if (role === "text") return "text/plain; charset=utf-8";
  return "application/json; charset=utf-8";
}

function commitInput(harness, overrides = {}) {
  return {
    sourceId: harness.sourceId,
    transactionId: "upgrade-transaction-1",
    expectedActiveJournalSha256: null,
    expectedOldBaseline: baselineAuthority(harness.oldBaselineBytes),
    expectedOldPointerIdentity: pointerAuthority(harness.before),
    candidateBaselineBytes: harness.candidateBaselineBytes,
    candidatePointer: harness.candidate,
    candidateArtifacts: copyCandidateArtifacts(harness.candidateArtifacts),
    interfaces: harness.interfaces,
    now: monotonicClock(),
    ...overrides,
  };
}

function recoveryInput(memory, overrides = {}) {
  const journal = memory.state.activeJournal;
  if (!journal) throw new Error("recoveryInput requires one active journal fixture.");
  return {
    sourceId,
    transactionId: journal.transaction_id,
    expectedActiveJournalSha256: journal.journal_sha256,
    operationBinding: journal.operation_binding ?? null,
    interfaces: memory.interfaces,
    now: monotonicClock(),
    ...overrides,
  };
}

function baselineAuthority(bytes) {
  return {
    sha256: sha256(bytes),
    byte_length: bytes.byteLength,
  };
}

function pointerAuthority(pointer) {
  return {
    schema_version: VISUAL_SNAPSHOT_POINTER_IDENTITY_SCHEMA,
    exists: true,
    canonical_sha256: visualSnapshotPointerIdentity(pointer).canonical_sha256,
  };
}

function reviewedOperationBinding() {
  return buildStage1EvidenceSchemaUpgradeReviewedOperationBinding({
    sourceId,
    transactionId: "upgrade-transaction-1",
    reviewedApplyPlanFileSha256: sha256("reviewed-plan-file"),
    reviewedApplyPlanSha256: sha256("reviewed-plan"),
    auditRunId: "11111111-1111-4111-8111-111111111111",
    executionNonce: "22222222-2222-4222-8222-222222222222",
    reviewedReportAttemptId: "33333333-3333-4333-8333-333333333333",
    freshCaptureSha256: sha256("fresh-capture"),
    freshCaptureResultSha256: sha256("fresh-capture-result"),
    freshCaptureValidationSha256: sha256("fresh-capture-validation"),
    freshValidationProjectionSha256: sha256("fresh-validation-projection"),
    precommitAuthorityReceiptSha256: sha256("precommit-authority-receipt"),
    precommitSourceAuthority:
      buildStage1EvidenceSchemaUpgradePrecommitSourceAuthority({
        sourceId,
        sourceProjection: {
          admin_review_note: null,
          admin_review_status: "open",
          admin_reviewed_at: null,
          admin_reviewed_by: null,
          consecutive_failures: 0,
          created_at: "2026-08-01T00:00:00.000Z",
          display_title: "Reviewed source",
          id: sourceId,
          last_checked_at: null,
          last_error: null,
          last_hash: null,
          next_check_at: null,
          page_description: null,
          page_metadata: null,
          page_metadata_generated_at: null,
          page_metadata_model: null,
          page_type: "faq",
          reason: null,
          shared_award_id: "11111111-1111-4111-8111-111111111111",
          shared_awards: {
            id: "11111111-1111-4111-8111-111111111111",
            name: "Reviewed Award",
            official_homepage: "https://example.com",
            status: "active",
          },
          source: "manual",
          submitted_by_user_id: null,
          title: "Reviewed source",
          updated_at: "2026-08-14T17:45:00.000Z",
          url: "https://example.com/reviewed-source",
        },
      }),
  });
}

function monotonicClock() {
  let milliseconds = Date.parse("2026-08-14T18:03:00.000Z");
  return () => {
    const value = new Date(milliseconds).toISOString();
    milliseconds += 1_000;
    return value;
  };
}

function clone(value) {
  return value === null || value === undefined
    ? value
    : structuredClone(value);
}

function copyCandidateArtifacts(value) {
  return Object.fromEntries(Object.entries(value).map(([role, bytes]) => [
    role,
    Buffer.from(bytes),
  ]));
}

function harness({ casMode = "commit", crashBoundary = null, fixture = null } = {}) {
  const selected = fixture || (() => {
    const before = oldPointer();
    return {
      sourceId,
      before,
      oldBaselineBytes: oldBaseline,
      candidateBaselineBytes: candidateBaseline,
      candidate: candidatePointer(before),
      candidateArtifacts: candidateArtifacts(),
    };
  })();
  const selectedSourceId = selected.sourceId;
  const before = clone(selected.before);
  const proposed = clone(selected.candidate);
  const selectedOldBaseline = Buffer.from(selected.oldBaselineBytes);
  const selectedCandidateBaseline = Buffer.from(selected.candidateBaselineBytes);
  const selectedCandidateArtifacts = copyCandidateArtifacts(selected.candidateArtifacts);
  const state = {
    activeJournal: null,
    archivedJournals: [],
    baseline: Buffer.from(selectedOldBaseline),
    pointer: clone(before),
    objects: new Map(),
    events: [],
    casMode,
    crashBoundary,
    crashInjected: false,
    pointerReadError: null,
    baselineReadError: null,
    sourceHealthy: false,
    sourceHealthCalls: 0,
    deleteCalls: 0,
  };

  const interfaces = {
    async loadActiveJournal() {
      state.events.push(["load_journal", state.activeJournal?.phase ?? null]);
      return clone(state.activeJournal);
    },
    async persistActiveJournalAtomically({ journal, expected_journal_sha256: expected }) {
      state.events.push(["persist_journal", journal.phase]);
      const current = state.activeJournal?.journal_sha256 ?? null;
      if (current !== expected) throw new Error("journal CAS mismatch");
      state.activeJournal = clone(journal);
    },
    async archiveCompletedJournalAtomically({
      journal,
      expected_journal_sha256: expected,
      creates_api_charge: createsApiCharge,
    }) {
      state.events.push(["archive_journal", journal.phase]);
      expect(createsApiCharge).toBe(false);
      if (journal.phase !== "completed") throw new Error("archive before completion");
      if (state.activeJournal?.journal_sha256 !== expected) {
        throw new Error("archive journal CAS mismatch");
      }
      state.archivedJournals.push(clone(journal));
      state.activeJournal = null;
      return {
        status: "archived",
        source_id: journal.source_id,
        transaction_id: journal.transaction_id,
        journal_sha256: journal.journal_sha256,
        creates_api_charge: false,
      };
    },
    async readArchivedJournal({ transaction_id: transactionId }) {
      state.events.push(["read_archived_journal", transactionId]);
      return clone(state.archivedJournals.find(
        (journal) => journal.transaction_id === transactionId,
      ) ?? null);
    },
    async readBaselineBytes() {
      state.events.push(["read_baseline"]);
      if (state.baselineReadError) throw state.baselineReadError;
      return state.baseline === null ? null : Buffer.from(state.baseline);
    },
    async writeBaselineBytesAtomically({ bytes }) {
      state.events.push(["write_baseline", bytes === null ? null : Buffer.from(bytes).toString("utf8")]);
      state.baseline = bytes === null ? null : Buffer.from(bytes);
    },
    async readLatestPointer() {
      state.events.push(["read_pointer", state.pointer?.updated_at ?? null]);
      if (state.pointerReadError) throw state.pointerReadError;
      return clone(state.pointer);
    },
    async uploadImmutableCandidateArtifact(input) {
      state.events.push(["upload", input.slot, input.object_key]);
      expect(input.creates_api_charge).toBe(false);
      expect(input.bucket).toBe(proposed.bucket);
      const prior = state.objects.get(input.object_key);
      if (prior) {
        if (!Buffer.from(prior).equals(Buffer.from(input.bytes))) {
          throw new Error("immutable key collision");
        }
        return {
          status: "existing_verified",
          creates_api_charge: false,
          immutable: true,
          bucket: input.bucket,
          object_key: input.object_key,
          sha256: input.sha256,
          byte_length: input.byte_length,
          content_type: input.content_type,
          r2_writes: 0,
        };
      }
      state.objects.set(input.object_key, Buffer.from(input.bytes));
      return {
        status: "uploaded",
        creates_api_charge: false,
        immutable: true,
        bucket: input.bucket,
        object_key: input.object_key,
        sha256: input.sha256,
        byte_length: input.byte_length,
        content_type: input.content_type,
        r2_writes: 1,
      };
    },
    async compareAndSwapLatestPointer(input) {
      state.events.push(["pointer_cas", state.casMode]);
      expect(input.creates_api_charge).toBe(false);
      expect(input.preserve_previous_generation).toBe(true);
      expect(input.expected_pointer.previous_object_keys).toEqual(before.previous_object_keys);
      expect(input.candidate_pointer.previous_object_keys).toEqual(before.previous_object_keys);
      if (state.casMode === "commit") {
        state.pointer = clone(input.candidate_pointer);
        return true;
      }
      if (state.casMode === "false") return false;
      if (state.casMode === "false_after_commit") {
        state.pointer = clone(input.candidate_pointer);
        return false;
      }
      if (state.casMode === "throw_before") {
        throw Object.assign(new Error("transport failed before write"), { code: "transport_before" });
      }
      if (state.casMode === "throw_after") {
        state.pointer = clone(input.candidate_pointer);
        throw Object.assign(new Error("response lost after write"), { code: "response_lost" });
      }
      if (state.casMode === "third_party") {
        state.pointer = oldPointer({
          latest_object_keys: { page: "third-party/page.jpg" },
          latest_hashes: { image_hash: "third-party" },
          updated_at: "2026-08-14T18:09:00.000Z",
        });
        return false;
      }
      if (state.casMode === "unreadable_after") {
        state.pointerReadError = new Error("R2 pointer unavailable");
        return false;
      }
      throw new Error(`unknown CAS mode ${state.casMode}`);
    },
    async markSourceHealthSucceeded(input) {
      state.events.push(["source_health", state.sourceHealthy ? "already_current" : "succeeded"]);
      expect(input.preserve_reviewed_url).toBe(true);
      expect(input.preserve_reviewed_metadata).toBe(true);
      expect(state.pointer).toEqual(proposed);
      expect(state.baseline).toEqual(selectedCandidateBaseline);
      state.sourceHealthCalls += 1;
      if (state.sourceHealthy) {
        return sourceHealthReceipt("already_current", 0, selectedSourceId);
      }
      state.sourceHealthy = true;
      return sourceHealthReceipt("succeeded", 1, selectedSourceId);
    },
    async checkpoint({ boundary }) {
      state.events.push(["checkpoint", boundary]);
      if (state.crashBoundary === boundary && !state.crashInjected) {
        state.crashInjected = true;
        throw Object.assign(new Error(`crash at ${boundary}`), {
          code: "injected_process_crash",
        });
      }
    },
  };
  return {
    state,
    interfaces,
    sourceId: selectedSourceId,
    before,
    oldBaselineBytes: selectedOldBaseline,
    candidateBaselineBytes: selectedCandidateBaseline,
    candidate: proposed,
    candidateArtifacts: selectedCandidateArtifacts,
  };
}

function sourceHealthReceipt(status, writes, receiptSourceId = sourceId) {
  return {
    status,
    source_id: receiptSourceId,
    context: "stage1_evidence_schema_upgrade",
    creates_api_charge: false,
    mutation_counts: {
      database_writes: writes,
      r2_writes: 0,
      local_baseline_writes: 0,
      candidate_writes: 0,
      quarantine_writes: 0,
      source_state_writes: writes,
    },
  };
}

function eventIndex(state, eventName, detail = undefined) {
  return state.events.findIndex((event) => (
    event[0] === eventName && (detail === undefined || event[1] === detail)
  ));
}

function assertExactMutationCountShape(value) {
  expect(Object.keys(value).sort()).toEqual([
    "candidate_writes",
    "database_writes",
    "local_baseline_writes",
    "quarantine_writes",
    "r2_writes",
    "source_state_writes",
  ]);
  for (const count of Object.values(value)) {
    expect(Number.isSafeInteger(count)).toBe(true);
    expect(count).toBeGreaterThanOrEqual(0);
  }
}

describe("Stage 1 evidence-schema-upgrade commit ordering", () => {
  it("persists a sealed journal before artifacts, writes the baseline before CAS, and marks health last", async () => {
    const memory = harness();
    const result = await runStage1EvidenceSchemaUpgradeCommit(commitInput(memory));

    expect(result).toMatchObject({
      status: "upgraded",
      source_id: sourceId,
      context: "stage1_evidence_schema_upgrade",
      creates_api_charge: false,
      mutation_counts: {
        database_writes: 2,
        r2_writes: 5,
        local_baseline_writes: 1,
        candidate_writes: 0,
        quarantine_writes: 0,
        source_state_writes: 1,
      },
      receipt: {
        schema_version: STAGE1_EVIDENCE_SCHEMA_UPGRADE_COMMIT_RECEIPT_SCHEMA,
        operation: "pointer_commit",
        status: "upgraded",
        outcome: "committed_candidate",
        creates_api_charge: false,
        journal_phase: "completed",
        journal_archived: true,
        cleanup_delete_performed: false,
        cas: {
          confirmed_database_pointer_writes: 1,
        },
      },
    });
    assertExactMutationCountShape(result.mutation_counts);
    expect(memory.state.pointer).toEqual(memory.candidate);
    expect(memory.state.pointer.previous_captured_at).toBe(memory.before.previous_captured_at);
    expect(memory.state.pointer.previous_object_keys).toEqual(memory.before.previous_object_keys);
    expect(memory.state.pointer.previous_hashes).toEqual(memory.before.previous_hashes);
    expect(memory.state.pointer.previous_metadata).toEqual(memory.before.previous_metadata);
    expect(memory.state.baseline).toEqual(candidateBaseline);
    expect(memory.state.activeJournal).toBeNull();
    expect(memory.state.archivedJournals).toHaveLength(1);
    expect(memory.state.archivedJournals[0].phase).toBe("completed");
    expect(memory.state.archivedJournals[0].schema_version).toBe(
      STAGE1_EVIDENCE_SCHEMA_UPGRADE_JOURNAL_SCHEMA,
    );
    expect(memory.state.archivedJournals[0]).not.toHaveProperty(
      "operation_binding",
    );
    expect(result).not.toHaveProperty("reviewed_reconciliation_evidence");
    const journalArchiveAccounting =
      assertStage1EvidenceSchemaUpgradeJournalArchiveAccounting(
        result.receipt.mutation_accounting.evidence.journal_archive,
      );
    expect(journalArchiveAccounting).toMatchObject({
      schema_version:
        STAGE1_EVIDENCE_SCHEMA_UPGRADE_JOURNAL_ARCHIVE_ACCOUNTING_SCHEMA,
      state: "verified",
      local_journal_archive_writes_lower_bound: 1,
      archive_receipt_acknowledged: true,
      archived_readback_verified: true,
      active_absence_verified: true,
      response_loss_possible: false,
      evidence_sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
    expect(result.mutation_accounting.evidence.journal_archive)
      .toEqual(journalArchiveAccounting);
    expect(memory.state.deleteCalls).toBe(0);

    const prepared = eventIndex(memory.state, "persist_journal", "prepared");
    const reviewedBaselineRead = eventIndex(memory.state, "read_baseline");
    const firstUpload = eventIndex(memory.state, "upload");
    const baselineWrite = eventIndex(memory.state, "write_baseline");
    const localPhase = eventIndex(memory.state, "persist_journal", "local_candidate_written");
    const casPhase = eventIndex(memory.state, "persist_journal", "pointer_cas_attempted");
    const cas = eventIndex(memory.state, "pointer_cas");
    const health = eventIndex(memory.state, "source_health");
    const complete = eventIndex(memory.state, "persist_journal", "completed");
    const archive = eventIndex(memory.state, "archive_journal", "completed");
    const archivedRead = eventIndex(memory.state, "read_archived_journal");
    expect(reviewedBaselineRead).toBeGreaterThan(-1);
    expect(memory.state.events[reviewedBaselineRead + 1]).toEqual([
      "persist_journal",
      "prepared",
    ]);
    expect(prepared).toBeLessThan(firstUpload);
    expect(firstUpload).toBeLessThan(baselineWrite);
    expect(baselineWrite).toBeLessThan(localPhase);
    expect(localPhase).toBeLessThan(casPhase);
    expect(casPhase).toBeLessThan(cas);
    expect(cas).toBeLessThan(health);
    expect(health).toBeLessThan(complete);
    expect(complete).toBeLessThan(archive);
    expect(archive).toBeLessThan(archivedRead);
  });

  it("accepts a production-shaped PDF candidate with file_hash duplicated as image_hash", async () => {
    const memory = harness({ fixture: pdfCandidateFixture() });

    const result = await runStage1EvidenceSchemaUpgradeCommit(commitInput(memory));

    expect(result).toMatchObject({
      status: "upgraded",
      source_id: pdfSourceId,
      creates_api_charge: false,
      mutation_counts: {
        database_writes: 2,
        r2_writes: 3,
        local_baseline_writes: 1,
        candidate_writes: 0,
        quarantine_writes: 0,
        source_state_writes: 1,
      },
    });
    expect(memory.state.pointer).toEqual(memory.candidate);
    expect(memory.state.pointer.latest_hashes).toMatchObject({
      image_hash: candidatePdfFileHash,
      file_hash: candidatePdfFileHash,
      text_hash: candidatePdfTextHash,
    });
    expect(memory.state.baseline).toEqual(candidatePdfBaseline);
    expect(memory.state.archivedJournals).toHaveLength(1);
  });

  it("rejects a PDF pointer whose image_hash no longer aliases file_hash before mutation", async () => {
    const memory = harness({ fixture: pdfCandidateFixture() });
    const pointer = clone(memory.candidate);
    pointer.latest_hashes.image_hash = null;

    await expectZeroMutationRefusal(
      memory,
      commitInput(memory, { candidatePointer: pointer }),
      /latest_hashes.*baseline/i,
    );
  });

  it("rejects a PDF baseline whose image_hash no longer aliases file_hash before mutation", async () => {
    const memory = harness({ fixture: pdfCandidateFixture() });
    const baseline = JSON.parse(candidatePdfBaseline.toString("utf8"));
    baseline.image_hash = "0".repeat(64);

    await expectZeroMutationRefusal(
      memory,
      commitInput(memory, {
        candidateBaselineBytes: Buffer.from(`${JSON.stringify(baseline)}\n`, "utf8"),
      }),
      /PDF baseline image_hash.*file_hash/i,
    );
  });

  it("rejects PDF raw metadata whose image_hash no longer aliases file_hash before mutation", async () => {
    const memory = harness({ fixture: pdfCandidateFixture() });
    const artifacts = copyCandidateArtifacts(memory.candidateArtifacts);
    const metadata = JSON.parse(artifacts.meta.toString("utf8"));
    metadata.image_hash = "0".repeat(64);
    artifacts.meta = Buffer.from(JSON.stringify(metadata), "utf8");
    const pointer = clone(memory.candidate);
    pointer.latest_metadata.artifact_bindings.meta = {
      sha256: sha256(artifacts.meta),
      byte_length: artifacts.meta.length,
      content_type: "application/json; charset=utf-8",
      hash_mode: "raw_sha256",
    };

    await expectZeroMutationRefusal(
      memory,
      commitInput(memory, {
        candidatePointer: pointer,
        candidateArtifacts: artifacts,
      }),
      /raw metadata.*core identity/i,
    );
  });

  it("keeps generic commit on v1 while a reviewed operation binding emits exact journal v2", async () => {
    const memory = harness();
    const operationBinding = reviewedOperationBinding();

    const result = await runStage1EvidenceSchemaUpgradeCommit(commitInput(memory, {
      operationBinding,
    }));

    expect(result.status).toBe("upgraded");
    expect(memory.state.archivedJournals).toHaveLength(1);
    expect(memory.state.archivedJournals[0]).toMatchObject({
      schema_version: STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_JOURNAL_SCHEMA,
      transaction_id: operationBinding.transaction_id,
      source_id: operationBinding.source_id,
      operation_binding: operationBinding,
    });
    expect(memory.state.archivedJournals[0].operation_binding.binding_sha256)
      .toBe(operationBinding.binding_sha256);
    const evidence =
      assertStage1EvidenceSchemaUpgradeReviewedReconciliationEvidence(
        result.reviewed_reconciliation_evidence,
      );
    expect(evidence).toMatchObject({
      schema_version:
        STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_RECONCILIATION_EVIDENCE_SCHEMA,
      source_id: operationBinding.source_id,
      transaction_id: operationBinding.transaction_id,
      journal_sha256: result.receipt.journal_sha256,
      old_pointer_identity: visualSnapshotPointerIdentity(memory.before),
      candidate_pointer_identity: visualSnapshotPointerIdentity(memory.candidate),
      candidate_object_keys: memory.candidate.latest_object_keys,
      evidence_sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
    expect(Object.isFrozen(evidence)).toBe(true);
    expect(Object.isFrozen(evidence.candidate_pointer_identity.projection)).toBe(true);
    const tampered = clone(evidence);
    tampered.candidate_object_keys.page = "attacker/forged-page.jpg";
    expect(() => (
      assertStage1EvidenceSchemaUpgradeReviewedReconciliationEvidence(tampered)
    )).toThrow(/candidate object keys differ|seal does not match/u);
  });

  it.each(["false", "throw_before"])(
    "restores exact old bytes and never absorbs changed wording when CAS is %s",
    async (casMode) => {
      const memory = harness({ casMode });
      const result = await runStage1EvidenceSchemaUpgradeCommit(commitInput(memory));

      expect(result.status).toBe("abandoned_old_authority");
      expect(result.receipt).toMatchObject({
        operation: "pointer_commit",
        outcome: "abandoned_old_authority",
        creates_api_charge: false,
        cleanup_delete_performed: false,
        journal_phase: "completed",
        journal_archived: true,
      });
      expect(memory.state.pointer).toEqual(memory.before);
      expect(memory.state.baseline).toEqual(oldBaseline);
      expect(memory.state.baseline.toString("utf8")).not.toContain("materially changed wording");
      expect(memory.state.sourceHealthCalls).toBe(0);
      expect(memory.state.activeJournal).toBeNull();
      expect(memory.state.archivedJournals[0].phase_history.at(-1).detail)
        .toMatchObject({ outcome: "abandoned_old_authority" });
      expect(result.receipt.cleanup_debt.delete_performed).toBe(false);
      expect(memory.state.deleteCalls).toBe(0);
      assertExactMutationCountShape(result.mutation_counts);
    },
  );

  it.each(["false_after_commit", "throw_after"])(
    "reloads R2 after an inconclusive %s CAS and follows the exact candidate authority",
    async (casMode) => {
      const memory = harness({ casMode });
      const result = await runStage1EvidenceSchemaUpgradeCommit(commitInput(memory));

      expect(result.status).toBe("upgraded");
      expect(memory.state.pointer).toEqual(memory.candidate);
      expect(memory.state.baseline).toEqual(candidateBaseline);
      expect(memory.state.sourceHealthCalls).toBe(1);
      expect(result.receipt.cas).toMatchObject(casMode === "throw_after"
        ? { returned: null, threw: true, error_code: "response_lost" }
        : { returned: false, threw: false });
      expect(result.mutation_counts).toMatchObject({
        database_writes: 1,
        r2_writes: 5,
      });
      if (casMode === "throw_after") {
        expect(result.mutation_count_certainty).toEqual({
          exact: false,
          count_semantics: "confirmed_lower_bounds_with_unknown_writes",
          unknown_write_categories: ["database_writes"],
        });
        expect(result.receipt.mutation_accounting).toMatchObject({
          operation: "pointer_commit",
          exact: false,
          lower_bound_counts: result.mutation_counts,
          unknown_write_categories: ["database_writes"],
        });
      } else {
        expect(result.mutation_count_certainty.exact).toBe(true);
      }
      expect(result.receipt.cleanup_debt.delete_performed).toBe(false);
    },
  );

  it("seals confirmed upload lower bounds when an immutable upload response is lost", async () => {
    const memory = harness();
    const originalUpload = memory.interfaces.uploadImmutableCandidateArtifact;
    let calls = 0;
    memory.interfaces.uploadImmutableCandidateArtifact = async (input) => {
      calls += 1;
      if (calls === 2) {
        memory.state.objects.set(input.object_key, Buffer.from(input.bytes));
        throw Object.assign(new Error("immutable upload response lost"), {
          code: "r2_upload_response_lost",
        });
      }
      return originalUpload(input);
    };

    let failure;
    try {
      await runStage1EvidenceSchemaUpgradeCommit(commitInput(memory));
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      code: "r2_upload_response_lost",
      stage1_mutation_accounting: {
        operation: "pointer_commit",
        exact: false,
        lower_bound_counts: { r2_writes: 1 },
        unknown_write_categories: ["r2_writes"],
        evidence: {
          boundary: "candidate_artifact_upload",
          response_loss_possible: true,
        },
      },
    });
  });

  it("seals confirmed prior writes and uncertain source-health writes after response loss", async () => {
    const memory = harness();
    memory.interfaces.markSourceHealthSucceeded = async () => {
      memory.state.sourceHealthy = true;
      memory.state.sourceHealthCalls += 1;
      throw Object.assign(new Error("source-health response lost"), {
        code: "source_health_response_lost",
      });
    };

    let failure;
    try {
      await runStage1EvidenceSchemaUpgradeCommit(commitInput(memory));
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      code: "source_health_response_lost",
      stage1_mutation_accounting: {
        operation: "pointer_commit",
        exact: false,
        lower_bound_counts: {
          database_writes: 1,
          r2_writes: 5,
          local_baseline_writes: 1,
          source_state_writes: 0,
        },
        unknown_write_categories: ["database_writes", "source_state_writes"],
        evidence: {
          boundary: "source_health_update",
          response_loss_possible: true,
        },
      },
    });
  });

  it("accounts for an acknowledged active-journal write whose exact readback fails and recovers it next run", async () => {
    const memory = harness();
    const loadActiveJournal = memory.interfaces.loadActiveJournal;
    let loadCalls = 0;
    memory.interfaces.loadActiveJournal = async (input) => {
      loadCalls += 1;
      const observed = await loadActiveJournal(input);
      if (loadCalls === 2) {
        throw Object.assign(new Error("active journal readback unavailable"), {
          code: "active_journal_readback_unavailable",
        });
      }
      return observed;
    };

    let failure;
    try {
      await runStage1EvidenceSchemaUpgradeCommit(commitInput(memory));
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({
      code: "active_journal_readback_unavailable",
      stage1_mutation_accounting: {
        operation: "pointer_commit",
        exact: true,
        lower_bound_counts: {
          database_writes: 0,
          r2_writes: 0,
          local_baseline_writes: 0,
          candidate_writes: 0,
          quarantine_writes: 0,
          source_state_writes: 0,
        },
        unknown_write_categories: [],
        evidence: {
          boundary: "active_journal_write_acknowledged_readback_unverified",
          journal_phase: "prepared",
          response_loss_possible: false,
          journal_persistence: {
            state: "write_acknowledged_readback_unverified",
            local_journal_writes_lower_bound: 1,
            response_loss_possible: false,
          },
        },
      },
    });
    expect(memory.state.activeJournal?.phase).toBe("prepared");
    expect(memory.state.objects.size).toBe(0);
    expect(memory.state.pointer).toEqual(memory.before);
    expect(memory.state.baseline).toEqual(oldBaseline);

    const recovery = await runStage1EvidenceSchemaUpgradeCommit(
      recoveryInput(memory),
    );

    expect(recovery.status).toBe("abandoned_old_authority");
    expect(memory.state.activeJournal).toBeNull();
    expect(memory.state.archivedJournals).toHaveLength(1);
    expect(memory.state.archivedJournals[0]).toMatchObject({
      transaction_id: "upgrade-transaction-1",
      phase: "completed",
    });
    expect(memory.state.events.some((event) => event[0] === "upload")).toBe(false);
    expect(memory.state.events.some((event) => event[0] === "pointer_cas")).toBe(false);
    expect(memory.state.pointer).toEqual(memory.before);
    expect(memory.state.baseline).toEqual(oldBaseline);
  });

  it.each(["third_party", "unreadable_after"])(
    "leaves an ambiguous %s authority durably recovery_required without health or cleanup mutation",
    async (casMode) => {
      const memory = harness({ casMode });
      const result = await runStage1EvidenceSchemaUpgradeCommit(commitInput(memory));

      expect(result).toMatchObject({
        status: "recovery_required",
        creates_api_charge: false,
        receipt: {
          outcome: "ambiguous_authority",
          journal_phase: "recovery_required",
          journal_archived: false,
          cleanup_delete_performed: false,
        },
      });
      expect(memory.state.activeJournal?.phase).toBe("recovery_required");
      expect(memory.state.archivedJournals).toHaveLength(0);
      expect(memory.state.sourceHealthCalls).toBe(0);
      expect(memory.state.deleteCalls).toBe(0);
      const mutatingEventsBeforeRetry = memory.state.events.filter(isMutationEvent).length;
      const retry = await runStage1EvidenceSchemaUpgradeCommit(
        recoveryInput(memory),
      );
      expect(retry.status).toBe("recovery_required");
      expect(memory.state.events.filter(isMutationEvent)).toHaveLength(mutatingEventsBeforeRetry);
    },
  );

  it("refuses a missing existing pointer before journaling or uploading", async () => {
    const memory = harness();
    memory.state.pointer = null;
    await expect(runStage1EvidenceSchemaUpgradeCommit(commitInput(memory)))
      .rejects.toThrow(/requires an existing latest pointer/i);
    expect(memory.state.activeJournal).toBeNull();
    expect(memory.state.objects.size).toBe(0);
    expect(memory.state.events.some(isMutationEvent)).toBe(false);
  });

  it("requires an explicit null active-journal expectation for every fresh commit", async () => {
    const memory = harness();
    const input = commitInput(memory);
    delete input.expectedActiveJournalSha256;
    await expectZeroMutationRefusal(
      memory,
      input,
      /expectedActiveJournalSha256 null/i,
    );
  });

  it("refuses a journal that races a freshly reviewed commit without recovering it", async () => {
    const memory = harness();
    const racedJournal = clone(journalAtPhase(memory, "prepared"));
    memory.state.activeJournal = racedJournal;
    const eventsBefore = memory.state.events.length;

    await expect(runStage1EvidenceSchemaUpgradeCommit(commitInput(memory)))
      .rejects.toThrow(/active journal appeared after fresh reviewed authority/i);

    expect(memory.state.activeJournal).toEqual(racedJournal);
    expect(memory.state.events.slice(eventsBefore).some(isMutationEvent)).toBe(false);
    expect(memory.state.objects.size).toBe(0);
    expect(memory.state.pointer).toEqual(memory.before);
    expect(memory.state.baseline).toEqual(oldBaseline);
  });

  it.each([
    ["missing", (input) => { delete input.expectedOldBaseline; }],
    ["null", (input) => { input.expectedOldBaseline = null; }],
    ["missing hash", (input) => { delete input.expectedOldBaseline.sha256; }],
    ["missing length", (input) => { delete input.expectedOldBaseline.byte_length; }],
    ["null hash", (input) => { input.expectedOldBaseline.sha256 = null; }],
    ["uppercase hash", (input) => {
      input.expectedOldBaseline.sha256 = input.expectedOldBaseline.sha256.toUpperCase();
    }],
    ["negative length", (input) => { input.expectedOldBaseline.byte_length = -1; }],
    ["fractional length", (input) => { input.expectedOldBaseline.byte_length = 1.5; }],
    ["extra authority", (input) => { input.expectedOldBaseline.present = true; }],
  ])("refuses %s expected old-baseline authority before mutation", async (_label, mutate) => {
    const memory = harness();
    const input = commitInput(memory);
    mutate(input);
    await expectZeroMutationRefusal(
      memory,
      input,
      /expectedOldBaseline|old-baseline authority/i,
    );
  });

  it.each([
    ["SHA-256", (authority) => { authority.sha256 = "0".repeat(64); }],
    ["byte length", (authority) => { authority.byte_length += 1; }],
  ])("refuses reviewed old-baseline %s mismatch before mutation", async (_label, mutate) => {
    const memory = harness();
    const input = commitInput(memory);
    mutate(input.expectedOldBaseline);
    await expectZeroMutationRefusal(memory, input, /old baseline.*reviewed authority/i);
  });

  it("refuses an absent baseline under non-null reviewed old authority before mutation", async () => {
    const memory = harness();
    memory.state.baseline = null;
    await expectZeroMutationRefusal(
      memory,
      commitInput(memory),
      /old baseline.*reviewed authority/i,
    );
  });

  it("refuses same-semantic old-baseline byte drift before journaling", async () => {
    const memory = harness();
    const semanticBaseline = JSON.parse(oldBaseline.toString("utf8"));
    memory.state.baseline = Buffer.from(`${JSON.stringify(semanticBaseline, null, 2)}\n`, "utf8");
    expect(JSON.parse(memory.state.baseline.toString("utf8")))
      .toEqual(JSON.parse(oldBaseline.toString("utf8")));
    expect(memory.state.baseline).not.toEqual(oldBaseline);

    await expectZeroMutationRefusal(
      memory,
      commitInput(memory),
      /old baseline.*reviewed authority/i,
    );
    expect(memory.state.events.at(-1)).toEqual(["read_baseline"]);
  });

  it.each([
    ["missing", (input) => { delete input.expectedOldPointerIdentity; }],
    ["null", (input) => { input.expectedOldPointerIdentity = null; }],
    ["missing hash", (input) => {
      delete input.expectedOldPointerIdentity.canonical_sha256;
    }],
    ["missing schema", (input) => {
      delete input.expectedOldPointerIdentity.schema_version;
    }],
    ["missing existence", (input) => {
      delete input.expectedOldPointerIdentity.exists;
    }],
    ["null hash", (input) => {
      input.expectedOldPointerIdentity.canonical_sha256 = null;
    }],
    ["wrong schema", (input) => {
      input.expectedOldPointerIdentity.schema_version = "wrong";
    }],
    ["absent identity", (input) => {
      input.expectedOldPointerIdentity.exists = false;
    }],
    ["uppercase hash", (input) => {
      input.expectedOldPointerIdentity.canonical_sha256 =
        input.expectedOldPointerIdentity.canonical_sha256.toUpperCase();
    }],
    ["extra authority", (input) => {
      input.expectedOldPointerIdentity.projection = {};
    }],
  ])("refuses %s expected old-pointer identity before mutation", async (_label, mutate) => {
    const memory = harness();
    const input = commitInput(memory);
    mutate(input);
    await expectZeroMutationRefusal(
      memory,
      input,
      /expectedOldPointerIdentity|old-pointer identity/i,
    );
  });

  it("refuses a reviewed old-pointer identity mismatch before mutation", async () => {
    const memory = harness();
    const input = commitInput(memory);
    input.expectedOldPointerIdentity.canonical_sha256 = "0".repeat(64);
    await expectZeroMutationRefusal(
      memory,
      input,
      /old pointer.*reviewed identity/i,
    );
    expect(memory.state.events.at(-1)[0]).toBe("read_pointer");
  });

  it("refuses loaded old-pointer metadata drift before reading or journaling the baseline", async () => {
    const memory = harness();
    memory.state.pointer.latest_metadata = {
      ...memory.state.pointer.latest_metadata,
      unreviewed_provenance: "drifted",
    };
    await expectZeroMutationRefusal(
      memory,
      commitInput(memory),
      /old pointer.*reviewed identity/i,
    );
    expect(memory.state.events.at(-1)[0]).toBe("read_pointer");
    expect(memory.state.events.some((event) => event[0] === "read_baseline")).toBe(false);
  });

  it("refuses a candidate pointer without an exact immutable-artifact bucket before mutation", async () => {
    const memory = harness();
    const pointer = clone(memory.candidate);
    pointer.bucket = "";
    await expect(runStage1EvidenceSchemaUpgradeCommit(commitInput(memory, {
      candidatePointer: pointer,
    }))).rejects.toThrow(/candidate pointer bucket/i);
    expect(memory.state.activeJournal).toBeNull();
    expect(memory.state.objects.size).toBe(0);
    expect(memory.state.events.some(isMutationEvent)).toBe(false);
  });

  it.each([
    ["schema", (pointer) => { pointer.latest_metadata.artifact_bindings_schema = "stale"; }],
    ["role set", (pointer) => { delete pointer.latest_metadata.artifact_bindings.layout; }],
    ["sha256", (pointer) => { pointer.latest_metadata.artifact_bindings.page.sha256 = "0".repeat(64); }],
    ["byte length", (pointer) => { pointer.latest_metadata.artifact_bindings.thumb.byte_length += 1; }],
    ["content type", (pointer) => {
      pointer.latest_metadata.artifact_bindings.text.content_type = "text/plain";
    }],
  ])("rejects candidate artifact-binding %s drift before journaling or upload", async (_label, mutate) => {
    const memory = harness();
    const pointer = clone(memory.candidate);
    mutate(pointer);
    await expect(runStage1EvidenceSchemaUpgradeCommit(commitInput(memory, {
      candidatePointer: pointer,
    }))).rejects.toThrow(/artifact|role|binding/i);
    expect(memory.state.activeJournal).toBeNull();
    expect(memory.state.objects.size).toBe(0);
    expect(memory.state.events.some(isMutationEvent)).toBe(false);
  });

  it("rejects pointer core hashes that differ from the candidate baseline before mutation", async () => {
    const memory = harness();
    const pointer = clone(memory.candidate);
    pointer.latest_hashes.image_hash = "f".repeat(64);
    await expect(runStage1EvidenceSchemaUpgradeCommit(commitInput(memory, {
      candidatePointer: pointer,
    }))).rejects.toThrow(/latest_hashes.*baseline/i);
    expect(memory.state.activeJournal).toBeNull();
    expect(memory.state.objects.size).toBe(0);
  });

  it("rejects artifact bytes that differ from their exact pointer binding before mutation", async () => {
    const memory = harness();
    const artifacts = candidateArtifacts();
    artifacts.page = Buffer.from("different candidate image");
    await expect(runStage1EvidenceSchemaUpgradeCommit(commitInput(memory, {
      candidateArtifacts: artifacts,
    }))).rejects.toThrow(/binding.*page|page.*binding/i);
    expect(memory.state.activeJournal).toBeNull();
    expect(memory.state.objects.size).toBe(0);
  });

  it("refuses an upload receipt from a bucket other than the candidate pointer bucket before CAS", async () => {
    const memory = harness();
    const upload = memory.interfaces.uploadImmutableCandidateArtifact;
    memory.interfaces.uploadImmutableCandidateArtifact = async (input) => ({
      ...await upload(input),
      bucket: "wrong-evidence-bucket",
    });
    await expect(runStage1EvidenceSchemaUpgradeCommit(commitInput(memory)))
      .rejects.toThrow(/upload receipt.*artifact-bound/i);
    expect(memory.state.pointer).toEqual(memory.before);
    expect(memory.state.baseline).toEqual(oldBaseline);
    expect(memory.state.activeJournal?.phase).toBe("prepared");
    expect(memory.state.events.some((event) => event[0] === "pointer_cas")).toBe(false);
  });

  it("does not accept archive completion without exact durable archived-journal readback", async () => {
    const memory = harness();
    memory.interfaces.readArchivedJournal = async () => null;
    await expect(runStage1EvidenceSchemaUpgradeCommit(commitInput(memory)))
      .rejects.toThrow(/journal must be an object|archived.*read back/i);
    expect(memory.state.events.some((event) => event[0] === "archive_journal")).toBe(true);
    expect(memory.state.sourceHealthCalls).toBe(1);
  });

  it.each([
    {
      label: "archive write response loss",
      fault: "archive_response_lost",
      state: "archive_write_response_unknown",
      lowerBound: 0,
      receiptAcknowledged: false,
      archivedReadbackVerified: false,
      responseLossPossible: true,
      activeRemains: false,
    },
    {
      label: "unverified archive receipt after the write",
      fault: "invalid_archive_receipt",
      state: "archive_receipt_unverified",
      lowerBound: 0,
      receiptAcknowledged: false,
      archivedReadbackVerified: false,
      responseLossPossible: true,
      activeRemains: false,
    },
    {
      label: "archived-journal readback failure",
      fault: "archived_readback_failed",
      state: "archive_write_acknowledged_readback_unverified",
      lowerBound: 1,
      receiptAcknowledged: true,
      archivedReadbackVerified: false,
      responseLossPossible: true,
      activeRemains: false,
    },
    {
      label: "active-absence read response loss",
      fault: "active_absence_response_lost",
      state: "archived_readback_verified_active_absence_response_unknown",
      lowerBound: 1,
      receiptAcknowledged: true,
      archivedReadbackVerified: true,
      responseLossPossible: true,
      activeRemains: false,
    },
    {
      label: "observed active journal after an acknowledged archive",
      fault: "active_still_present",
      state: "archived_readback_verified_active_still_present",
      lowerBound: 1,
      receiptAcknowledged: true,
      archivedReadbackVerified: true,
      responseLossPossible: false,
      activeRemains: true,
    },
  ])("seals $label without presenting zero pointer counts as archive certainty", async ({
    fault,
    state,
    lowerBound,
    receiptAcknowledged,
    archivedReadbackVerified,
    responseLossPossible,
    activeRemains,
  }) => {
    const memory = completedReviewedRecoveryHarness();
    const archive = memory.interfaces.archiveCompletedJournalAtomically;
    if (fault === "archive_response_lost") {
      memory.interfaces.archiveCompletedJournalAtomically = async (input) => {
        await archive(input);
        throw Object.assign(new Error("archive response lost"), {
          code: "archive_response_lost",
        });
      };
    } else if (fault === "invalid_archive_receipt") {
      memory.interfaces.archiveCompletedJournalAtomically = async (input) => ({
        ...await archive(input),
        status: "not_archived",
      });
    } else if (fault === "archived_readback_failed") {
      memory.interfaces.readArchivedJournal = async () => {
        throw Object.assign(new Error("archived readback unavailable"), {
          code: "archived_readback_unavailable",
        });
      };
    } else if (fault === "active_absence_response_lost") {
      const load = memory.interfaces.loadActiveJournal;
      let calls = 0;
      memory.interfaces.loadActiveJournal = async (input) => {
        calls += 1;
        if (calls === 2) {
          throw Object.assign(new Error("active absence response lost"), {
            code: "active_absence_response_lost",
          });
        }
        return load(input);
      };
    } else if (fault === "active_still_present") {
      memory.interfaces.archiveCompletedJournalAtomically = async (input) => {
        const receipt = await archive(input);
        memory.state.activeJournal = clone(input.journal);
        return receipt;
      };
    }

    let failure;
    try {
      await runStage1EvidenceSchemaUpgradeCommit(recoveryInput(memory));
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect(failure.stage1_mutation_accounting).toMatchObject({
      operation: "pointer_commit",
      exact: true,
      lower_bound_counts: {
        database_writes: 0,
        r2_writes: 0,
        local_baseline_writes: 0,
        candidate_writes: 0,
        quarantine_writes: 0,
        source_state_writes: 0,
      },
      unknown_write_categories: [],
      evidence: {
        response_loss_possible: responseLossPossible,
        journal_archive: {
          schema_version:
            STAGE1_EVIDENCE_SCHEMA_UPGRADE_JOURNAL_ARCHIVE_ACCOUNTING_SCHEMA,
          state,
          local_journal_archive_writes_lower_bound: lowerBound,
          archive_receipt_acknowledged: receiptAcknowledged,
          archived_readback_verified: archivedReadbackVerified,
          active_absence_verified: false,
          response_loss_possible: responseLossPossible,
          evidence_sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
        },
      },
    });
    expect(() => assertStage1EvidenceSchemaUpgradeJournalArchiveAccounting({
      ...failure.stage1_mutation_accounting.evidence.journal_archive,
      state: "verified",
    })).toThrow(/archive accounting/i);
    expect(memory.state.archivedJournals).toHaveLength(1);
    expect(memory.state.archivedJournals[0]).toMatchObject({
      schema_version: STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_JOURNAL_SCHEMA,
      phase: "completed",
      operation_binding: reviewedOperationBinding(),
    });
    expect(memory.state.activeJournal === null).toBe(!activeRemains);
  });

  it("requires the archived-journal reader interface before any mutation", async () => {
    const memory = harness();
    delete memory.interfaces.readArchivedJournal;
    await expect(runStage1EvidenceSchemaUpgradeCommit(commitInput(memory)))
      .rejects.toThrow(/readArchivedJournal interface is required/i);
    expect(memory.state.events.some(isMutationEvent)).toBe(false);
  });
});

describe("Stage 1 evidence-schema-upgrade crash recovery", () => {
  it.each([
    ["missing transaction", (input) => { delete input.transactionId; }],
    ["mismatched transaction", (input) => { input.transactionId = "wrong-transaction"; }],
    ["missing journal hash", (input) => { delete input.expectedActiveJournalSha256; }],
    ["mismatched journal hash", (input) => {
      input.expectedActiveJournalSha256 = "0".repeat(64);
    }],
  ])("refuses %s before active-journal recovery mutation", async (_label, mutate) => {
    const memory = harness();
    memory.state.activeJournal = clone(journalAtPhase(memory, "prepared"));
    const originalJournal = clone(memory.state.activeJournal);
    const input = recoveryInput(memory);
    mutate(input);
    const eventsBefore = memory.state.events.length;

    await expect(runStage1EvidenceSchemaUpgradeCommit(input)).rejects.toThrow(
      /recovery transaction|expected recovery journal/i,
    );

    expect(memory.state.activeJournal).toEqual(originalJournal);
    expect(memory.state.events.slice(eventsBefore).some(isMutationEvent)).toBe(false);
    expect(memory.state.pointer).toEqual(memory.before);
    expect(memory.state.baseline).toEqual(oldBaseline);
  });

  it("refuses v2 recovery without the exact reviewed operation binding", async () => {
    const memory = harness({ crashBoundary: "prepared_journal_persisted" });
    const operationBinding = reviewedOperationBinding();
    await expect(runStage1EvidenceSchemaUpgradeCommit(commitInput(memory, {
      operationBinding,
    }))).rejects.toMatchObject({ code: "injected_process_crash" });
    expect(memory.state.activeJournal?.schema_version).toBe(
      STAGE1_EVIDENCE_SCHEMA_UPGRADE_REVIEWED_JOURNAL_SCHEMA,
    );
    memory.state.crashBoundary = null;
    const input = recoveryInput(memory);
    input.operationBinding = null;
    const eventsBefore = memory.state.events.length;

    await expect(runStage1EvidenceSchemaUpgradeCommit(input)).rejects.toThrow(
      /requires its exact operation binding/i,
    );

    expect(memory.state.events.slice(eventsBefore).some(isMutationEvent)).toBe(false);
    expect(memory.state.activeJournal?.operation_binding).toEqual(operationBinding);
  });

  it("abandons an active prepared journal with pending uploads under exact old authority", async () => {
    const memory = harness();
    memory.state.activeJournal = clone(journalAtPhase(memory, "prepared"));
    const uploadedKey = memory.candidate.latest_object_keys.page;
    memory.state.objects.set(uploadedKey, Buffer.from(candidatePage));

    const result = await runStage1EvidenceSchemaUpgradeCommit(
      recoveryInput(memory),
    );

    expect(result.status).toBe("abandoned_old_authority");
    expect(memory.state.pointer).toEqual(memory.before);
    expect(memory.state.baseline).toEqual(oldBaseline);
    expect(memory.state.objects.get(uploadedKey)).toEqual(candidatePage);
    expect(memory.state.events.some((event) => event[0] === "upload")).toBe(false);
    expect(memory.state.events.some((event) => event[0] === "pointer_cas")).toBe(false);
    expect(memory.state.deleteCalls).toBe(0);
    expect(memory.state.activeJournal).toBeNull();
  });

  it.each(STAGE1_EVIDENCE_SCHEMA_UPGRADE_COMMIT_BOUNDARIES)(
    "recovers safely after a process crash at %s",
    async (boundary) => {
      const casMode = boundary === "authoritative_baseline_repaired" ? "false" : "commit";
      const memory = harness({ casMode, crashBoundary: boundary });
      await expect(runStage1EvidenceSchemaUpgradeCommit(commitInput(memory)))
        .rejects.toMatchObject({ code: "injected_process_crash" });
      expect(memory.state.crashInjected).toBe(true);

      const result = await runStage1EvidenceSchemaUpgradeCommit(
        memory.state.activeJournal
          ? recoveryInput(memory, {
              candidateBaselineBytes: Buffer.from("untrusted replacement"),
              candidatePointer: oldPointer({ updated_at: "2026-08-14T18:20:00.000Z" }),
              candidateArtifacts: { page: Buffer.from("untrusted") },
            })
          : commitInput(memory),
      );

      expect(["upgraded", "abandoned_old_authority"]).toContain(result.status);
      expect(memory.state.activeJournal).toBeNull();
      expect(memory.state.archivedJournals).toHaveLength(1);
      expect(memory.state.archivedJournals[0].transaction_id).toBe("upgrade-transaction-1");
      expect(memory.state.archivedJournals[0].phase).toBe("completed");
      expect(memory.state.deleteCalls).toBe(0);
      assertExactMutationCountShape(result.mutation_counts);
      if (result.status === "upgraded") {
        expect(memory.state.pointer).toEqual(memory.candidate);
        expect(memory.state.baseline).toEqual(candidateBaseline);
      } else {
        expect(memory.state.pointer).toEqual(memory.before);
        expect(memory.state.baseline).toEqual(oldBaseline);
        expect(memory.state.sourceHealthCalls).toBe(0);
      }
    },
  );

  it("repairs exact candidate bytes from a journal when CAS committed before the process died", async () => {
    const memory = harness({ crashBoundary: "pointer_cas_settled" });
    await expect(runStage1EvidenceSchemaUpgradeCommit(commitInput(memory))).rejects.toThrow();
    expect(memory.state.pointer).toEqual(memory.candidate);
    memory.state.baseline = Buffer.from(oldBaseline);
    memory.state.crashBoundary = null;

    const result = await runStage1EvidenceSchemaUpgradeCommit(
      recoveryInput(memory),
    );
    expect(result.status).toBe("upgraded");
    expect(result.mutation_counts.local_baseline_writes).toBe(1);
    expect(memory.state.baseline).toEqual(candidateBaseline);
    expect(memory.state.pointer.previous_object_keys).toEqual(memory.before.previous_object_keys);
    expect(memory.state.sourceHealthCalls).toBe(1);
  });

  it("repairs exact old bytes from a journal and abandons when CAS never changed authority", async () => {
    const memory = harness({ crashBoundary: "pointer_cas_attempt_phase_persisted" });
    await expect(runStage1EvidenceSchemaUpgradeCommit(commitInput(memory))).rejects.toThrow();
    expect(memory.state.pointer).toEqual(memory.before);
    expect(memory.state.baseline).toEqual(candidateBaseline);
    memory.state.crashBoundary = null;

    const result = await runStage1EvidenceSchemaUpgradeCommit(
      recoveryInput(memory),
    );
    expect(result.status).toBe("abandoned_old_authority");
    expect(result.mutation_counts.local_baseline_writes).toBe(1);
    expect(memory.state.baseline).toEqual(oldBaseline);
    expect(memory.state.pointer).toEqual(memory.before);
    expect(memory.state.sourceHealthCalls).toBe(0);
  });
});

describe("Stage 1 evidence-schema-upgrade phase by authority recovery matrix", () => {
  const phases = [
    "prepared",
    "local_candidate_written",
    "pointer_cas_attempted",
    "pointer_candidate_committed",
    "recovery_required",
    "completed",
  ];
  const authorities = ["old", "candidate", "third", "unreadable"];

  it.each(phases.flatMap((phase) => authorities.map((authority) => [phase, authority])))(
    "%s with %s pointer authority resolves only from exact R2 identity",
    async (phase, authority) => {
      const memory = harness();
      memory.state.activeJournal = journalAtPhase(memory, phase);
      memory.state.baseline = authority === "candidate"
        ? Buffer.from(oldBaseline)
        : Buffer.from(candidateBaseline);
      if (authority === "old") memory.state.pointer = clone(memory.before);
      if (authority === "candidate") memory.state.pointer = clone(memory.candidate);
      if (authority === "third") {
        memory.state.pointer = oldPointer({
          latest_object_keys: { page: "third-party/page.jpg" },
          latest_hashes: { image_hash: "third-party" },
          updated_at: "2026-08-14T18:30:00.000Z",
        });
      }
      if (authority === "unreadable") {
        memory.state.pointerReadError = new Error("authoritative pointer unreadable");
      }

      const result = await runStage1EvidenceSchemaUpgradeCommit(
        recoveryInput(memory),
      );

      if (authority === "candidate") {
        expect(result.status).toBe("upgraded");
        expect(memory.state.pointer).toEqual(memory.candidate);
        expect(memory.state.baseline).toEqual(candidateBaseline);
        expect(memory.state.activeJournal).toBeNull();
        expect(memory.state.archivedJournals.at(-1)?.phase).toBe("completed");
      } else if (authority === "old") {
        expect(result.status).toBe("abandoned_old_authority");
        expect(memory.state.pointer).toEqual(memory.before);
        expect(memory.state.baseline).toEqual(oldBaseline);
        expect(memory.state.sourceHealthCalls).toBe(0);
        expect(memory.state.activeJournal).toBeNull();
        expect(memory.state.archivedJournals.at(-1)?.phase_history.at(-1)?.detail)
          .toMatchObject({ outcome: "abandoned_old_authority" });
      } else {
        expect(result.status).toBe("recovery_required");
        expect(memory.state.activeJournal?.phase).toBe("recovery_required");
        expect(memory.state.archivedJournals).toHaveLength(0);
        expect(memory.state.sourceHealthCalls).toBe(0);
      }
      expect(result.receipt.cleanup_delete_performed).toBe(false);
      expect(memory.state.deleteCalls).toBe(0);
    },
  );
});

function completedReviewedRecoveryHarness() {
  const memory = harness();
  const operationBinding = reviewedOperationBinding();
  memory.state.activeJournal = clone(journalAtPhase(memory, "completed", {
    operationBinding,
  }));
  memory.state.pointer = clone(memory.candidate);
  memory.state.baseline = Buffer.from(candidateBaseline);
  memory.state.sourceHealthy = true;
  return memory;
}

function journalAtPhase(memory, targetPhase, { operationBinding = null } = {}) {
  let journal = buildStage1EvidenceSchemaUpgradeJournal({
    transactionId: operationBinding?.transaction_id || `fixture-${targetPhase}`,
    sourceId,
    oldBaselineBytes: oldBaseline,
    oldPointer: memory.before,
    candidateBaselineBytes: candidateBaseline,
    candidatePointer: memory.candidate,
    operationBinding,
    createdAt: "2026-08-14T18:03:00.000Z",
  });
  if (targetPhase === "prepared") return journal;
  journal = advanceStage1EvidenceSchemaUpgradeJournal(journal, {
    expectedPhase: "prepared",
    nextPhase: "local_candidate_written",
    at: "2026-08-14T18:04:00.000Z",
    detail: { fixture: true },
  });
  if (targetPhase === "local_candidate_written") return journal;
  journal = advanceStage1EvidenceSchemaUpgradeJournal(journal, {
    expectedPhase: "local_candidate_written",
    nextPhase: "pointer_cas_attempted",
    at: "2026-08-14T18:05:00.000Z",
    detail: { fixture: true },
  });
  if (targetPhase === "pointer_cas_attempted") return journal;
  if (targetPhase === "recovery_required") {
    return advanceStage1EvidenceSchemaUpgradeJournal(journal, {
      expectedPhase: "pointer_cas_attempted",
      nextPhase: "recovery_required",
      at: "2026-08-14T18:06:00.000Z",
      detail: { fixture: true },
    });
  }
  journal = advanceStage1EvidenceSchemaUpgradeJournal(journal, {
    expectedPhase: "pointer_cas_attempted",
    nextPhase: "pointer_candidate_committed",
    at: "2026-08-14T18:06:00.000Z",
    detail: { fixture: true },
  });
  if (targetPhase === "pointer_candidate_committed") return journal;
  return advanceStage1EvidenceSchemaUpgradeJournal(journal, {
    expectedPhase: "pointer_candidate_committed",
    nextPhase: "completed",
    at: "2026-08-14T18:07:00.000Z",
    detail: {
      outcome: "committed_candidate",
      authoritative_pointer_sha256: journal.candidate_pointer_identity.canonical_sha256,
      authoritative_baseline_sha256: journal.candidate_baseline.sha256,
      source_health_status: "succeeded",
      cleanup_debt_delete_performed: false,
      fixture: true,
    },
  });
}

function isMutationEvent(event) {
  return new Set([
    "persist_journal",
    "archive_journal",
    "write_baseline",
    "upload",
    "pointer_cas",
    "source_health",
  ]).has(event[0]);
}

async function expectZeroMutationRefusal(memory, input, messagePattern) {
  const initialPointer = clone(memory.state.pointer);
  const initialBaseline = memory.state.baseline === null
    ? null
    : Buffer.from(memory.state.baseline);
  let failure;
  try {
    await runStage1EvidenceSchemaUpgradeCommit(input);
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(Error);
  expect(failure.message).toMatch(messagePattern);
  expect(failure.stage1_mutation_accounting).toMatchObject({
    operation: "pointer_commit",
    exact: true,
    lower_bound_counts: {
      database_writes: 0,
      r2_writes: 0,
      local_baseline_writes: 0,
      candidate_writes: 0,
      quarantine_writes: 0,
      source_state_writes: 0,
    },
    unknown_write_categories: [],
    evidence: { response_loss_possible: false },
  });
  expect(memory.state.events.some(isMutationEvent)).toBe(false);
  expect(memory.state.activeJournal).toBeNull();
  expect(memory.state.objects.size).toBe(0);
  expect(memory.state.pointer).toEqual(initialPointer);
  expect(memory.state.baseline).toEqual(initialBaseline);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
