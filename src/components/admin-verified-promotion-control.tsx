"use client";

import { useId, useState, type FormEvent } from "react";
import { BadgeCheck, FilePenLine, Layers3, RotateCcw } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { MonitoringFeedbackPromotionStage } from "@/lib/monitoring-feedback-promotion";

type Props = {
  candidateRuleIds: readonly string[];
  expectedVersion: number;
  stage: MonitoringFeedbackPromotionStage | null;
  workflowId: string | null;
  defaultPolicyRuleId?: string | null;
  defaultDraftSummary?: string | null;
  defaultLegitimateNegativeEventIds?: readonly string[];
  activationBlocked?: boolean;
  hasFailedGate?: boolean;
  ruleActive?: boolean;
  resolutionReady?: boolean;
  resolutionIdentityDrifted?: boolean;
  resolutionIdentityDriftReason?: string | null;
};

type WorkflowAction = "confirm_cluster" | "draft_rule" | "restart_draft" | "resolve";

type ActionConfig = {
  action: WorkflowAction;
  buttonLabel: string;
  busyLabel: string;
  description: string;
  successMessage: string;
};

type SubmissionMessage = {
  tone: "success" | "error";
  text: string;
};

export function AdminVerifiedPromotionControl({
  candidateRuleIds,
  expectedVersion,
  stage,
  workflowId,
  defaultPolicyRuleId = null,
  defaultDraftSummary = null,
  defaultLegitimateNegativeEventIds = [],
  activationBlocked = false,
  hasFailedGate = false,
  ruleActive = false,
  resolutionReady = false,
  resolutionIdentityDrifted = false,
  resolutionIdentityDriftReason = null,
}: Props) {
  const router = useRouter();
  const ruleIdInputId = useId();
  const summaryInputId = useId();
  const negativeEventIdsInputId = useId();
  const descriptionId = useId();
  const [policyRuleId, setPolicyRuleId] = useState(defaultPolicyRuleId || "");
  const [draftSummary, setDraftSummary] = useState(defaultDraftSummary || "");
  const [negativeEventIdsInput, setNegativeEventIdsInput] = useState(
    defaultLegitimateNegativeEventIds.join("\n"),
  );
  const [requestId, setRequestId] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<SubmissionMessage | null>(null);
  const actionConfig = promotionControlAction(
    stage,
    hasFailedGate,
    ruleActive,
    resolutionReady,
  );

  if (!workflowId) {
    return (
      <div className="verified-promotion-automation-note" role="alert">
        <BadgeCheck size={17} aria-hidden="true" />
        <div>
          <strong>Workflow identity unavailable</strong>
          <p>Refresh after the verified-promotion database migration is available.</p>
        </div>
      </div>
    );
  }

  if (activationBlocked) {
    return (
      <div className="verified-promotion-automation-note" role="alert">
        <RotateCcw size={17} aria-hidden="true" />
        <div>
          <strong>
            {ruleActive
              ? "Rollback deployment required"
              : "Rollback verification in progress"}
          </strong>
          <p>
            {ruleActive
              ? "Deactivate this rule and deploy the same inactive revision to the app and worker. "
              : "Keep this candidate inactive. "}
            AwardPing checks the rollback identities on the next feedback-promotion lane run at no API charge, reverses partial
            candidate-attributable historical suppression, and returns the enlarged cluster to
            draft only after the rollback audit passes.
          </p>
        </div>
      </div>
    );
  }

  if (resolutionIdentityDrifted) {
    return (
      <div className="verified-promotion-automation-note" role="alert">
        <RotateCcw size={17} aria-hidden="true" />
        <div>
          <strong>Post-sweep identity drift requires rollback</strong>
          <p>
            {resolutionIdentityDriftReason ||
              "The current app identity no longer matches the immutable activated app and worker identity."}{" "}
            Deactivate the candidate, restore the exact inactive app and worker deployment,
            and let the next zero-charge feedback-promotion lane run verify reversals before
            redrafting. Do not resolve this cluster.
          </p>
        </div>
      </div>
    );
  }

  if (stage === "six_pm_canary") {
    return (
      <div className="verified-promotion-automation-note" role="status">
        <FilePenLine size={17} aria-hidden="true" />
        <div>
          <strong>
            {ruleActive
              ? hasFailedGate
                ? "App activation needs repair"
                : "App activation detected; worker parity pending"
              : "Activation deployment required"}
          </strong>
          {ruleActive ? (
            <p>
              The candidate is active in the current app policy, but the activated worker
              identity has not been re-attested yet. Automation must prove app/worker parity
              before it continues or resumes the bounded historical sweep. Review the failure
              artifact above if this remains blocked.
            </p>
          ) : (
            <p>
              Change only the drafted candidate to active and deploy the same reviewed build to
              the app and workers. The worker will re-attest it and run the retroactive sweep.
            </p>
          )}
        </div>
      </div>
    );
  }

  if (ruleActive && hasFailedGate) {
    return (
      <div className="verified-promotion-automation-note" role="alert">
        <RotateCcw size={17} aria-hidden="true" />
        <div>
          <strong>Deactivate before redrafting</strong>
          <p>
            This rule is already live and a verification gate failed. Change it back to an
            inactive candidate, deploy matching app and worker revisions, then return here to
            preserve the failed report and revise the draft safely.
          </p>
        </div>
      </div>
    );
  }

  if (stage === "retroactive_sweep" && !ruleActive) {
    return (
      <div className="verified-promotion-automation-note" role="alert">
        <RotateCcw size={17} aria-hidden="true" />
        <div>
          <strong>Rule deactivation detected</strong>
          <p>
            Do not resolve this cluster. Keep the drafted rule inactive while the feedback-promotion lane
            no-charge worker records the deactivation, reverses suppressions attributable to this
            candidate, and returns the workflow to a safe draft checkpoint.
          </p>
        </div>
      </div>
    );
  }

  if (stage === "retroactive_sweep" && !resolutionReady) {
    return (
      <div className="verified-promotion-automation-note" role="status">
        <BadgeCheck size={17} aria-hidden="true" />
        <div>
          <strong>Final feedback-promotion attestation pending</strong>
          <p>
            Resolve stays locked until the next feedback-promotion lane run records the matching
            zero-charge attestation. No extra 6 PM scan or paid API call is required.
          </p>
        </div>
      </div>
    );
  }

  if (!actionConfig) {
    return (
      <div className="verified-promotion-automation-note">
        <BadgeCheck size={17} aria-hidden="true" />
        <div>
          <strong>{stage === "resolved" ? "Verification complete" : "Automatic verification in progress"}</strong>
          <p>
            {stage === "resolved"
              ? "No operator action is needed unless the pattern recurs under new evidence."
              : "The workflow service owns this stage. It will advance only after its evidence artifact passes."}
          </p>
        </div>
      </div>
    );
  }

  const activeAction = actionConfig;
  const isDraftAction = activeAction.action === "draft_rule";
  const legitimateNegativeEventIds = parseLegitimateNegativeEventIds(
    negativeEventIdsInput,
  );

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    const stableRequestId = workflowRequestIdForSubmission(requestId);
    if (!requestId) setRequestId(stableRequestId);

    try {
      const response = await fetch("/api/admin/monitoring-feedback/workflows", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          requestId: stableRequestId,
          workflowId,
          expectedVersion,
          action: activeAction.action,
          policyRuleId: isDraftAction
            ? policyRuleId.trim() || undefined
            : activeAction.action === "resolve"
              ? defaultPolicyRuleId || undefined
              : undefined,
          draftSummary: isDraftAction ? draftSummary.trim() || undefined : undefined,
          legitimateNegativeEventIds: isDraftAction
            ? legitimateNegativeEventIds
            : undefined,
        }),
      });
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        const nextRequestId = workflowRequestIdAfterHttpResponse(
          stableRequestId,
          response.status,
        );
        setRequestId(nextRequestId);
        if (!nextRequestId) router.refresh();
        throw new Error(payload.error || "The verified promotion workflow could not advance.");
      }

      setRequestId(workflowRequestIdAfterAcceptedResponse());
      setMessage({ tone: "success", text: activeAction.successMessage });
      router.refresh();
    } catch (error) {
      setMessage({
        tone: "error",
        text:
          error instanceof Error
            ? error.message
            : "The verified promotion workflow could not advance.",
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      aria-busy={busy}
      aria-describedby={descriptionId}
      className="verified-promotion-control"
      onSubmit={submit}
    >
      <div className="verified-promotion-control-heading">
        <div>
          <span>Operator checkpoint</span>
          <h4>{activeAction.buttonLabel}</h4>
          <p id={descriptionId}>{activeAction.description}</p>
        </div>
      </div>

      {isDraftAction && (
        <div className="verified-promotion-draft-fields">
          <label htmlFor={ruleIdInputId}>
            Implemented candidate rule
            <select
              className="input"
              disabled={busy}
              id={ruleIdInputId}
              onChange={(event) => {
                setPolicyRuleId(event.target.value);
                setRequestId("");
              }}
              required
              value={policyRuleId}
            >
              <option value="">Choose a candidate rule</option>
              {candidateRuleIds.map((ruleId) => (
                <option key={ruleId} value={ruleId}>
                  {ruleId.replaceAll("_", " ")}
                </option>
              ))}
            </select>
            <span>
              {candidateRuleIds.length > 0
                ? "Only implemented, inactive candidates are available. Activation stays locked until the canary passes."
                : "No inactive candidate is deployed yet. Add and test the narrow rule in policy configuration first."}
            </span>
          </label>
          <label htmlFor={summaryInputId}>
            Rule boundary
            <textarea
              className="input"
              disabled={busy}
              id={summaryInputId}
              maxLength={1000}
              onChange={(event) => {
                setDraftSummary(event.target.value);
                setRequestId("");
              }}
              placeholder="Describe what the rule should hide and what legitimate changes must remain visible."
              required
              value={draftSummary}
            />
          </label>
          <label htmlFor={negativeEventIdsInputId}>
            Known real update IDs this rule must keep visible
            <textarea
              className="input"
              disabled={busy}
              id={negativeEventIdsInputId}
              onChange={(event) => {
                setNegativeEventIdsInput(event.target.value);
                setRequestId("");
              }}
              placeholder="One retained change-event ID per line"
              required
              value={negativeEventIdsInput}
            />
            <span>
              Use at least one operator-confirmed real update near this rule’s boundary. The
              regression check loads these exact records; it never chooses an easy example by
              asking the proposed rule first. {" "}
              <Link href="/dashboard/admin/issues?tab=updates">
                Find an event ID in Update review.
              </Link>
            </span>
          </label>
        </div>
      )}

      <div className="verified-promotion-control-actions">
        <button
          className="admin-issue-button verified-promotion-control-button"
          disabled={
            busy ||
            (isDraftAction &&
              (candidateRuleIds.length === 0 ||
                !policyRuleId.trim() ||
                !draftSummary.trim() ||
                legitimateNegativeEventIds.length === 0))
          }
          type="submit"
        >
          <ActionIcon action={activeAction.action} />
          {busy ? activeAction.busyLabel : activeAction.buttonLabel}
        </button>
        {message && (
          <p
            className={`verified-promotion-control-message verified-promotion-control-message-${message.tone}`}
            role={message.tone === "error" ? "alert" : "status"}
          >
            {message.text}
          </p>
        )}
      </div>
    </form>
  );
}

export function promotionControlAction(
  stage: MonitoringFeedbackPromotionStage | null,
  hasFailedGate = false,
  ruleActive = false,
  resolutionReady = false,
): ActionConfig | null {
  if (stage === "retroactive_sweep" && (!ruleActive || !resolutionReady)) {
    return null;
  }

  if (
    hasFailedGate &&
    !ruleActive &&
    stage &&
    [
      "rule_drafted",
      "historical_shadow_test",
      "regression_tests_pass",
      "app_worker_hashes_match",
    ].includes(stage)
  ) {
    return {
      action: "restart_draft",
      buttonLabel: "Revise the draft rule",
      busyLabel: "Returning to draft…",
      description:
        "Automatic retries continue. Use this only when the candidate rule or its known-real-update fixtures need to change; prior reports stay in the audit history.",
      successMessage:
        "The failed check was preserved and the cluster is ready for a narrower draft.",
    };
  }

  switch (stage) {
    case "triaged":
      return {
        action: "confirm_cluster",
        buttonLabel: "Confirm cluster",
        busyLabel: "Confirming…",
        description: "Confirm that the evidence signature, site template, and reason describe one reusable pattern.",
        successMessage: "The grouped pattern was confirmed.",
      };
    case "similar_feedback_clustered":
      return {
        action: "draft_rule",
        buttonLabel: "Save draft rule",
        busyLabel: "Saving draft…",
        description: "Name the narrow reusable rule and state the legitimate changes it must never hide.",
        successMessage: "The draft rule was saved. Automatic shadow testing can begin.",
      };
    case "retroactive_sweep":
      return {
        action: "resolve",
        buttonLabel: "Resolve verified pattern",
        busyLabel: "Resolving…",
        description:
          "Close the cluster only after the completed sweep artifact and the next zero-charge matching feedback-promotion lane attestation are visible. This does not require another 6 PM scan.",
        successMessage: "The verified pattern was resolved.",
      };
    default:
      return null;
  }
}

function ActionIcon({ action }: { action: WorkflowAction }) {
  switch (action) {
    case "confirm_cluster":
      return <Layers3 size={15} aria-hidden="true" />;
    case "draft_rule":
      return <FilePenLine size={15} aria-hidden="true" />;
    case "restart_draft":
      return <RotateCcw size={15} aria-hidden="true" />;
    case "resolve":
      return <BadgeCheck size={15} aria-hidden="true" />;
  }
}

export function parseLegitimateNegativeEventIds(value: string) {
  return [
    ...new Set(
      value
        .split(/[\s,]+/)
        .map((item) => item.trim().toLocaleLowerCase("en-US"))
        .filter(Boolean),
    ),
  ].sort((left, right) => left.localeCompare(right));
}

export function workflowRequestIdForSubmission(
  requestId: string,
  createRequestId: () => string = () => crypto.randomUUID(),
) {
  return requestId || createRequestId();
}

export function workflowRequestIdAfterAcceptedResponse() {
  return "";
}

export function workflowRequestIdAfterHttpResponse(
  requestId: string,
  status: number,
) {
  return status >= 400 && status < 500 ? "" : requestId;
}
