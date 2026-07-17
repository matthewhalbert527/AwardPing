import { describe, expect, it } from "vitest";
import { newPageReviewLaneSteps } from "./process-new-page-review-lane.mjs";

describe("new-page review lane", () => {
  it("runs source intake and initial-document review under the same new-page lease", () => {
    const steps = newPageReviewLaneSteps({
      envFile: ".env.worker.test",
      sourceTimeBudgetMs: 120_000,
    });
    expect(steps.map((step) => step.key)).toEqual([
      "source_intake",
      "initial_official_document_review",
    ]);
    expect(steps[0]).toMatchObject({
      script: "scripts/process-source-intake-requests.mjs",
    });
    expect(steps[0].args).toContain("--time-budget-ms=120000");
    expect(steps[1]).toMatchObject({
      script: "scripts/process-visual-review-batch.mjs",
    });
    expect(steps[1].args).toContain("--paid-lane=new_page_review");
    expect(steps[0].args).toContain("--env=.env.worker.test");
    expect(steps[1].args).toContain("--env=.env.worker.test");
  });
});
