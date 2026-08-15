import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  STAGE1_EVIDENCE_SCHEMA_UPGRADE_COMMIT_BOUNDARIES,
  STAGE1_EVIDENCE_SCHEMA_UPGRADE_COMMIT_RECEIPT_SCHEMA,
  runStage1EvidenceSchemaUpgradeCommit,
} from "./stage1-evidence-schema-upgrade-commit.mjs";
import {
  advanceStage1EvidenceSchemaUpgradeJournal,
  buildStage1EvidenceSchemaUpgradeJournal,
} from "./stage1-evidence-schema-upgrade-transaction.mjs";
import { buildLatestOnlyVisualSnapshotPointerReplacement } from "./visual-snapshot-latest-only-reconciliation.mjs";

const sourceId = "source-1";
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

function artifactContentType(role) {
  if (new Set(["page", "thumb"]).has(role)) return "image/jpeg";
  if (role === "text") return "text/plain; charset=utf-8";
  return "application/json; charset=utf-8";
}

function commitInput(harness, overrides = {}) {
  return {
    sourceId,
    transactionId: "upgrade-transaction-1",
    candidateBaselineBytes: candidateBaseline,
    candidatePointer: harness.candidate,
    candidateArtifacts: candidateArtifacts(),
    interfaces: harness.interfaces,
    now: monotonicClock(),
    ...overrides,
  };
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

function harness({ casMode = "commit", crashBoundary = null } = {}) {
  const before = oldPointer();
  const proposed = candidatePointer(before);
  const state = {
    activeJournal: null,
    archivedJournals: [],
    baseline: Buffer.from(oldBaseline),
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
      expect(state.baseline).toEqual(candidateBaseline);
      state.sourceHealthCalls += 1;
      if (state.sourceHealthy) {
        return sourceHealthReceipt("already_current", 0);
      }
      state.sourceHealthy = true;
      return sourceHealthReceipt("succeeded", 1);
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
  return { state, interfaces, before, candidate: proposed };
}

function sourceHealthReceipt(status, writes) {
  return {
    status,
    source_id: sourceId,
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
    expect(memory.state.deleteCalls).toBe(0);

    const prepared = eventIndex(memory.state, "persist_journal", "prepared");
    const firstUpload = eventIndex(memory.state, "upload");
    const baselineWrite = eventIndex(memory.state, "write_baseline");
    const localPhase = eventIndex(memory.state, "persist_journal", "local_candidate_written");
    const casPhase = eventIndex(memory.state, "persist_journal", "pointer_cas_attempted");
    const cas = eventIndex(memory.state, "pointer_cas");
    const health = eventIndex(memory.state, "source_health");
    const complete = eventIndex(memory.state, "persist_journal", "completed");
    const archive = eventIndex(memory.state, "archive_journal", "completed");
    const archivedRead = eventIndex(memory.state, "read_archived_journal");
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
      const retry = await runStage1EvidenceSchemaUpgradeCommit({
        sourceId,
        interfaces: memory.interfaces,
        now: monotonicClock(),
      });
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

  it("requires the archived-journal reader interface before any mutation", async () => {
    const memory = harness();
    delete memory.interfaces.readArchivedJournal;
    await expect(runStage1EvidenceSchemaUpgradeCommit(commitInput(memory)))
      .rejects.toThrow(/readArchivedJournal interface is required/i);
    expect(memory.state.events.some(isMutationEvent)).toBe(false);
  });
});

describe("Stage 1 evidence-schema-upgrade crash recovery", () => {
  it("abandons an active prepared journal with pending uploads under exact old authority", async () => {
    const memory = harness();
    memory.state.activeJournal = clone(journalAtPhase(memory, "prepared"));
    const uploadedKey = memory.candidate.latest_object_keys.page;
    memory.state.objects.set(uploadedKey, Buffer.from(candidatePage));

    const result = await runStage1EvidenceSchemaUpgradeCommit({
      sourceId,
      interfaces: memory.interfaces,
      now: monotonicClock(),
    });

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
          ? {
              sourceId,
              transactionId: "ignored-because-recovery-runs-first",
              candidateBaselineBytes: Buffer.from("untrusted replacement"),
              candidatePointer: oldPointer({ updated_at: "2026-08-14T18:20:00.000Z" }),
              candidateArtifacts: { page: Buffer.from("untrusted") },
              interfaces: memory.interfaces,
              now: monotonicClock(),
            }
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

    const result = await runStage1EvidenceSchemaUpgradeCommit({
      sourceId,
      interfaces: memory.interfaces,
      now: monotonicClock(),
    });
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

    const result = await runStage1EvidenceSchemaUpgradeCommit({
      sourceId,
      interfaces: memory.interfaces,
      now: monotonicClock(),
    });
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

      const result = await runStage1EvidenceSchemaUpgradeCommit({
        sourceId,
        interfaces: memory.interfaces,
        now: monotonicClock(),
      });

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

function journalAtPhase(memory, targetPhase) {
  let journal = buildStage1EvidenceSchemaUpgradeJournal({
    transactionId: `fixture-${targetPhase}`,
    sourceId,
    oldBaselineBytes: oldBaseline,
    oldPointer: memory.before,
    candidateBaselineBytes: candidateBaseline,
    candidatePointer: memory.candidate,
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

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
