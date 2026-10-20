import { describe, expect, it } from "vitest";
import {
  assertLatestOnlyVisualSnapshotPointerReplacement,
  buildLatestOnlyVisualSnapshotPointerReplacement,
  planLatestOnlyVisualSnapshotPointerReconciliation,
  visualSnapshotPointerIdentity,
  visualSnapshotPointerMatchesIdentity,
  visualSnapshotPointerReferencedKeys,
} from "./visual-snapshot-latest-only-reconciliation.mjs";

function pointer(overrides = {}) {
  return {
    shared_award_source_id: "source-1",
    shared_award_id: "award-1",
    source_url: "https://example.test/eligibility",
    source_title: "Eligibility",
    source_page_type: "eligibility",
    kind: "webpage",
    bucket: "awardping-evidence",
    latest_captured_at: "2026-08-14T18:00:00.000Z",
    latest_object_keys: {
      page: "visual-snapshots/sources/source-1/captures/generation-2/page.jpg",
      text: "visual-snapshots/sources/source-1/captures/generation-2/text.txt",
    },
    latest_hashes: { image_hash: "image-2", text_hash: "text-2" },
    latest_metadata: { schema: "legacy" },
    previous_captured_at: "2026-08-13T18:00:00.000Z",
    previous_object_keys: {
      page: "visual-snapshots/sources/source-1/captures/generation-1/page.jpg",
    },
    previous_hashes: { image_hash: "image-1" },
    previous_metadata: { schema: "legacy" },
    updated_at: "2026-08-14T18:01:00.000Z",
    ...overrides,
  };
}

function candidate(existing = pointer(), overrides = {}) {
  return buildLatestOnlyVisualSnapshotPointerReplacement({
    existing,
    replacement: {
      latest_captured_at: "2026-08-14T18:00:00.000Z",
      latest_object_keys: {
        page: "visual-snapshots/sources/source-1/captures/generation-3/page.jpg",
        text: "visual-snapshots/sources/source-1/captures/generation-3/text.txt",
      },
      latest_hashes: { image_hash: "image-2", text_hash: "text-2", layout_hash: "layout-3" },
      latest_metadata: { schema: "current" },
      ...overrides,
    },
    updatedAt: "2026-08-14T18:02:00.000Z",
  });
}

