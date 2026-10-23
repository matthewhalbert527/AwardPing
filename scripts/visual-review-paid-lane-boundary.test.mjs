import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { GEMINI_PAID_LANES } from "./lib/gemini-spend-ledger.mjs";

const worker = readFileSync(
  new URL("./process-visual-review-batch.mjs", import.meta.url),
  "utf8",
);

const functionBody = (name, nextName) => {
  const start = worker.indexOf(`async function ${name}`);
  const end = nextName
    ? worker.indexOf(`async function ${nextName}`, start + 1)
    : worker.length;
  expect(start, `${name} must exist`).toBeGreaterThanOrEqual(0);
  expect(end, `${nextName} must follow ${name}`).toBeGreaterThan(start);
  return worker.slice(start, end);
};

describe("visual-review paid-lane ownership boundary", () => {
  it.each([null, GEMINI_PAID_LANES.NEW_PAGE_REVIEW, GEMINI_PAID_LANES.CHANGED_PAGE_REVIEW])("excludes new text work before legacy selection, polling or mutation (lane %s)", paidLane => {
    const start = worker.indexOf("function applyPaidLaneCandidateScopeFilter("), end = worker.indexOf("function chunks(", start);
    expect(start).toBeGreaterThanOrEqual(0); expect(end).toBeGreaterThan(start);
    const applyFilter = runInNewContext(`${worker.slice(start, end)}\napplyPaidLaneCandidateScopeFilter`, {
      paidLane, GEMINI_PAID_LANES, INITIAL_OFFICIAL_DOCUMENT_SCOPE: "initial_official_document",
    });
    const candidates = [{ candidate_scope: "initial_official_document" }, { candidate_scope: "content_change" }, { candidate_scope: "program_text_change" }];
    const query = { rows: candidates, filters: [],
      eq(key, value) { this.filters.push(["eq", key, value]); this.rows = this.rows.filter(row => row[key] === value); return this; },
      neq(key, value) { this.filters.push(["neq", key, value]); this.rows = this.rows.filter(row => row[key] !== value); return this; },
    };
    expect(applyFilter(query)).toBe(query);
    expect(query.filters[0]).toEqual(["neq", "candidate_scope", "program_text_change"]);
    expect(query.rows.map(row => row.candidate_scope)).toEqual(paidLane === GEMINI_PAID_LANES.NEW_PAGE_REVIEW
      ? ["initial_official_document"] : paidLane === GEMINI_PAID_LANES.CHANGED_PAGE_REVIEW ? ["content_change"] : ["initial_official_document", "content_change"]);
  });
  it("keeps stored succeeded publication recovery inside the owning lane", () => {
    const body = functionBody(
      "reconcileStoredSucceededCandidates",
      "submitPendingCandidates",
    );

    expect(body).toContain(
      "priorityQuery = applyPaidLaneCandidateScopeFilter(priorityQuery);",
    );
    expect(body).toContain(
      "storedSucceededQuery = applyPaidLaneCandidateScopeFilter(storedSucceededQuery);",
    );
    expect(body.indexOf("storedSucceededQuery = applyPaidLaneCandidateScopeFilter"))
      .toBeLessThan(body.indexOf("for (const candidate of candidates)"));
  });

  it("reconciles only the owning lane from a historical mixed provider batch", () => {
    const body = functionBody("reconcileCompletedBatch", "publishCandidateResultUnlocked");

    expect(body).toContain(
      "completedBatchQuery = applyPaidLaneCandidateScopeFilter(completedBatchQuery);",
    );
    expect(body.indexOf("completedBatchQuery = applyPaidLaneCandidateScopeFilter"))
      .toBeLessThan(body.indexOf("geminiBatchResponseMap("));
    expect(body.indexOf("completedBatchQuery = applyPaidLaneCandidateScopeFilter"))
      .toBeLessThan(body.indexOf("for (const candidate of candidates)"));
  });

  it("does not change another lane's rows while polling a mixed historical batch", () => {
    const processing = functionBody("markBatchRowsProcessing", "markBatchRowsFailed");
    const failed = functionBody("markBatchRowsFailed", "markCandidate");

    expect(processing).toContain(
      "processingQuery = applyPaidLaneCandidateScopeFilter(processingQuery);",
    );
    expect(failed).toContain(
      "failureQuery = applyPaidLaneCandidateScopeFilter(failureQuery);",
    );
  });
});
