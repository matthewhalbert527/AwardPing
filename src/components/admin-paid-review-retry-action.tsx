"use client";

type Props = {
  candidateId: string;
  candidateUpdatedAt: string;
  sourceTitle: string;
};

export function AdminPaidReviewRetryAction({ sourceTitle }: Props) {
  return (
    <p className="admin-issue-action-error">
      Image-review retries for {sourceTitle} are retired. Existing records are preserved.
    </p>
  );
}
