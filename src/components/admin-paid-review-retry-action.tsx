"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CircleDollarSign } from "lucide-react";

type Props = {
  candidateId: string;
  candidateUpdatedAt: string;
  sourceTitle: string;
};

export function AdminPaidReviewRetryAction({
  candidateId,
  candidateUpdatedAt,
  sourceTitle,
}: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  async function approve() {
    const reason = window.prompt(
      `Why is one new paid review safe and necessary?\n\n${sourceTitle}`,
      "Reviewed the failure evidence and approved one exact retry.",
    );
    if (reason === null || !reason.trim()) return;
    const confirmed = window.confirm(
      "Approve exactly one new Gemini Batch submission? This approval can create an API charge and expires in 24 hours.",
    );
    if (!confirmed) return;

    setBusy(true);
    setMessage("");
    try {
      const response = await fetch(
        `/api/admin/visual-review-retries/${candidateId}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            expectedCandidateUpdatedAt: candidateUpdatedAt,
            reason: reason.trim(),
          }),
        },
      );
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(
          typeof data.error === "string"
            ? data.error
            : "Paid retry approval failed.",
        );
      }
      setMessage("One-use approval recorded. The paid lane may consume it once.");
      router.refresh();
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Paid retry approval failed.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="admin-issue-button-row">
      <button
        className="admin-issue-button"
        disabled={busy}
        onClick={approve}
        type="button"
      >
        <CircleDollarSign size={13} aria-hidden="true" />
        {busy ? "Approving" : "Approve one paid retry"}
      </button>
      {message && (
        <p aria-live="polite" className="admin-issue-action-error">
          {message}
        </p>
      )}
    </div>
  );
}
