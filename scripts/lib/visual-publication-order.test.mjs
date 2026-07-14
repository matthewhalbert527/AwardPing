import { describe, expect, it } from "vitest";
import {
  compareVisualCandidateOrder,
  findBlockingPriorVisualPublication,
  shouldSupersedeVisualPublication,
} from "./visual-publication-order.mjs";

describe("visual publication ordering", () => {
  it("finishes A-to-B after partial baseline advancement before allowing B-to-C", () => {
    const aToB = candidateFixture({
      id: "a-to-b",
      rejection_reason: "baseline_promotion_pending:r2_promotion_error",
      new_snapshot_ref: {
        capture_dir: { archive_relative: "sources/source-1/captures/b" },
      },
      worker_metadata: {
        baseline_advanced: false,
        baseline_promotion: {
          local: { promoted: true },
          r2: { promoted: false, reason: "r2_promotion_error" },
        },
      },
    });
    const bToC = candidateFixture({
      id: "b-to-c",
      new_snapshot_ref: {
        capture_dir: { archive_relative: "sources/source-1/captures/c" },
      },
    });

    expect(shouldSupersedeVisualPublication(aToB, true)).toBe(false);
    expect(findBlockingPriorVisualPublication(bToC, [aToB])).toBe(aToB);
  });

  it("does not serialize section siblings from the same enclosing capture", () => {
    const earlier = candidateFixture({
      id: "section-a",
      rejection_reason: "publish_retry_pending:award_reconciliation_enqueue_failed",
    });
    const sibling = candidateFixture({ id: "section-b" });
    expect(findBlockingPriorVisualPublication(sibling, [earlier])).toBeNull();
  });

  it("preserves the full A-to-B, B-to-C, C-to-D retry chain transitively", () => {
    const aToB = candidateFixture({
      id: "a-to-b",
      rejection_reason: "baseline_promotion_pending:r2_promotion_error",
      new_snapshot_ref: {
        capture_dir: { archive_relative: "sources/source-1/captures/b" },
      },
    });
    const bToC = candidateFixture({
      id: "b-to-c",
      rejection_reason: "source_publication_order_pending:a-to-b",
      new_snapshot_ref: {
        capture_dir: { archive_relative: "sources/source-1/captures/c" },
      },
    });
    const cToD = candidateFixture({
      id: "c-to-d",
      new_snapshot_ref: {
        capture_dir: { archive_relative: "sources/source-1/captures/d" },
      },
    });

    expect(findBlockingPriorVisualPublication(bToC, [aToB])).toBe(aToB);
    expect(shouldSupersedeVisualPublication(bToC, true)).toBe(false);
    expect(findBlockingPriorVisualPublication(cToD, [bToC, aToB])).toBe(bToC);
  });

  it("blocks a newer completed result when it tries to claim before an older result", () => {
    const older = candidateFixture({
      id: "older-a-to-b",
      status: "processing",
      new_snapshot_ref: {
        capture_dir: { archive_relative: "sources/source-1/captures/b" },
      },
    });
    const newer = candidateFixture({
      id: "newer-b-to-c",
      status: "succeeded",
      new_snapshot_ref: {
        capture_dir: { archive_relative: "sources/source-1/captures/c" },
      },
    });
    expect(findBlockingPriorVisualPublication(newer, [older])).toBe(older);
  });

  it("uses candidate ID as a total-order tiebreaker for equal creation timestamps", () => {
    const createdAt = "2026-07-14T18:00:00.000Z";
    expect(compareVisualCandidateOrder(
      { id: "00000000-0000-0000-0000-000000000001", created_at: createdAt },
      { id: "00000000-0000-0000-0000-000000000002", created_at: createdAt },
    )).toBeLessThan(0);
  });
});

function candidateFixture(overrides = {}) {
  return {
    id: "candidate",
    status: "succeeded",
    rejection_reason: null,
    worker_metadata: {},
    new_snapshot_ref: {
      capture_dir: { archive_relative: "sources/source-1/captures/shared" },
    },
    ...overrides,
  };
}
