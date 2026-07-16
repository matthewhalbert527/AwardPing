import {
  CheckCircle2,
  CircleDashed,
  LockKeyhole,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";
import { AdminVerifiedPromotionControl } from "@/components/admin-verified-promotion-control";
import type { Json } from "@/lib/database.types";
import { monitoringFeedbackLabel } from "@/lib/monitoring-feedback";
import {
  monitoringFeedbackPromotionCanActivateGlobally,
  monitoringFeedbackPromotionFailedGate,
  monitoringFeedbackPromotionNeedsActivationRollback,
  monitoringFeedbackPromotionPostSweepDeactivated,
  monitoringFeedbackPromotionProgress,
  monitoringFeedbackPromotionSafeAction,
  monitoringFeedbackPromotionStageCopy,
  monitoringFeedbackPromotionStageIndex,
  monitoringFeedbackPromotionStages,
  type MonitoringFeedbackPromotionCluster,
  type MonitoringFeedbackPromotionEvidence,
} from "@/lib/monitoring-feedback-promotion";
import { formatCentralDateTime } from "@/lib/time-zone";

type Props = {
  clusters: MonitoringFeedbackPromotionCluster[];
  candidateRuleIds: readonly string[];
};

type LegitimateUpdateItem = {
  key: string;
  title: string;
  detail: string | null;
  url: string | null;
};

const operatorStages = new Set([
  null,
  "triaged",
  "similar_feedback_clustered",
  "six_pm_canary",
  "retroactive_sweep",
]);

export function AdminVerifiedPromotionBoard({ clusters, candidateRuleIds }: Props) {
  const orderedClusters = [...clusters].sort(compareClusters);
  const openClusters = clusters.filter((cluster) => cluster.stage !== "resolved");
  const operatorCount = openClusters.filter(promotionNeedsOperator).length;
  const blockedByLegitimateUpdates = openClusters.filter(
    (cluster) => legitimateUpdateCount(cluster.shadowReport) > 0,
  ).length;
  const automatedCount = Math.max(0, openClusters.length - operatorCount);

  return (
    <section
      aria-labelledby="verified-promotions-title"
      className="verified-promotion-board"
    >
      <div className="card verified-promotion-summary">
        <div>
          <p className="verified-promotion-kicker">4. Verified Promotions</p>
          <h2 id="verified-promotions-title">
            {openClusters.length === 0
              ? "No feedback patterns are awaiting promotion"
              : `${formatNumber(openClusters.length)} ${openClusters.length === 1 ? "pattern is" : "patterns are"} moving through verification`}
          </h2>
          <p>
            Similar corrections stay grouped. A rule cannot activate globally until history,
            regression tests, app and worker hashes, and the 6 PM canary all agree.
          </p>
          {openClusters.length > 0 && (
            <p className="verified-promotion-summary-detail">
              {formatNumber(operatorCount)} {operatorCount === 1 ? "needs" : "need"} a person;
              {" "}
              {formatNumber(automatedCount)} {automatedCount === 1 ? "is" : "are"} in automatic verification.
            </p>
          )}
        </div>
        {blockedByLegitimateUpdates > 0 ? (
          <span className="verified-promotion-summary-status verified-promotion-summary-status-blocked">
            <TriangleAlert size={16} aria-hidden="true" />
            {formatNumber(blockedByLegitimateUpdates)} blocked by legitimate updates
          </span>
        ) : (
          <span className="verified-promotion-summary-status">
            <ShieldCheck size={16} aria-hidden="true" />
            Global activation is gated
          </span>
        )}
      </div>

      {orderedClusters.length > 0 ? (
        <div className="verified-promotion-list">
          {orderedClusters.map((cluster) => (
            <PromotionClusterCard
              candidateRuleIds={candidateRuleIds}
              cluster={cluster}
              key={cluster.workflowId || cluster.clusterKey}
            />
          ))}
        </div>
      ) : (
        <div className="card verified-promotion-empty">
          <CheckCircle2 size={22} aria-hidden="true" />
          <div>
            <h3>No rule promotion is waiting</h3>
            <p>Immediate event suppression remains active, and no broader pattern needs review.</p>
          </div>
        </div>
      )}
    </section>
  );
}

function promotionNeedsOperator(cluster: MonitoringFeedbackPromotionCluster) {
  if (!operatorStages.has(cluster.stage)) return false;
  if (cluster.stage === "retroactive_sweep") {
    return cluster.resolutionIdentityDrifted || cluster.resolutionReady;
  }
  if (
    cluster.stage === "six_pm_canary" &&
    cluster.draftRuleActive &&
    !monitoringFeedbackPromotionFailedGate(cluster) &&
    !monitoringFeedbackPromotionNeedsActivationRollback(cluster.activationStatus)
  ) {
    return false;
  }
  return true;
}

function PromotionClusterCard({
  candidateRuleIds,
  cluster,
}: {
  candidateRuleIds: readonly string[];
  cluster: MonitoringFeedbackPromotionCluster;
}) {
  const progress = monitoringFeedbackPromotionProgress(cluster.stage);
  const currentStageIndex = monitoringFeedbackPromotionStageIndex(cluster.stage);
  const currentStep = cluster.stage ? currentStageIndex + 1 : 1;
  const currentCopy = cluster.stage
    ? monitoringFeedbackPromotionStageCopy[cluster.stage]
    : {
        label: "Ready for triage",
        plainDescription: "Confirm that this recurring pattern needs broader policy review.",
      };
  const rejectedShadowAttempt =
    cluster.latestRejectedAttempt?.requested_stage === "historical_shadow_test"
      ? cluster.latestRejectedAttempt
      : null;
  const displayedShadowEvidence = cluster.shadowReport || rejectedShadowAttempt;
  const legitimateCount = legitimateUpdateCount(displayedShadowEvidence);
  const legitimateItems = legitimateUpdateItems(
    displayedShadowEvidence?.legitimate_updates,
  );
  const shadowTestComplete = Boolean(cluster.shadowReport);
  const shadowAttemptRecorded = Boolean(displayedShadowEvidence);
  const canActivateGlobally = monitoringFeedbackPromotionCanActivateGlobally(cluster);
  const failedGate = monitoringFeedbackPromotionFailedGate(cluster);
  const activationBlocked = monitoringFeedbackPromotionNeedsActivationRollback(
    cluster.activationStatus,
  );
  const postSweepDeactivated =
    monitoringFeedbackPromotionPostSweepDeactivated(cluster);
  const activationInvalid =
    activationBlocked ||
    postSweepDeactivated ||
    cluster.resolutionIdentityDrifted;
  const appActivationParityPending =
    cluster.stage === "six_pm_canary" &&
    cluster.draftRuleActive &&
    !activationInvalid;
  const gatePassed = canActivateGlobally && !failedGate;
  const gateBlocked = activationInvalid || legitimateCount > 0 || Boolean(failedGate);
  const safeAction = operatorSafeAction(cluster);
  const cardId = `promotion-${encodeURIComponent(cluster.workflowId || cluster.clusterKey)}`;

  return (
    <article
      aria-labelledby={`${cardId}-title`}
      className={`card verified-promotion-card ${cluster.stage === "resolved" ? "verified-promotion-card-resolved" : ""}`}
      id={cardId}
    >
      <header className="verified-promotion-card-header">
        <div className="verified-promotion-card-badges">
          <span className="verified-promotion-stage-pill">
            Step {currentStep} of {progress.total}
          </span>
          <span className="verified-promotion-count-pill">
            {formatNumber(cluster.recurrenceCount)} {cluster.recurrenceCount === 1 ? "occurrence" : "occurrences"}
          </span>
          <span className="verified-promotion-count-pill">
            {formatNumber(cluster.sourceCount)} {cluster.sourceCount === 1 ? "source" : "sources"}
          </span>
          {activationInvalid ? (
            <span className="verified-promotion-blocked-pill">
              {cluster.resolutionIdentityDrifted
                ? "Post-sweep identity drift"
                : postSweepDeactivated
                ? "Post-sweep rule deactivated"
                : cluster.activationStatus === "blocked_late_evidence"
                ? "New evidence blocked activation"
                : "Rollback required"}
            </span>
          ) : cluster.draftRuleActive ? (
            <span className="verified-promotion-active-pill">
              {appActivationParityPending
                ? "App activation detected; worker parity pending"
                : cluster.stage === "retroactive_sweep" && cluster.resolutionReady
                ? "Ready to resolve"
                : cluster.stage === "retroactive_sweep"
                  ? "Hourly attestation pending"
                  : "Rule active globally"}
            </span>
          ) : null}
        </div>
        <time dateTime={cluster.updatedAt || cluster.lastSeenAt}>
          Updated {formatCentralDateTime(cluster.updatedAt || cluster.lastSeenAt)}
        </time>
      </header>

      <div className="verified-promotion-title-block">
        <p>{monitoringFeedbackLabel(cluster.reasonCode)}</p>
        <h3 id={`${cardId}-title`}>{cluster.domainTemplate}</h3>
        <span>Similar feedback is matched by evidence, page template, and reason.</span>
      </div>

      <div className="verified-promotion-current-step">
        <div>
          <span>Current step</span>
          <h4>{currentCopy.label}</h4>
          <p>{currentCopy.plainDescription}</p>
        </div>
        <strong>
          {activationInvalid ? "Verification invalidated" : `${progress.percent}% verified`}
        </strong>
      </div>
      <progress
        aria-label={`${currentCopy.label}: ${progress.completed} of ${progress.total} verification stages complete`}
        className="verified-promotion-progress"
        max={progress.total}
        value={progress.completed}
      />

      <dl className="verified-promotion-facts">
        <PromotionFact label="Recurrence" value={`${formatNumber(cluster.recurrenceCount)} reports`} />
        <PromotionFact label="Affected sources" value={formatNumber(cluster.sourceCount)} />
        <PromotionFact
          label="Legitimate updates"
          tone={legitimateCount > 0 ? "blocked" : shadowTestComplete ? "passed" : "pending"}
          value={shadowAttemptRecorded ? formatNumber(legitimateCount) : "Not measured"}
        />
        <PromotionFact label="Owner" value={cluster.ownerEmail || "Policy review"} />
      </dl>

      <div
        className={`verified-promotion-gate ${
          gatePassed
            ? "verified-promotion-gate-passed"
            : gateBlocked
              ? "verified-promotion-gate-blocked"
              : "verified-promotion-gate-locked"
        }`}
      >
        <div className="verified-promotion-gate-heading">
          {gatePassed ? (
            <ShieldCheck size={18} aria-hidden="true" />
          ) : gateBlocked ? (
            <TriangleAlert size={18} aria-hidden="true" />
          ) : (
            <LockKeyhole size={18} aria-hidden="true" />
          )}
          <div>
            <h4>
              {gatePassed
                ? appActivationParityPending
                  ? "Pre-activation gates passed; activated parity pending"
                  : "Global activation gates passed"
                : activationInvalid
                  ? cluster.resolutionIdentityDrifted
                    ? "Post-sweep identity drift requires rollback"
                    : postSweepDeactivated
                    ? "Post-sweep deactivation requires rollback repair"
                    : cluster.activationStatus === "blocked_late_evidence"
                    ? "New evidence invalidated the canary revision"
                    : "Activated verification failed; rollback is required"
                  : legitimateCount > 0
                  ? `${formatNumber(legitimateCount)} legitimate ${legitimateCount === 1 ? "update would" : "updates would"} also be hidden`
                  : failedGate
                    ? "The latest verification attempt did not pass"
                  : shadowTestComplete
                    ? "No legitimate update collision was found"
                    : "Global activation stays locked until the shadow test"}
            </h4>
            <p>
              {gatePassed
                ? appActivationParityPending
                  ? "The candidate is active in the current app policy, but the activated worker identity has not been re-attested yet."
                  : "The shadow test, regression suite, app/worker parity, and 6 PM canary are verified."
                : activationInvalid
                  ? failedGate
                  : legitimateCount > 0
                  ? "Narrow the draft rule and rerun verification before it can affect any other update."
                  : failedGate
                    ? failedGate
                  : shadowTestComplete
                    ? "Other verification gates must still pass before this rule can activate globally."
                    : "The historical test will show every legitimate update the proposed rule would suppress."}
            </p>
          </div>
        </div>

        {legitimateCount > 0 && (
          <div className="verified-promotion-legitimate-updates">
            <h5>Legitimate updates this draft would hide</h5>
            {legitimateItems.length > 0 ? (
              <ul>
                {legitimateItems.map((item) => (
                  <li key={item.key}>
                    {item.url ? (
                      <a href={item.url} rel="noreferrer" target="_blank">
                        {item.title}
                      </a>
                    ) : (
                      <strong>{item.title}</strong>
                    )}
                    {item.detail && <p>{item.detail}</p>}
                  </li>
                ))}
              </ul>
            ) : (
              <p>
                The shadow report counted {formatNumber(legitimateCount)}, but individual event
                details were not retained in this artifact.
              </p>
            )}
          </div>
        )}
      </div>

      <div className="verified-promotion-recommendation">
        <span>Recommended safe action</span>
        <h4>{safeAction}</h4>
        <p>
          {activationInvalid
            ? "AwardPing checks the restored app and worker identities hourly without launching paid review work, reverses candidate-attributable historical suppression, and returns to draft only after the rollback audit passes."
            : "This page provides controls for cluster confirmation, rule drafting, and final resolution. Activation is a reviewed deployment; automation owns the evidence gates and retroactive sweep."}
        </p>
      </div>

      <PromotionStageChecklist currentStageIndex={currentStageIndex} stageIsUnset={!cluster.stage} />

      <details className="verified-promotion-evidence">
        <summary>Evidence, hashes, and verification artifacts</summary>
        <div className="verified-promotion-evidence-body">
          <dl className="verified-promotion-evidence-grid">
            <EvidenceFact label="Evidence signature" value={cluster.evidenceSignature} />
            <EvidenceFact label="Domain template" value={cluster.domainTemplate} />
            <EvidenceFact label="Reason" value={monitoringFeedbackLabel(cluster.reasonCode)} />
            <EvidenceFact
              label="Requested scopes"
              value={cluster.requestedScopes.map(monitoringFeedbackLabel).join(", ") || "Not recorded"}
            />
            <EvidenceFact label="Feedback records" value={cluster.feedbackIds.join(", ")} />
            <EvidenceFact label="Workflow ID" value={cluster.workflowId || "Not created"} />
            <EvidenceFact
              label="Evidence revision"
              value={cluster.workflowVersion === null ? "Not created" : String(cluster.workflowVersion)}
            />
            <EvidenceFact label="Draft rule ID" value={cluster.draftPolicyRuleId || "Not drafted"} />
            <EvidenceFact
              label="Current policy state"
              value={
                appActivationParityPending
                  ? "Active in app; worker parity pending"
                  : cluster.draftRuleActive
                    ? "Verified active deployment"
                    : "Inactive candidate"
              }
            />
            <EvidenceFact
              label="Activation safety state"
              value={humanizeArtifactValue(cluster.activationStatus)}
            />
            <EvidenceFact
              label="Activation blocked"
              value={
                cluster.activationBlockedAt
                  ? formatCentralDateTime(cluster.activationBlockedAt)
                  : "No"
              }
            />
            <EvidenceFact
              label="Final hourly attestation"
              value={
                cluster.resolutionIdentityDrifted
                  ? "Blocked by post-sweep identity drift"
                  : cluster.resolutionReady && cluster.resolutionAttestedAt
                  ? `Ready since ${formatCentralDateTime(cluster.resolutionAttestedAt)}`
                  : cluster.stage === "retroactive_sweep"
                    ? "Waiting — automatic and no API charge"
                    : "Not reached"
              }
            />
            <EvidenceFact
              label="Resolution identity"
              value={
                cluster.resolutionIdentityDriftReason ||
                (cluster.stage === "retroactive_sweep"
                  ? "Matches the immutable activation identity"
                  : "Not reached")
              }
            />
            <EvidenceFact
              label="Resolution worker run"
              value={cluster.resolutionWorkerRunId || "Not recorded"}
            />
            <EvidenceFact
              label="Known real update fixtures"
              value={
                cluster.legitimateNegativeEventIds.join(", ") ||
                "Required when drafting"
              }
            />
            <EvidenceFact label="First seen" value={formatCentralDateTime(cluster.firstSeenAt)} />
            <EvidenceFact label="Last seen" value={formatCentralDateTime(cluster.lastSeenAt)} />
          </dl>

          {cluster.draftSummary && (
            <div className="verified-promotion-draft-summary">
              <h5>Draft rule boundary</h5>
              <p>{cluster.draftSummary}</p>
            </div>
          )}

          <HashEvidence evidence={cluster.hashAttestation} />

          <div className="verified-promotion-artifacts">
            {cluster.blockingReport && (
              <ArtifactCard
                evidence={cluster.blockingReport}
                title="Current activation / rollback blocker"
              />
            )}
            {cluster.latestRejectedAttempt && (
              <ArtifactCard
                evidence={cluster.latestRejectedAttempt}
                showRawEvidence
                title="Latest rejected attempt"
              />
            )}
            <ArtifactCard evidence={cluster.shadowReport} title="Historical shadow test" />
            <ArtifactCard evidence={cluster.regressionReport} title="Regression tests" />
            <ArtifactCard evidence={cluster.hashAttestation} title="App/worker hash check" />
            <ArtifactCard evidence={cluster.canaryReport} title="6 PM canary" />
            <ArtifactCard evidence={cluster.retroactiveSweepReport} title="Retroactive sweep" />
          </div>

          <details className="verified-promotion-sample">
            <summary>Sample clustered feedback</summary>
            <pre>{JSON.stringify(cluster.sampleFeedback, null, 2)}</pre>
          </details>
        </div>
      </details>

      <AdminVerifiedPromotionControl
        candidateRuleIds={candidateRuleIds}
        defaultDraftSummary={cluster.draftSummary}
        defaultLegitimateNegativeEventIds={[
          ...new Set([
            ...cluster.legitimateNegativeEventIds,
            ...legitimateUpdateEventIds(cluster.shadowReport?.legitimate_updates),
          ]),
        ]}
        defaultPolicyRuleId={cluster.draftPolicyRuleId}
        expectedVersion={cluster.workflowVersion ?? 0}
        activationBlocked={activationBlocked || postSweepDeactivated}
        hasFailedGate={Boolean(failedGate)}
        resolutionIdentityDrifted={cluster.resolutionIdentityDrifted}
        resolutionIdentityDriftReason={cluster.resolutionIdentityDriftReason}
        ruleActive={cluster.draftRuleActive}
        resolutionReady={cluster.resolutionReady}
        stage={cluster.stage}
        workflowId={cluster.workflowId}
      />
    </article>
  );
}

function PromotionFact({
  label,
  tone = "neutral",
  value,
}: {
  label: string;
  tone?: "neutral" | "pending" | "passed" | "blocked";
  value: string;
}) {
  return (
    <div className={`verified-promotion-fact verified-promotion-fact-${tone}`}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function PromotionStageChecklist({
  currentStageIndex,
  stageIsUnset,
}: {
  currentStageIndex: number;
  stageIsUnset: boolean;
}) {
  return (
    <div className="verified-promotion-checklist">
      <div>
        <span>Verified promotion workflow</span>
        <p>Stages advance only when their evidence is recorded.</p>
      </div>
      <ol aria-label="Nine verified promotion stages" className="verified-promotion-stages">
        {monitoringFeedbackPromotionStages.map((stage, index) => {
          const isCurrent = stageIsUnset ? index === 0 : index === currentStageIndex;
          const isComplete = !stageIsUnset && index < currentStageIndex;
          const copy = monitoringFeedbackPromotionStageCopy[stage];
          return (
            <li
              aria-current={isCurrent ? "step" : undefined}
              className={
                isCurrent
                  ? "verified-promotion-stage-current"
                  : isComplete
                    ? "verified-promotion-stage-complete"
                    : "verified-promotion-stage-pending"
              }
              key={stage}
            >
              {isComplete ? (
                <CheckCircle2 size={18} aria-hidden="true" />
              ) : (
                <CircleDashed size={18} aria-hidden="true" />
              )}
              <div>
                <span>Step {index + 1}</span>
                <strong>{copy.label}</strong>
                <p>{isCurrent ? "Current stage" : isComplete ? "Complete" : "Pending"}</p>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function EvidenceFact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function HashEvidence({ evidence }: { evidence: MonitoringFeedbackPromotionEvidence | null }) {
  const hashes = [
    ["App revision", evidence?.app_revision],
    ["Worker revision", evidence?.worker_revision],
    ["App policy hash", evidence?.app_policy_hash],
    ["Worker policy hash", evidence?.worker_policy_hash],
    ["App Batch hash", evidence?.app_batch_policy_hash],
    ["Worker Batch hash", evidence?.worker_batch_policy_hash],
    ["App suppression hash", evidence?.app_suppression_policy_hash],
    ["Worker suppression hash", evidence?.worker_suppression_policy_hash],
    ["App matcher hash", evidence?.app_matcher_digest],
    ["Worker matcher hash", evidence?.worker_matcher_digest],
  ].filter((item): item is [string, string] => typeof item[1] === "string" && item[1].length > 0);

  if (hashes.length === 0) return null;

  return (
    <div className="verified-promotion-hashes">
      <h5>App and worker hashes</h5>
      <dl>
        {hashes.map(([label, value]) => (
          <EvidenceFact key={label} label={label} value={value} />
        ))}
      </dl>
    </div>
  );
}

function ArtifactCard({
  evidence,
  showRawEvidence = false,
  title,
}: {
  evidence: MonitoringFeedbackPromotionEvidence | null;
  showRawEvidence?: boolean;
  title: string;
}) {
  if (!evidence) {
    return (
      <section className="verified-promotion-artifact verified-promotion-artifact-pending">
        <h5>{title}</h5>
        <p>Not recorded yet.</p>
      </section>
    );
  }

  const failureItems = artifactFailureItems(evidence);
  const statusCounts = artifactStatusCounts(evidence.candidate_status_counts);
  const facts = [
    ["Status", evidence.status],
    [
      "Attempted stage",
      typeof evidence.requested_stage === "string"
        ? humanizeArtifactValue(evidence.requested_stage)
        : null,
    ],
    [
      "Failure reason",
      typeof evidence.failure_reason === "string"
        ? evidence.failure_reason
        : null,
    ],
    [
      "Safe action",
      typeof evidence.safe_action === "string" ? evidence.safe_action : null,
    ],
    ["Report ID", evidence.report_id],
    ["Digest", evidence.digest],
    ["Completed", evidence.completed_at ? formatCentralDateTime(evidence.completed_at) : null],
    ["History checked", formatOptionalNumber(evidence.total_history_checked)],
    ["Proposed matches", formatOptionalNumber(evidence.proposed_rule_matches)],
    ["Legitimate updates", formatOptionalNumber(evidence.legitimate_updates_suppressed)],
    ["Regression failures", formatOptionalNumber(evidence.failure_count)],
    ["Expected candidates", formatOptionalNumber(evidence.expected_candidate_count)],
    ["Observed candidates", formatOptionalNumber(evidence.bound_candidate_count)],
    ["Bound update events", formatOptionalNumber(evidence.bound_event_count)],
    ["Expected shards", formatOptionalNumber(evidence.expected_shards)],
    ["Observed shards", formatOptionalNumber(evidence.observed_shards)],
    ["Completed shards", formatOptionalNumber(evidence.completed_shards)],
    ["Sweep checked", formatOptionalNumber(evidence.scanned_count)],
    ["Sweep hidden", formatOptionalNumber(evidence.suppressed_count)],
    ["Sweep errors", formatOptionalNumber(evidence.error_count)],
  ].filter((item): item is [string, string] => typeof item[1] === "string" && item[1].length > 0);

  return (
    <section className={`verified-promotion-artifact verified-promotion-artifact-${evidence.status || "recorded"}`}>
      <h5>{title}</h5>
      {evidence.summary && <p>{evidence.summary}</p>}
      <dl>
        {facts.map(([label, value]) => (
          <EvidenceFact key={label} label={label} value={value} />
        ))}
      </dl>
      {statusCounts.length > 0 && (
        <div className="verified-promotion-artifact-detail">
          <h6>Candidate results</h6>
          <p>{statusCounts.join(" · ")}</p>
        </div>
      )}
      {failureItems.length > 0 && (
        <div className="verified-promotion-artifact-detail verified-promotion-artifact-failures">
          <h6>What failed</h6>
          <ul>
            {failureItems.map((item) => (
              <li key={item.key}>
                <strong>{item.title}</strong>
                <span>{item.detail}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {failureItems.length > 0 && (
        <div className="verified-promotion-artifact-detail">
          <h6>Safe fix</h6>
          <p>{artifactSafeFix(title)}</p>
        </div>
      )}
      {showRawEvidence && (
        <details className="verified-promotion-sample">
          <summary>Complete rejected-attempt evidence</summary>
          <pre>{JSON.stringify(evidence, null, 2)}</pre>
        </details>
      )}
    </section>
  );
}

type ArtifactFailureItem = {
  key: string;
  title: string;
  detail: string;
};

function artifactFailureItems(
  evidence: MonitoringFeedbackPromotionEvidence,
): ArtifactFailureItem[] {
  const candidateFailures = jsonArray(evidence.candidate_terminal_failures).flatMap(
    (value, index) => {
      const item = jsonObject(value);
      if (!item) return [];
      const candidateId = jsonText(item.candidate_id);
      const status = jsonText(item.status) || "failed";
      return [{
        key: `candidate-${candidateId || index}-${status}`,
        title: candidateId ? `Candidate ${candidateId}` : "Candidate count check",
        detail: `${humanizeArtifactValue(status)}: ${jsonText(item.reason) || "The candidate did not reach a safe terminal result."}`,
      }];
    },
  );
  const explicitRegressionFailures = jsonArray(evidence.fixture_failures);
  const regressionValues = explicitRegressionFailures.length > 0
    ? explicitRegressionFailures
    : jsonArray(evidence.fixture_results);
  const regressionFailures = regressionValues.flatMap(
    (value, index) => {
      const item = jsonObject(value);
      if (!item) return [];
      const expected = jsonText(item.expected);
      const matched = item.matched === true;
      const failed =
        explicitRegressionFailures.length > 0 ||
        (expected === "suppressed" && !matched) ||
        (expected === "visible" && matched);
      if (!failed) return [];
      const fixtureId = jsonText(item.fixture_id) || `Fixture ${index + 1}`;
      return [{
        key: `fixture-${fixtureId}`,
        title: `Fixture ${fixtureId}`,
        detail: jsonText(item.failure_reason) ||
          (expected === "visible"
            ? matched
              ? "A legitimate update matched the proposed suppression rule."
              : "The bound legitimate update could not be loaded or validated."
            : "A known false update did not match the proposed suppression rule."),
      }];
    },
  );
  const explicitSweepFailures = jsonArray(evidence.sweep_errors);
  const sweepValues = explicitSweepFailures.length > 0
    ? explicitSweepFailures
    : jsonArray(evidence.errors);
  const sweepFailures = sweepValues.flatMap((value, index) => {
    const item = jsonObject(value);
    if (!item) return [];
    const eventId = jsonText(item.event_id);
    return [{
      key: `sweep-${eventId || index}`,
      title: eventId ? `Update ${eventId}` : "Sweep checkpoint",
      detail: jsonText(item.message) || "The sweep could not finish this item.",
    }];
  });
  const identityFailures = jsonArray(evidence.comparisons).flatMap(
    (value, index) => {
      const item = jsonObject(value);
      if (!item || item.matches !== false) return [];
      const kind = jsonText(item.kind) || `Identity ${index + 1}`;
      const appHash = jsonText(item.app_hash) || "missing";
      const workerHash = jsonText(item.worker_hash) || "missing";
      return [{
        key: `identity-${kind}`,
        title: `${humanizeArtifactValue(kind)} mismatch`,
        detail: `App: ${appHash}; worker: ${workerHash}.`,
      }];
    },
  );

  return [
    ...candidateFailures,
    ...regressionFailures,
    ...sweepFailures,
    ...identityFailures,
  ];
}

function artifactStatusCounts(value: Json | undefined) {
  const counts = jsonObject(value);
  if (!counts) return [];
  return Object.entries(counts)
    .filter((entry): entry is [string, number] =>
      typeof entry[1] === "number" && Number.isFinite(entry[1]),
    )
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([status, count]) =>
      `${formatNumber(count)} ${humanizeArtifactValue(status).toLocaleLowerCase("en-US")}`,
    );
}

function artifactSafeFix(title: string) {
  if (title === "Historical shadow test") {
    return "Narrow the configured candidate rule, then restart from the saved cluster so history is tested again.";
  }
  if (title === "Regression tests") {
    return "Repair the named fixtures or narrow the candidate rule, then restart verification from the draft.";
  }
  if (title === "App/worker hash check") {
    return "Deploy the same reviewed commit and matcher to the app and worker, then let the automatic check run again.";
  }
  if (title === "6 PM canary") {
    return "Repair the listed candidate or shard failure and wait for the next normal 6 PM cohort; do not start a paid extra scan.";
  }
  return "Keep the candidate inactive and repair the listed failure. AwardPing will verify the restored app/worker revision, reverse or safely re-attribute candidate-attributable suppressions, and return the cluster to draft for full revalidation.";
}

function humanizeArtifactValue(value: string) {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\w/, (letter) => letter.toLocaleUpperCase("en-US"));
}

function compareClusters(
  left: MonitoringFeedbackPromotionCluster,
  right: MonitoringFeedbackPromotionCluster,
) {
  const leftResolved = left.stage === "resolved" ? 1 : 0;
  const rightResolved = right.stage === "resolved" ? 1 : 0;
  if (leftResolved !== rightResolved) return leftResolved - rightResolved;
  if (left.recurrenceCount !== right.recurrenceCount) {
    return right.recurrenceCount - left.recurrenceCount;
  }
  return left.firstSeenAt.localeCompare(right.firstSeenAt);
}

function operatorSafeAction(cluster: MonitoringFeedbackPromotionCluster) {
  const failedGate = monitoringFeedbackPromotionFailedGate(cluster);
  if (failedGate) return monitoringFeedbackPromotionSafeAction(cluster);

  switch (cluster.stage) {
    case "rule_drafted":
      return "Wait for the automatic historical shadow test artifact.";
    case "historical_shadow_test":
      return "Wait for the automatic regression test artifact.";
    case "regression_tests_pass":
      return "Wait for the automatic app and worker hash attestation.";
    case "app_worker_hashes_match":
      return "Wait for the next scheduled 6 PM canary scan.";
    case "six_pm_canary":
      return cluster.draftRuleActive
        ? "The rule is active. Let automation verify the activated app and worker identities, then continue the bounded sweep from its saved cursor."
        : "Change only this candidate to active, deploy the same reviewed build to the app and workers, then let automation run the sweep.";
    default:
      return monitoringFeedbackPromotionSafeAction(cluster);
  }
}

function legitimateUpdateCount(evidence: MonitoringFeedbackPromotionEvidence | null) {
  const value = evidence?.legitimate_updates_suppressed;
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
}

function legitimateUpdateItems(value: Json | undefined): LegitimateUpdateItem[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((entry, index) => {
    if (typeof entry === "string" && entry.trim()) {
      return [{ key: `text-${index}`, title: entry.trim(), detail: null, url: null }];
    }
    const record = jsonObject(entry);
    if (!record) return [];
    const title =
      jsonText(record.summary) ||
      jsonText(record.title) ||
      jsonText(record.source_title) ||
      `Legitimate update ${index + 1}`;
    const detail =
      jsonText(record.reason) ||
      jsonText(record.detail) ||
      jsonText(record.detected_at) ||
      null;
    const eventId = jsonText(record.event_id) || jsonText(record.id) || String(index);
    return [
      {
        key: eventId,
        title,
        detail,
        url: safeExternalUrl(jsonText(record.source_url)),
      },
    ];
  });
}

function legitimateUpdateEventIds(value: Json | undefined) {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => jsonText(jsonObject(entry)?.event_id))
    .filter((eventId): eventId is string => Boolean(eventId));
}

function jsonObject(value: Json | undefined): { [key: string]: Json | undefined } | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as { [key: string]: Json | undefined })
    : null;
}

function jsonArray(value: Json | undefined): Json[] {
  return Array.isArray(value) ? value : [];
}

function jsonText(value: Json | undefined) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function safeExternalUrl(value: string | null) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function formatOptionalNumber(value: Json | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? formatNumber(value) : null;
}

function formatNumber(value: number) {
  return new Intl.NumberFormat("en-US").format(value);
}
