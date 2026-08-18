import { describe, expect, it } from "vitest";
import {
  buildStage1EvidenceSchemaUpgradeSourceHealthAuthority,
  classifyStage1EvidenceSchemaUpgradeSourceHealthAuthority,
  projectStage1EvidenceSchemaUpgradeSourceHealthAuthority,
} from "./stage1-evidence-schema-upgrade-reviewed-source-authority.mjs";

const sourceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

describe("reviewed Stage 1 source-health recovery authority", () => {
  it("requires the exact canonical live source row projection", () => {
    const row = sourceRow();
    expect(projectStage1EvidenceSchemaUpgradeSourceHealthAuthority(row)).toEqual(row);
    expect(() => projectStage1EvidenceSchemaUpgradeSourceHealthAuthority({
      ...row,
      unexpected: true,
    })).toThrow(/unexpected fields/i);
    const missing = structuredClone(row);
    delete missing.admin_review_status;
    expect(() => projectStage1EvidenceSchemaUpgradeSourceHealthAuthority(missing))
      .toThrow(/missing admin_review_status/i);
  });

  it("distinguishes exact precommit state from the one allowed health transition", () => {
    const before = sourceRow();
    const authority = buildStage1EvidenceSchemaUpgradeSourceHealthAuthority(before);
    expect(classifyStage1EvidenceSchemaUpgradeSourceHealthAuthority({
      precommitSourceAuthority: authority,
      currentSource: before,
      candidateBaselineBytes: candidateBaseline(),
    })).toMatchObject({ classification: "exact_precommit" });

    const alreadyCurrent = {
      ...before,
      last_hash: `visual:${"1".repeat(64)}`,
      last_checked_at: "2026-08-15T11:00:00.000Z",
      next_check_at: "2026-08-16T11:00:00.000Z",
      consecutive_failures: 0,
      last_error: null,
      updated_at: "2026-08-15T11:00:00.000Z",
    };
    expect(classifyStage1EvidenceSchemaUpgradeSourceHealthAuthority({
      precommitSourceAuthority: authority,
      currentSource: alreadyCurrent,
      candidateBaselineBytes: candidateBaseline(),
    })).toMatchObject({
      classification: "exact_already_current",
      expected_last_hash: `visual:${"1".repeat(64)}`,
    });
  });

  it.each([
    ["reviewed URL", (row) => { row.url = "https://evil.example/award"; }],
    ["admin state", (row) => { row.admin_review_status = "rejected"; }],
    ["last hash", (row) => { row.last_hash = "visual:wrong"; }],
    ["failure count", (row) => { row.consecutive_failures = 1; }],
    ["last error", (row) => { row.last_error = "failed"; }],
    ["timestamp ordering", (row) => {
      row.next_check_at = "2026-08-15T10:00:00.000Z";
    }],
    ["updated timestamp", (row) => {
      row.updated_at = "2026-08-15T10:59:00.000Z";
    }],
  ])("rejects an unauthorized %s drift", (_label, mutate) => {
    const before = sourceRow();
    const current = {
      ...before,
      last_hash: `visual:${"1".repeat(64)}`,
      last_checked_at: "2026-08-15T11:00:00.000Z",
      next_check_at: "2026-08-16T11:00:00.000Z",
      updated_at: "2026-08-15T11:00:00.000Z",
    };
    mutate(current);
    expect(classifyStage1EvidenceSchemaUpgradeSourceHealthAuthority({
      precommitSourceAuthority:
        buildStage1EvidenceSchemaUpgradeSourceHealthAuthority(before),
      currentSource: current,
      candidateBaselineBytes: candidateBaseline(),
    }).classification).toBe("mismatch");
  });
});

function candidateBaseline() {
  return Buffer.from(`${JSON.stringify({
    captured_at: "2026-08-15T10:00:00.000Z",
    main_content_hash: "1".repeat(64),
  })}\n`, "utf8");
}

function sourceRow() {
  return {
    admin_review_note: "reviewed",
    admin_review_status: "open",
    admin_reviewed_at: "2026-08-01T00:00:00.000Z",
    admin_reviewed_by: "operator@example.test",
    consecutive_failures: 2,
    created_at: "2026-07-01T00:00:00.000Z",
    display_title: "Award",
    id: sourceId,
    last_checked_at: "2026-08-14T10:00:00.000Z",
    last_error: "prior failure",
    last_hash: "visual:old",
    next_check_at: "2026-08-15T10:00:00.000Z",
    page_description: "Description",
    page_metadata: { reviewed: true },
    page_metadata_generated_at: "2026-08-01T00:00:00.000Z",
    page_metadata_model: "deterministic",
    page_type: "overview",
    reason: "official",
    shared_award_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    shared_awards: {
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      name: "Award",
      official_homepage: "https://example.test/award",
      status: "active",
    },
    source: "official",
    submitted_by_user_id: null,
    title: "Award",
    updated_at: "2026-08-14T10:00:00.000Z",
    url: "https://example.test/award",
  };
}
