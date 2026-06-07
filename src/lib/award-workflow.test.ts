import { describe, expect, it } from "vitest";
import {
  workflowStatusAfterReview,
  workflowStatusAfterSourceChange,
} from "@/lib/award-workflow";

describe("award workflow state helpers", () => {
  it("marks active awards as needing review after a monitored source changes", () => {
    expect(workflowStatusAfterSourceChange("watching")).toBe("needs_review");
    expect(workflowStatusAfterSourceChange("in_progress")).toBe("needs_review");
    expect(workflowStatusAfterSourceChange("ready")).toBe("needs_review");
  });

  it("does not reopen completed awards after a monitored source changes", () => {
    expect(workflowStatusAfterSourceChange("done")).toBe("done");
  });

  it("moves a reviewed award back to watching only from needs review", () => {
    expect(workflowStatusAfterReview("needs_review")).toBe("watching");
    expect(workflowStatusAfterReview("in_progress")).toBe("in_progress");
  });
});