describe("latest-only visual snapshot pointer replacement", () => {
  it("replaces latest while preserving the historical previous generation exactly", () => {
    const existing = pointer();
    const next = candidate(existing);

    expect(next.latest_object_keys.page).toContain("generation-3");
    expect(next.previous_captured_at).toBe(existing.previous_captured_at);
    expect(next.previous_object_keys).toEqual(existing.previous_object_keys);
    expect(next.previous_hashes).toEqual(existing.previous_hashes);
    expect(next.previous_metadata).toEqual(existing.previous_metadata);
    expect(next.previous_object_keys).not.toEqual(existing.latest_object_keys);
    expect(next.shared_award_source_id).toBe(existing.shared_award_source_id);
  });

  it("rejects an attempted previous-generation override", () => {
    expect(() => buildLatestOnlyVisualSnapshotPointerReplacement({
      existing: pointer(),
      replacement: {
        latest_captured_at: "2026-08-14T18:00:00.000Z",
        latest_object_keys: { page: "candidate/page.jpg" },
        latest_hashes: {},
        latest_metadata: {},
        previous_object_keys: {},
      },
      updatedAt: "2026-08-14T18:02:00.000Z",
    })).toThrow(/must not supply previous_object_keys/i);
  });

  it("rejects a candidate that mutates preserved previous state", () => {
    const existing = pointer();
    const next = candidate(existing);
    next.previous_hashes = { image_hash: "silently-replaced" };
    expect(() => assertLatestOnlyVisualSnapshotPointerReplacement(existing, next))
      .toThrow(/changed preserved previous_hashes/i);
  });

  it("rejects identity changes and a non-advancing CAS version", () => {
    const existing = pointer();
    for (const [field, changed] of [
      ["shared_award_source_id", "source-2"],
      ["shared_award_id", "award-2"],
      ["source_url", "https://example.test/different"],
      ["source_title", "Different"],
      ["source_page_type", "faq"],
      ["kind", "pdf"],
      ["bucket", "different-bucket"],
      ["previous_captured_at", "2026-08-12T18:00:00.000Z"],
      ["previous_object_keys", {}],
      ["previous_hashes", {}],
      ["previous_metadata", {}],
    ]) {
      const changedIdentity = candidate(existing);
      changedIdentity[field] = changed;
      expect(
        () => assertLatestOnlyVisualSnapshotPointerReplacement(existing, changedIdentity),
        field,
      ).toThrow(new RegExp(`changed preserved ${field}`, "i"));
    }

    const staleVersion = candidate(existing);
    staleVersion.updated_at = existing.updated_at;
    expect(() => assertLatestOnlyVisualSnapshotPointerReplacement(existing, staleVersion))
      .toThrow(/must advance.*updated_at/i);
  });

  it("uses a full canonical pointer identity and normalizes equivalent timestamps", () => {
    const existing = pointer();
    const identity = visualSnapshotPointerIdentity(existing);
    expect(identity.canonical_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(visualSnapshotPointerMatchesIdentity({
      ...existing,
      updated_at: "2026-08-14T13:01:00-05:00",
    }, identity)).toBe(true);
    expect(visualSnapshotPointerMatchesIdentity({
      ...existing,
      latest_metadata: { schema: "different" },
    }, identity)).toBe(false);
  });

  it("returns the de-duplicated union of latest and previous references", () => {
    expect(visualSnapshotPointerReferencedKeys(pointer({
      latest_object_keys: { page: "same/page.jpg", text: "latest/text.txt" },
      previous_object_keys: { page: "same/page.jpg", text: "previous/text.txt" },
    }))).toEqual(["latest/text.txt", "previous/text.txt", "same/page.jpg"]);
  });
});

const fixedSourceId = "11111111-1111-4111-8111-111111111111";
const fixedKey = (generation, filename) => `visual-snapshots/sources/${fixedSourceId}/${generation}/${filename}`;
const modernKey = (generation, filename = "page.jpg") =>
  `visual-snapshots/sources/${fixedSourceId}/captures/${generation}/${filename}`;

describe("fixed legacy retention in latest-only cleanup debt", () => {
  it("records displaced legacy latest originals as protected, never eligible or deferred cleanup", () => {
    const legacy = [fixedKey("latest", "page.jpg"), fixedKey("latest", "meta.json"),
      fixedKey("previous", "document.pdf"), fixedKey("previous", "expansion-state-99-layout.json")];
    const published = "visual-snapshots/published/immutable/main/full.jpg";
    const modern = modernKey("old");
    const approved = `visual-snapshots/sources/${fixedSourceId}/approved/old/meta.json`;
    const existing = pointer({ shared_award_source_id: fixedSourceId,
      latest_object_keys: Object.fromEntries([...legacy, published, modern, approved].map((key, index) => [String(index), key])) });
    const before = structuredClone(existing);
    const proposed = candidate(existing, { latest_object_keys: { page: modernKey("new") } });
    const result = planLatestOnlyVisualSnapshotPointerReconciliation({ existing, candidate: proposed,
      current: proposed, outcome: "committed", uploadedKeys: proposed.latest_object_keys });
    expect(result.classification).toBe("candidate");
    expect(result.cleanup_debt).toMatchObject({ delete_performed: false, eligible_keys: [], eligible_count: 0,
      protected_keys: [...legacy, published].sort(), deferred_keys: [modern, approved].sort(),
      requires_published_reference_graph_check: true });
    expect(existing).toEqual(before);
    expect(proposed.previous_object_keys).toEqual(before.previous_object_keys);
  });

  it.each(["cas_lost", "failed_before_cas"])("keeps unreferenced fixed uploads protected after %s and exact old readback", (outcome) => {
    const existing = pointer({ shared_award_source_id: fixedSourceId });
    const legacy = [fixedKey("latest", "text.txt"), fixedKey("previous", "page.html.txt"),
      fixedKey("latest", "expansion-state-01.jpg"), fixedKey("previous", "expansion-state-10-layout.json")];
    const published = "visual-snapshots/published/immutable/current/main/full.jpg";
    const ordinary = modernKey("uncommitted");
    const approved = `visual-snapshots/sources/${fixedSourceId}/approved/uncommitted/meta.json`;
    const proposed = candidate(existing, {
      latest_object_keys: Object.fromEntries([...legacy, published, ordinary, approved].map((key, index) => [String(index), key])),
    });
    const before = structuredClone({ existing, proposed });
    const result = planLatestOnlyVisualSnapshotPointerReconciliation({ existing, candidate: proposed,
      current: existing, outcome, uploadedKeys: proposed.latest_object_keys });
    expect(result.classification).toBe("old");
    expect(result.cleanup_debt).toMatchObject({ protected_keys: [...legacy, published].sort(),
      eligible_keys: [ordinary, approved].sort(), eligible_count: 2, deferred_keys: [],
      requires_authoritative_recheck: false, delete_performed: false });
    expect({ existing, proposed }).toEqual(before);
  });

  it("defers only non-protected uploads when an ambiguous outcome has no authoritative readback", () => {
    const existing = pointer({ shared_award_source_id: fixedSourceId });
    const legacy = fixedKey("previous", "thumb.jpg"), ordinary = modernKey("ambiguous");
    const proposed = candidate(existing, { latest_object_keys: { legacy, ordinary } });
    const result = planLatestOnlyVisualSnapshotPointerReconciliation({ existing, candidate: proposed,
      outcome: "ambiguous_error", uploadedKeys: proposed.latest_object_keys });
    expect(result.classification).toBe("ambiguous");
    expect(result.cleanup_debt).toMatchObject({ protected_keys: [legacy, ordinary].sort(), eligible_keys: [],
      eligible_count: 0, deferred_keys: [ordinary], requires_authoritative_recheck: true, delete_performed: false });
  });

  it("uses the existing normalized-key view for retention without rewriting pointer bytes", () => {
    const existing = pointer({ shared_award_source_id: fixedSourceId });
    const legacy = fixedKey("latest", "layout.json");
    const proposed = candidate(existing, { latest_object_keys: { legacy: ` ${legacy} ` } });
    const before = structuredClone(proposed);
    const result = planLatestOnlyVisualSnapshotPointerReconciliation({ existing, candidate: proposed,
      current: existing, outcome: "cas_lost", uploadedKeys: proposed.latest_object_keys });
    expect(result.cleanup_debt).toMatchObject({ protected_keys: [legacy], candidate_keys: [legacy],
      eligible_keys: [], eligible_count: 0, deferred_keys: [], delete_performed: false });
    expect(proposed).toEqual(before);
  });
});

describe("latest-only visual snapshot reconciliation planning", () => {
  it("classifies a confirmed commit as candidate and records only superseded latest debt", () => {
    const existing = pointer();
    const proposed = candidate(existing);
    const result = planLatestOnlyVisualSnapshotPointerReconciliation({
      existing,
      candidate: proposed,
      outcome: "committed",
      uploadedKeys: proposed.latest_object_keys,
    });

    expect(result).toMatchObject({
      classification: "candidate",
      reason: "candidate_pointer_commit_confirmed",
      cleanup_debt: {
        delete_performed: false,
        requires_authoritative_recheck: false,
        requires_published_reference_graph_check: true,
        eligible_count: 0,
      },
    });
    expect(result.cleanup_debt.eligible_keys).toEqual([]);
    expect(result.cleanup_debt.deferred_keys).toEqual(
      Object.values(existing.latest_object_keys).sort(),
    );
    expect(result.cleanup_debt.deferred_keys).not.toContain(
      existing.previous_object_keys.page,
    );
  });

  it("classifies a definite pre-CAS failure as old and records unreferenced uploads", () => {
    const existing = pointer();
    const proposed = candidate(existing);
    const result = planLatestOnlyVisualSnapshotPointerReconciliation({
      existing,
      candidate: proposed,
      outcome: "failed_before_cas",
      uploadedKeys: proposed.latest_object_keys,
    });

    expect(result.classification).toBe("old");
    expect(result.cleanup_debt).toMatchObject({
      eligible_keys: [],
      requires_authoritative_recheck: true,
    });
    expect(result.cleanup_debt.deferred_keys).toEqual(
      Object.values(proposed.latest_object_keys).sort(),
    );
  });

  it("classifies a lost CAS against the reloaded old pointer without deleting its references", () => {
    const existing = pointer();
    const proposed = candidate(existing, {
      latest_object_keys: {
        page: "visual-snapshots/sources/source-1/captures/generation-3/page.jpg",
        shared: existing.latest_object_keys.text,
      },
    });
    const result = planLatestOnlyVisualSnapshotPointerReconciliation({
      existing,
      candidate: proposed,
      current: structuredClone(existing),
      outcome: "cas_lost",
      uploadedKeys: proposed.latest_object_keys,
    });

    expect(result.classification).toBe("old");
    expect(result.cleanup_debt.protected_keys).toEqual([existing.latest_object_keys.text]);
    expect(result.cleanup_debt.eligible_keys).toEqual([
      proposed.latest_object_keys.page,
    ]);
  });

  it("reconciles an ambiguous RPC error when the exact candidate is observed", () => {
    const existing = pointer();
    const proposed = candidate(existing);
    const result = planLatestOnlyVisualSnapshotPointerReconciliation({
      existing,
      candidate: proposed,
      current: structuredClone(proposed),
      outcome: "ambiguous_error",
      uploadedKeys: proposed.latest_object_keys,
    });

    expect(result).toMatchObject({
      classification: "candidate",
      reason: "candidate_observed_after_ambiguous_cas_error",
    });
    expect(result.cleanup_debt.deferred_keys).toEqual(
      Object.values(existing.latest_object_keys).sort(),
    );
    expect(result.cleanup_debt.eligible_keys).toEqual([]);
  });

  it("never makes an old captures/ key eligible without a published-reference graph check", () => {
    const publishedEventCaptureKey =
      "visual-snapshots/sources/source-1/captures/event-owned-generation/page.jpg";
    const existing = pointer({
      latest_object_keys: { page: publishedEventCaptureKey },
    });
    const proposed = candidate(existing);
    const result = planLatestOnlyVisualSnapshotPointerReconciliation({
      existing,
      candidate: proposed,
      current: proposed,
      outcome: "committed",
      uploadedKeys: proposed.latest_object_keys,
    });

    expect(result.classification).toBe("candidate");
    expect(result.cleanup_debt).toMatchObject({
      eligible_keys: [],
      deferred_keys: [publishedEventCaptureKey],
      requires_published_reference_graph_check: true,
      delete_performed: false,
    });
  });

  it("fails closed when a winner matches neither identity and defers all cleanup", () => {
    const existing = pointer();
    const proposed = candidate(existing);
    const winner = pointer({
      latest_object_keys: { page: "winner/page.jpg" },
      latest_hashes: { image_hash: "winner" },
      updated_at: "2026-08-14T18:03:00.000Z",
    });
    const result = planLatestOnlyVisualSnapshotPointerReconciliation({
      existing,
      candidate: proposed,
      current: winner,
      outcome: "cas_lost",
      uploadedKeys: proposed.latest_object_keys,
    });

    expect(result).toMatchObject({
      classification: "ambiguous",
      cleanup_debt: {
        delete_performed: false,
        requires_authoritative_recheck: true,
        eligible_keys: [],
      },
    });
    expect(result.cleanup_debt.candidate_keys).toEqual(
      Object.values(proposed.latest_object_keys).sort(),
    );
    expect(result.cleanup_debt.deferred_keys).toEqual(
      Object.values(proposed.latest_object_keys).sort(),
    );
  });

  it("rejects cleanup inputs that are not bound to the candidate pointer", () => {
    const existing = pointer();
    const proposed = candidate(existing);
    expect(() => planLatestOnlyVisualSnapshotPointerReconciliation({
      existing,
      candidate: proposed,
      outcome: "failed_before_cas",
      uploadedKeys: [...Object.values(proposed.latest_object_keys), "unrelated/object.jpg"],
    })).toThrow(/outside the candidate pointer/i);
  });

  it("categorically excludes permanent published evidence from cleanup eligibility", () => {
    const existing = pointer();
    const published = "visual-snapshots/published/candidate-1/current/main/full.jpg";
    const proposed = candidate(existing, {
      latest_object_keys: { page: published, text: "candidate/text.txt" },
    });
    const result = planLatestOnlyVisualSnapshotPointerReconciliation({
      existing,
      candidate: proposed,
      current: existing,
      outcome: "failed_before_cas",
      uploadedKeys: proposed.latest_object_keys,
    });

    expect(result.cleanup_debt.protected_keys).toContain(published);
    expect(result.cleanup_debt.eligible_keys).toEqual(["candidate/text.txt"]);
  });
});
