import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

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
