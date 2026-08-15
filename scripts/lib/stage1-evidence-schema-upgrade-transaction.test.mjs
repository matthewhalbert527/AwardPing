import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  advanceStage1EvidenceSchemaUpgradeJournal,
  assertStage1EvidenceSchemaUpgradeJournal,
  buildStage1EvidenceSchemaUpgradeJournal,
  classifyStage1EvidenceSchemaUpgradeRecovery,
  stage1EvidenceSchemaUpgradeBaselineBytes,
} from "./stage1-evidence-schema-upgrade-transaction.mjs";
import { buildLatestOnlyVisualSnapshotPointerReplacement } from "./visual-snapshot-latest-only-reconciliation.mjs";

const oldBaseline = Buffer.from('{\r\n  "version": 1,\r\n  "schema": "legacy"\r\n}\r\n', "utf8");
const candidateBaseline = Buffer.from('{\n  "version": 2,\n  "schema": "current"\n}\n', "utf8");

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function oldPointer(overrides = {}) {
  return {
    shared_award_source_id: "source-1",
    shared_award_id: "award-1",
    source_url: "https://example.test/award",
    source_title: "Award",
    source_page_type: "overview",
    kind: "webpage",
    bucket: "evidence",
    latest_captured_at: "2026-08-14T18:00:00.000Z",
    latest_object_keys: { page: "generation-2/page.jpg", meta: "generation-2/meta.json" },
    latest_hashes: { image_hash: "image-2" },
    latest_metadata: { schema: "legacy" },
    previous_captured_at: "2026-08-13T18:00:00.000Z",
    previous_object_keys: { page: "generation-1/page.jpg" },
    previous_hashes: { image_hash: "image-1" },
    previous_metadata: { schema: "legacy" },
    updated_at: "2026-08-14T18:01:00.000Z",
    ...overrides,
  };
}

function candidatePointer(existing = oldPointer()) {
  return buildLatestOnlyVisualSnapshotPointerReplacement({
    existing,
    replacement: {
      latest_captured_at: existing.latest_captured_at,
      latest_object_keys: { page: "generation-3/page.jpg", meta: "generation-3/meta.json" },
      latest_hashes: { image_hash: "image-2", manifest_hash: "manifest-3" },
      latest_metadata: { schema: "current" },
    },
    updatedAt: "2026-08-14T18:02:00.000Z",
  });
}

function journalFixture(overrides = {}) {
  const before = overrides.oldPointer === undefined ? oldPointer() : overrides.oldPointer;
  const proposed = overrides.candidatePointer
    || (before ? candidatePointer(before) : oldPointer({
      latest_object_keys: { page: "generation-3/page.jpg", meta: "generation-3/meta.json" },
      latest_metadata: { schema: "current" },
      updated_at: "2026-08-14T18:02:00.000Z",
    }));
  return buildStage1EvidenceSchemaUpgradeJournal({
    transactionId: "upgrade-1",
    sourceId: "source-1",
    oldBaselineBytes: overrides.oldBaselineBytes === undefined
      ? oldBaseline
      : overrides.oldBaselineBytes,
    oldPointer: before,
    candidateBaselineBytes: overrides.candidateBaselineBytes || candidateBaseline,
    candidatePointer: proposed,
    createdAt: "2026-08-14T18:01:30.000Z",
  });
}

