import type { AwardPriority, AwardTaskStatus, AwardWorkflowStatus } from "@/lib/database.types";

export const awardWorkflowStatuses = [
  "watching",
  "needs_review",
  "in_progress",
  "ready",
  "done",
] as const satisfies AwardWorkflowStatus[];

export const awardPriorities = ["normal", "high"] as const satisfies AwardPriority[];
export const awardTaskStatuses = ["todo", "done"] as const satisfies AwardTaskStatus[];

export const workflowStatusLabels: Record<AwardWorkflowStatus, string> = {
  watching: "Watching",
  needs_review: "Review queue",
  in_progress: "In progress",
  ready: "Ready",
  done: "Done",
};

export const priorityLabels: Record<AwardPriority, string> = {
  normal: "Normal",
  high: "High",
};

export function workflowStatusAfterSourceChange(status: AwardWorkflowStatus) {
  return status === "done" ? status : "needs_review";
}

export function workflowStatusAfterReview(status: AwardWorkflowStatus) {
  return status === "needs_review" ? "watching" : status;
}
