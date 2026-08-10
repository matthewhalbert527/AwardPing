import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { guardAdminReviewMutation } from "./lib/admin-review-state-guard.mjs";

const root = resolve(import.meta.dirname, "..");
const captureWorker = readFileSync(
  resolve(root, "scripts", "capture-visual-snapshots.mjs"),
  "utf8",
);
const baselineFactsWorker = readFileSync(
  resolve(root, "scripts", "backfill-baseline-facts.mjs"),
  "utf8",
);

describe("admin review mutation guard", () => {
  it("binds an automated mutation to the exact operator marker and timestamp it reviewed", () => {
    const query = queryDouble();

    const result = guardAdminReviewMutation(query, {
      admin_review_status: "open",
      admin_review_note: "monitoring_restore_v1: monitoring only",
      admin_reviewed_at: "2026-08-10T14:57:25.644Z",
      admin_reviewed_by: "operator@example.edu",
    });

    expect(result).toBe(query);
    expect(query.eq.mock.calls).toEqual([
      ["admin_review_status", "open"],
      ["admin_reviewed_at", "2026-08-10T14:57:25.644Z"],
      ["admin_review_note", "monitoring_restore_v1: monitoring only"],
      ["admin_reviewed_by", "operator@example.edu"],
    ]);
    expect(query.is).not.toHaveBeenCalled();
  });

  it("guards null legacy review values instead of omitting them", () => {
    const query = queryDouble();

    guardAdminReviewMutation(query, { admin_review_status: "open" });

    expect(query.eq).toHaveBeenCalledWith("admin_review_status", "open");
    expect(query.is.mock.calls).toEqual([
      ["admin_reviewed_at", null],
      ["admin_review_note", null],
      ["admin_reviewed_by", null],
    ]);
  });

  it("fails closed when a successful visual check would apply stale review metadata", () => {
    const body = sourceBetween(
      captureWorker,
      "async function markSharedSourceVisualCheckSucceeded(",
      "async function markSharedSourceReviewLater(",
    );

    expect(body).toContain("sourcePageMetadataUpdate(source, capture)");
    expect(body).toContain("guardAdminReviewMutation(mutation, source)");
    expect(body).toContain('.select("id").maybeSingle()');
    expect(body).toContain('recordStaleAdminReviewPlan(report, source, "visual_check_succeeded")');
    expect(body).toContain("return false");
  });

  it("fails closed for pre-capture hygiene review-state writes", () => {
    const body = sourceBetween(
      captureWorker,
      "async function markSharedSourceReviewLater(",
      "async function maybeResolveR2BaselineRecoveryQuarantine(",
    );

    expect(body).toContain("guardAdminReviewMutation(mutation, source)");
    expect(body).toContain('.select("id").maybeSingle()');
    expect(body).toContain('recordStaleAdminReviewPlan(report, source, "pre_capture_review_later")');
    expect(body).toContain("return false");
  });

  it("fails closed for capture-failure review-state writes", () => {
    const body = sourceBetween(
      captureWorker,
      "async function markSharedSourceVisualCheckFailed(",
      "function recordStaleAdminReviewPlan(",
    );

    expect(body).toContain("guardAdminReviewMutation(mutation, source)");
    expect(body).toContain('.select("id").maybeSingle()');
    expect(body).toContain('recordStaleAdminReviewPlan(report, source, "visual_check_failed")');
    expect(body).toContain("return false");
    expect(body.indexOf("if (!data)")).toBeLessThan(
      body.indexOf("console.log(`SOURCE_REVIEW_LATER reason="),
    );
  });

  it("fails closed for stale baseline-facts rejection review-state writes", () => {
    const body = sourceBetween(
      baselineFactsWorker,
      "async function rejectFactsInSupabaseSource(",
      "async function queueAwardReconciliationFromBaselineSource(",
    );

    expect(body).toContain("guardAdminReviewMutation(mutation, source)");
    expect(body).toContain('.select("id").maybeSingle()');
    expect(body).toContain("nonNegativeInt(report.stale_admin_review_plans_skipped, 0) + 1");
    expect(body).toContain("return false");
    expect(body.indexOf("if (!data)")).toBeLessThan(
      body.indexOf("await queueAwardReconciliationFromBaselineSource"),
    );
  });
});

function queryDouble() {
  const query = {
    eq: vi.fn(),
    is: vi.fn(),
  };
  query.eq.mockReturnValue(query);
  query.is.mockReturnValue(query);
  return query;
}

function sourceBetween(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  if (startIndex < 0 || endIndex < 0) {
    throw new Error(`Unable to locate source segment: ${start} -> ${end}`);
  }
  return source.slice(startIndex, endIndex);
}