describe("Stage 1 evidence-schema upgrade journal", () => {
  it("journals exact old and candidate bytes, hashes, pointer identities, keys, and phase", () => {
    const journal = journalFixture();

    expect(journal).toMatchObject({
      transaction_id: "upgrade-1",
      source_id: "source-1",
      phase: "prepared",
      old_baseline: {
        present: true,
        byte_length: oldBaseline.length,
        sha256: sha256(oldBaseline),
      },
      candidate_baseline: {
        present: true,
        byte_length: candidateBaseline.length,
        sha256: sha256(candidateBaseline),
      },
      candidate_object_keys: {
        page: "generation-3/page.jpg",
        meta: "generation-3/meta.json",
      },
    });
    expect(journal.old_baseline.bytes_base64).toBe(oldBaseline.toString("base64"));
    expect(journal.candidate_baseline.bytes_base64).toBe(candidateBaseline.toString("base64"));
    expect(journal.old_pointer_identity.canonical_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(journal.candidate_pointer_identity.canonical_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(journal.journal_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(stage1EvidenceSchemaUpgradeBaselineBytes(journal.old_baseline)).toEqual(oldBaseline);
    expect(stage1EvidenceSchemaUpgradeBaselineBytes(journal.candidate_baseline))
      .toEqual(candidateBaseline);
  });

  it("represents an absent old baseline and pointer without inventing bytes", () => {
    const journal = journalFixture({
      oldBaselineBytes: null,
      oldPointer: null,
      candidatePointer: oldPointer({
        latest_object_keys: { page: "generation-3/page.jpg", meta: "generation-3/meta.json" },
        latest_metadata: { schema: "current" },
        previous_captured_at: null,
        previous_object_keys: {},
        previous_hashes: {},
        previous_metadata: {},
        updated_at: "2026-08-14T18:02:00.000Z",
      }),
    });
    expect(journal.old_baseline).toEqual({
      present: false,
      encoding: null,
      bytes_base64: null,
      byte_length: 0,
      sha256: null,
    });
    expect(journal.old_pointer_identity).toMatchObject({
      exists: false,
      canonical_sha256: null,
      projection: null,
    });
    expect(stage1EvidenceSchemaUpgradeBaselineBytes(journal.old_baseline)).toBeNull();
  });

  it("advances phases with an expected-phase guard without mutating the prior journal", () => {
    const prepared = journalFixture();
    const localWritten = advanceStage1EvidenceSchemaUpgradeJournal(prepared, {
      expectedPhase: "prepared",
      nextPhase: "local_candidate_written",
      at: "2026-08-14T18:03:00.000Z",
      detail: { baseline_sha256: prepared.candidate_baseline.sha256 },
    });

    expect(prepared.phase).toBe("prepared");
    expect(prepared.phase_history).toHaveLength(1);
    expect(localWritten.phase).toBe("local_candidate_written");
    expect(localWritten.phase_history).toHaveLength(2);
    expect(localWritten.journal_sha256).not.toBe(prepared.journal_sha256);
    expect(() => advanceStage1EvidenceSchemaUpgradeJournal(localWritten, {
      expectedPhase: "prepared",
      nextPhase: "pointer_cas_attempted",
      at: "2026-08-14T18:04:00.000Z",
    })).toThrow(/phase changed/i);
    expect(() => advanceStage1EvidenceSchemaUpgradeJournal(prepared, {
      expectedPhase: "prepared",
      nextPhase: "pointer_candidate_committed",
      at: "2026-08-14T18:04:00.000Z",
    })).toThrow(/invalid.*transition/i);
  });

  it("rejects tampered byte bindings, pointer projections, keys, and journal seals", () => {
    const journal = journalFixture();
    for (const mutate of [
      (value) => { value.old_baseline.bytes_base64 = Buffer.from("tampered").toString("base64"); },
      (value) => { value.candidate_pointer_identity.projection.latest_metadata.schema = "tampered"; },
      (value) => { value.candidate_object_keys.page = "other/page.jpg"; },
      (value) => { value.phase = "completed"; },
    ]) {
      const tampered = structuredClone(journal);
      mutate(tampered);
      expect(() => assertStage1EvidenceSchemaUpgradeJournal(tampered)).toThrow();
    }
  });

  it("rejects a candidate pointer that rotates or replaces historical previous evidence", () => {
    const before = oldPointer();
    const proposed = candidatePointer(before);
    proposed.previous_object_keys = before.latest_object_keys;
    expect(() => buildStage1EvidenceSchemaUpgradeJournal({
      transactionId: "unsafe-upgrade",
      sourceId: "source-1",
      oldBaselineBytes: oldBaseline,
      oldPointer: before,
      candidateBaselineBytes: candidateBaseline,
      candidatePointer: proposed,
      createdAt: "2026-08-14T18:02:00.000Z",
    })).toThrow(/changed preserved previous_object_keys/i);
  });
});

describe("Stage 1 evidence-schema upgrade recovery", () => {
  it("classifies only an exact old baseline and old pointer as old", () => {
    const journal = journalFixture();
    expect(classifyStage1EvidenceSchemaUpgradeRecovery({
      journal,
      currentBaselineBytes: Buffer.from(oldBaseline),
      currentPointer: structuredClone(journal.old_pointer_identity.projection),
    })).toMatchObject({
      classification: "old",
      baseline_state: "old",
      pointer_state: "old",
    });
  });

  it("classifies only an exact candidate baseline and pointer as candidate", () => {
    const journal = journalFixture();
    expect(classifyStage1EvidenceSchemaUpgradeRecovery({
      journal,
      currentBaselineBytes: Buffer.from(candidateBaseline),
      currentPointer: structuredClone(journal.candidate_pointer_identity.projection),
    })).toMatchObject({
      classification: "candidate",
      baseline_state: "candidate",
      pointer_state: "candidate",
    });
  });

  it("restores old local bytes when the authoritative pointer retained old", () => {
    const journal = journalFixture();
    expect(classifyStage1EvidenceSchemaUpgradeRecovery({
      journal,
      currentBaselineBytes: candidateBaseline,
      currentPointer: journal.old_pointer_identity.projection,
    })).toMatchObject({
      classification: "old",
      reason: "authoritative_pointer_matches_old_identity",
      safe_action: "restore_exact_journaled_old_baseline",
      baseline_state: "candidate",
      pointer_state: "old",
      baseline_repair_required: true,
      target_baseline_sha256: sha256(oldBaseline),
    });
  });

  it("writes candidate local bytes when the authoritative pointer committed candidate", () => {
    const journal = journalFixture();
    expect(classifyStage1EvidenceSchemaUpgradeRecovery({
      journal,
      currentBaselineBytes: oldBaseline,
      currentPointer: journal.candidate_pointer_identity.projection,
    })).toMatchObject({
      classification: "candidate",
      reason: "authoritative_pointer_matches_candidate_identity",
      safe_action: "write_exact_journaled_candidate_baseline_then_revalidate",
      baseline_state: "old",
      pointer_state: "candidate",
      baseline_repair_required: true,
      target_baseline_sha256: sha256(candidateBaseline),
    });
  });

  it("classifies unreadable or third-party recovery state as ambiguous", () => {
    const journal = journalFixture();
    expect(classifyStage1EvidenceSchemaUpgradeRecovery({
      journal,
      currentBaselineBytes: undefined,
      currentPointer: undefined,
    })).toMatchObject({
      classification: "ambiguous",
      reason: "authoritative_pointer_unreadable",
    });
    expect(classifyStage1EvidenceSchemaUpgradeRecovery({
      journal,
      currentBaselineBytes: Buffer.from("different bytes"),
      currentPointer: oldPointer({ updated_at: "2026-08-14T18:09:00.000Z" }),
    })).toMatchObject({
      classification: "ambiguous",
      baseline_state: "other",
      pointer_state: "other",
    });
    expect(classifyStage1EvidenceSchemaUpgradeRecovery({
      journal,
      currentBaselineBytes: oldBaseline,
      currentPointer: { shared_award_source_id: "source-1", updated_at: "not-a-date" },
    })).toMatchObject({
      classification: "ambiguous",
      reason: "authoritative_pointer_unreadable",
      pointer_state: "unreadable",
    });
  });

  it("uses authoritative R2 even when the local baseline cannot be read", () => {
    const journal = journalFixture();
    expect(classifyStage1EvidenceSchemaUpgradeRecovery({
      journal,
      currentBaselineBytes: { not: "bytes" },
      currentPointer: journal.old_pointer_identity.projection,
    })).toMatchObject({
      classification: "old",
      baseline_state: "unreadable",
      pointer_state: "old",
      baseline_repair_required: true,
      safe_action: "restore_exact_journaled_old_baseline",
    });
  });

  it("uses pointer identity to decide when old and candidate baseline bytes are identical", () => {
    const journal = journalFixture({ candidateBaselineBytes: oldBaseline });
    expect(classifyStage1EvidenceSchemaUpgradeRecovery({
      journal,
      currentBaselineBytes: oldBaseline,
      currentPointer: journal.candidate_pointer_identity.projection,
    })).toMatchObject({
      classification: "candidate",
      baseline_state: "both",
      pointer_state: "candidate",
    });
  });

  it("recognizes a fully absent old state without confusing it with an unreadable state", () => {
    const journal = journalFixture({
      oldBaselineBytes: null,
      oldPointer: null,
      candidatePointer: oldPointer({
        latest_object_keys: { page: "generation-3/page.jpg", meta: "generation-3/meta.json" },
        latest_metadata: { schema: "current" },
        previous_captured_at: null,
        previous_object_keys: {},
        previous_hashes: {},
        previous_metadata: {},
        updated_at: "2026-08-14T18:02:00.000Z",
      }),
    });
    expect(classifyStage1EvidenceSchemaUpgradeRecovery({
      journal,
      currentBaselineBytes: null,
      currentPointer: null,
    })).toMatchObject({
      classification: "old",
      baseline_state: "old",
      pointer_state: "old",
    });
  });
});
