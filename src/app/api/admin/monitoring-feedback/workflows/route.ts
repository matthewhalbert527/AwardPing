import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { validateSameOriginAdminMutation } from "@/lib/admin-request-security";
import { getCurrentUser, isSiteAdminEmail } from "@/lib/auth";
import {
  awardMonitoringPolicyIdentity,
  isCandidateMonitoringPolicyFlag,
  isGloballyActiveMonitoringPolicyRule,
  monitoringPolicyFlagIdForAlias,
  monitoringPolicyRuleDefinitionForReview,
  reviewableMonitoringPolicyFlagIdForAlias,
} from "@/lib/award-monitoring-policy";
import { hasSupabaseAdminConfig, hasSupabaseConfig } from "@/lib/config";
import type { Database, Json } from "@/lib/database.types";
import { currentMonitoringPromotionAppIdentity } from "@/lib/monitoring-feedback-promotion-identity";
import {
  type MonitoringFeedbackPromotionStage,
} from "@/lib/monitoring-feedback-promotion";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

const workflowActions = [
  "confirm_cluster",
  "draft_rule",
  "restart_draft",
  "resolve",
] as const;

const workflowSchema = z
  .strictObject({
    requestId: z.string().uuid(),
    workflowId: z.string().uuid(),
    expectedVersion: z.number().int().min(1),
    action: z.enum(workflowActions),
    policyRuleId: z.string().trim().min(1).max(160).optional(),
    draftSummary: z.string().trim().min(1).max(1000).optional(),
    legitimateNegativeEventIds: z
      .array(z.string().uuid())
      .min(1)
      .max(50)
      .optional(),
  })
  .superRefine((value, context) => {
    if (value.action === "draft_rule") {
      if (!value.policyRuleId) {
        context.addIssue({
          code: "custom",
          message: "Choose a configured rule for this draft.",
          path: ["policyRuleId"],
        });
      } else if (
        !isCandidateMonitoringPolicyFlag(value.policyRuleId)
      ) {
        context.addIssue({
          code: "custom",
          message:
            "Choose an implemented candidate rule that is reviewable but not active globally yet.",
          path: ["policyRuleId"],
        });
      }
      if (!value.draftSummary) {
        context.addIssue({
          code: "custom",
          message: "Describe the narrow rule boundary and what it must keep visible.",
          path: ["draftSummary"],
        });
      }
      if (!value.legitimateNegativeEventIds?.length) {
        context.addIssue({
          code: "custom",
          message:
            "Add at least one operator-confirmed real update that this rule must keep visible.",
          path: ["legitimateNegativeEventIds"],
        });
      } else if (
        new Set(
          value.legitimateNegativeEventIds.map((eventId) =>
            eventId.toLocaleLowerCase("en-US"),
          ),
        ).size !==
        value.legitimateNegativeEventIds.length
      ) {
        context.addIssue({
          code: "custom",
          message: "Known real update IDs must be unique.",
          path: ["legitimateNegativeEventIds"],
        });
      }
      return;
    }

    if (value.action === "resolve" && !value.policyRuleId) {
      context.addIssue({
        code: "custom",
        message: "Confirm the immutable drafted rule before resolving this cluster.",
        path: ["policyRuleId"],
      });
    }

    if (
      (value.action === "confirm_cluster" || value.action === "restart_draft") &&
      (value.policyRuleId ||
        value.draftSummary ||
        value.legitimateNegativeEventIds)
    ) {
      context.addIssue({
        code: "custom",
        message: "This checkpoint does not accept a replacement rule draft.",
      });
    }

    if (
      value.action === "resolve" &&
      (value.draftSummary || value.legitimateNegativeEventIds)
    ) {
      context.addIssue({
        code: "custom",
        message: "The immutable rule draft cannot be changed during resolution.",
        path: ["draftSummary"],
      });
    }
  });

type PromotionClusterRow =
  Database["public"]["Functions"]["get_monitoring_feedback_promotion_cluster"]["Returns"][number];

const actionTransitions: Record<
  Exclude<(typeof workflowActions)[number], "restart_draft">,
  { from: MonitoringFeedbackPromotionStage; to: MonitoringFeedbackPromotionStage }
> = {
  confirm_cluster: {
    from: "triaged",
    to: "similar_feedback_clustered",
  },
  draft_rule: {
    from: "similar_feedback_clustered",
    to: "rule_drafted",
  },
  resolve: {
    from: "retroactive_sweep",
    to: "resolved",
  },
};

export async function POST(request: Request) {
  const originError = validateSameOriginAdminMutation(request);
  if (originError) return originError;

  const setup = await validateAdminRequest();
  if (setup.response) return setup.response;

  const parsed = workflowSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      {
        ok: false,
        error:
          parsed.error.issues[0]?.message ||
          "Choose a valid verified-promotion checkpoint.",
      },
      { status: 400 },
    );
  }

  const admin = createSupabaseAdminClient();
  const loaded = await admin.rpc("get_monitoring_feedback_promotion_cluster", {
    p_cluster_id: parsed.data.workflowId,
  });
  if (loaded.error) return workflowDatabaseError(loaded.error);

  const cluster = loaded.data?.[0];
  if (!cluster) {
    return NextResponse.json(
      { ok: false, error: "That feedback cluster no longer exists." },
      { status: 404 },
    );
  }

  if (parsed.data.expectedVersion !== Number(cluster.evidence_revision)) {
    return NextResponse.json(
      {
        ok: false,
        error: "This cluster changed after the page loaded. Refresh before continuing.",
      },
      { status: 409 },
    );
  }

  if (parsed.data.action === "resolve" && cluster.current_stage === "resolved") {
    const replayRuleId = reviewableMonitoringPolicyFlagIdForAlias(
      parsed.data.policyRuleId,
    );
    if (!replayRuleId || replayRuleId !== cluster.proposed_rule_id) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "This resolved replay does not match the immutable rule from the original request.",
        },
        { status: 409 },
      );
    }
    const replayed = await admin.rpc(
      "replay_monitoring_feedback_promotion_resolution",
      {
        p_request_id: parsed.data.requestId,
        p_cluster_id: cluster.cluster_id,
        p_expected_evidence_revision: parsed.data.expectedVersion,
        p_actor_user_id: setup.user.id,
        p_actor_email: setup.user.email || "",
        p_policy_rule_id: replayRuleId,
      },
    );
    if (replayed.error) return workflowDatabaseError(replayed.error);
    const replay = replayed.data?.[0];
    if (!replay || !replay.accepted || replay.current_stage !== "resolved") {
      return NextResponse.json(
        { ok: false, error: "The original accepted resolution could not be replayed." },
        { status: 409 },
      );
    }
    return NextResponse.json({
      ok: true,
      transitionId: replay.transition_id,
      clusterId: replay.advanced_cluster_id,
      clusterKey: cluster.cluster_key,
      previousStage: replay.previous_stage,
      currentStage: replay.current_stage,
      requestedStage: replay.requested_stage,
      advanced: replay.advanced,
      promotionCount: replay.promotion_count,
      recurrenceCount: Number(replay.recurrence_count || 0),
      evidenceRevision: Number(replay.current_evidence_revision || 0),
    });
  }

  if (parsed.data.action === "restart_draft") {
    const restartableStages = new Set([
      "rule_drafted",
      "historical_shadow_test",
      "regression_tests_pass",
      "app_worker_hashes_match",
      // An exact idempotent replay reaches the already-reset stage.
      "similar_feedback_clustered",
    ]);
    if (!restartableStages.has(cluster.current_stage)) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "Only a failed pre-activation check can return to the rule draft. Refresh the workflow before continuing.",
        },
        { status: 409 },
      );
    }
    if (
      cluster.proposed_rule_id &&
      isGloballyActiveMonitoringPolicyRule(cluster.proposed_rule_id)
    ) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "Deactivate the live rule and deploy matching app and worker revisions before returning this failed gate to draft.",
        },
        { status: 409 },
      );
    }
    if (
      cluster.current_stage !== "similar_feedback_clustered" &&
      cluster.latest_attempt_accepted !== false
    ) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "This check has not recorded a restartable failure. Let automatic verification continue.",
        },
        { status: 409 },
      );
    }

    const restarted = await admin.rpc(
      "restart_monitoring_feedback_promotion_cluster",
      {
        p_request_id: parsed.data.requestId,
        p_cluster_id: cluster.cluster_id,
        p_expected_evidence_revision: parsed.data.expectedVersion,
        p_actor_user_id: setup.user.id,
        p_actor_email: setup.user.email || "",
        p_note:
          "Operator reviewed the failed gate and requested a narrower replacement draft.",
      },
    );
    if (restarted.error) return workflowDatabaseError(restarted.error);
    const result = restarted.data?.[0];
    if (!result) {
      return NextResponse.json(
        { ok: false, error: "The verified promotion restart returned no result." },
        { status: 500 },
      );
    }
    return NextResponse.json({
      ok: true,
      transitionId: result.transition_id,
      clusterId: result.restarted_cluster_id,
      clusterKey: cluster.cluster_key,
      previousStage: result.previous_stage,
      currentStage: result.current_stage,
      restarted: result.restarted,
      failedTransitionId: result.failed_transition_id,
      evidenceRevision: Number(result.restart_evidence_revision || 0),
    });
  }

  const transition = actionTransitions[parsed.data.action];
  if (
    cluster.current_stage !== transition.from &&
    cluster.current_stage !== transition.to
  ) {
    return NextResponse.json(
      {
        ok: false,
        error: `This action can run only from ${plainStage(transition.from)}. Refresh the workflow before continuing.`,
      },
      { status: 409 },
    );
  }

  const transitionInput = await buildTransitionInput(
    parsed.data,
    cluster,
    transition.to,
    setup.user,
    admin,
  );
  if ("response" in transitionInput) return transitionInput.response;

  const advanced = await admin.rpc(
    "advance_monitoring_feedback_promotion_cluster",
    transitionInput.args,
  );
  if (advanced.error) return workflowDatabaseError(advanced.error);

  const result = advanced.data?.[0];
  if (!result) {
    return NextResponse.json(
      { ok: false, error: "The verified promotion transaction returned no result." },
      { status: 500 },
    );
  }
  if (!result.accepted) {
    return NextResponse.json(
      {
        ok: false,
        error: result.failure_reason || "The verification evidence did not pass.",
        currentStage: result.current_stage,
        requestedStage: result.requested_stage,
      },
      { status: 409 },
    );
  }

  return NextResponse.json({
    ok: true,
    transitionId: result.transition_id,
    clusterId: result.advanced_cluster_id,
    clusterKey: cluster.cluster_key,
    previousStage: result.previous_stage,
    currentStage: result.current_stage,
    requestedStage: result.requested_stage,
    advanced: result.advanced,
    promotionCount: result.promotion_count,
    recurrenceCount: Number(result.recurrence_count || 0),
    evidenceRevision: Number(result.current_evidence_revision || 0),
  });
}

async function buildTransitionInput(
  input: z.infer<typeof workflowSchema>,
  cluster: PromotionClusterRow,
  toStage: MonitoringFeedbackPromotionStage,
  actor: { id: string; email?: string | null },
  admin: ReturnType<typeof createSupabaseAdminClient>,
): Promise<
  | {
      args: Database["public"]["Functions"]["advance_monitoring_feedback_promotion_cluster"]["Args"];
    }
  | { response: NextResponse }
> {
  const common = {
    p_request_id: input.requestId,
    p_cluster_id: cluster.cluster_id,
    p_expected_evidence_revision: input.expectedVersion,
    p_to_stage: toStage,
    p_actor_user_id: actor.id,
    p_actor_email: actor.email || "",
  };

  if (input.action === "confirm_cluster") {
    return {
      args: {
        ...common,
        p_evidence: {
          cluster_reviewed: true,
          recurrence_count: Number(cluster.recurrence_count || 0),
          source_count: Number(cluster.source_count || 0),
          evidence_signature: cluster.evidence_signature,
          domain_template: cluster.domain_template,
          reason_code: cluster.reason_code,
        },
      },
    };
  }

  if (input.action === "draft_rule") {
    const canonicalRuleId = reviewableMonitoringPolicyFlagIdForAlias(
      input.policyRuleId,
    );
    const draft = canonicalRuleId
      ? buildMonitoringFeedbackRuleDraft(canonicalRuleId)
      : null;
    if (!canonicalRuleId || !draft) {
      return {
        response: NextResponse.json(
          {
            ok: false,
            error:
              "Choose an implemented candidate rule that is reviewable but not active globally yet.",
          },
          { status: 400 },
        ),
      };
    }
    const identity = currentMonitoringPromotionAppIdentity();
    return {
      args: {
        ...common,
        p_evidence: {
          rule_id: canonicalRuleId,
          draft_hash: draft.hash,
          rule: draft.rule,
          candidate_active: false,
          draft_summary: cleanText(input.draftSummary),
          legitimate_negative_event_ids:
            canonicalLegitimateNegativeEventIds(
              input.legitimateNegativeEventIds || [],
            ),
        },
        p_policy_rule_id: canonicalRuleId,
        p_policy_identity: identity.policy_identity,
        p_policy_version: identity.policy_version,
        p_policy_hash: identity.policy_hash,
        p_policy_config_version: awardMonitoringPolicyIdentity.policyVersion,
        p_decision_memory_version:
          awardMonitoringPolicyIdentity.decisionMemoryVersion,
        p_note: cleanText(input.draftSummary),
      },
    };
  }

  const immutableRuleId = cluster.proposed_rule_id;
  const submittedRuleId = monitoringPolicyFlagIdForAlias(input.policyRuleId);
  if (
    !immutableRuleId ||
    !submittedRuleId ||
    submittedRuleId !== immutableRuleId ||
    !isGloballyActiveMonitoringPolicyRule(immutableRuleId)
  ) {
    return {
      response: NextResponse.json(
        {
          ok: false,
          error:
            "The immutable drafted rule must be active, alert-blocking, and persistent in the current policy before this cluster can be resolved.",
        },
        { status: 409 },
      ),
    };
  }

  const identity = currentMonitoringPromotionAppIdentity();
  const workerAttestation = await loadFreshResolutionWorkerAttestation(
    admin,
    cluster,
    identity,
  );
  if ("response" in workerAttestation) return workerAttestation;
  return {
    args: {
      ...common,
      p_evidence: {
        confirmed: true,
        app_revision: identity.revision,
        app_policy_hash: identity.policy_hash,
        app_batch_policy_hash: identity.batch_policy_hash,
        app_suppression_policy_hash: identity.suppression_policy_hash,
        app_matcher_digest: identity.matcher_hash,
        ...workerAttestation.evidence,
      },
      p_policy_rule_id: immutableRuleId,
      p_policy_identity: identity.policy_identity,
      p_policy_version: identity.policy_version,
      p_policy_hash: identity.policy_hash,
      p_policy_config_version: awardMonitoringPolicyIdentity.policyVersion,
      p_decision_memory_version:
        awardMonitoringPolicyIdentity.decisionMemoryVersion,
    },
  };
}

async function loadFreshResolutionWorkerAttestation(
  admin: ReturnType<typeof createSupabaseAdminClient>,
  cluster: PromotionClusterRow,
  identity: ReturnType<typeof currentMonitoringPromotionAppIdentity>,
): Promise<
  | {
      evidence: {
        cluster_id: string;
        evidence_revision: number;
        completed_at: string;
        worker_run_ids: string[];
        worker_revision: string;
        worker_policy_hash: string;
        worker_batch_policy_hash: string;
        worker_suppression_policy_hash: string;
        worker_matcher_digest: string;
      };
    }
  | { response: NextResponse }
> {
  const stageArtifacts = jsonObject(cluster.stage_artifacts);
  const retroactiveSweep = jsonObject(stageArtifacts.retroactive_sweep);
  const sweepCompletedAt = canonicalPreciseRfc3339(
    cleanText(retroactiveSweep.completed_at),
  );
  if (!sweepCompletedAt) {
    return {
      response: NextResponse.json(
        {
          ok: false,
          error:
            "The completed retroactive sweep timestamp is missing. Let automatic verification repair this workflow before resolving it.",
        },
        { status: 409 },
      ),
    };
  }

  const workerRuns = await admin.rpc(
    "find_monitoring_feedback_resolution_worker_run",
    {
      p_cluster_id: cluster.cluster_id,
      p_expected_evidence_revision: Number(cluster.evidence_revision),
      p_not_before: sweepCompletedAt,
      p_worker_revision: identity.revision,
      p_worker_policy_hash: identity.policy_hash,
      p_worker_batch_policy_hash: identity.batch_policy_hash,
      p_worker_suppression_policy_hash: identity.suppression_policy_hash,
      p_worker_matcher_digest: identity.matcher_hash,
    },
  );
  if (workerRuns.error) {
    return { response: workflowDatabaseError(workerRuns.error) };
  }

  const matchingRun = workerRuns.data?.[0];
  const attestationFinishedAt = canonicalPreciseRfc3339(
    cleanText(matchingRun?.finished_at),
  );
  if (
    !matchingRun ||
    !attestationFinishedAt ||
    comparePreciseRfc3339(attestationFinishedAt, sweepCompletedAt) !== 1
  ) {
    return {
      response: NextResponse.json(
        {
          ok: false,
          error:
            "Wait for the next normal hourly, zero-charge matching worker attestation completed after the retroactive sweep.",
        },
        { status: 409 },
      ),
    };
  }

  return {
    evidence: {
      cluster_id: cluster.cluster_id,
      evidence_revision: Number(cluster.evidence_revision),
      completed_at: attestationFinishedAt,
      worker_run_ids: [matchingRun.worker_run_id],
      worker_revision: cleanText(matchingRun.worker_revision),
      worker_policy_hash: cleanText(matchingRun.worker_policy_hash),
      worker_batch_policy_hash: cleanText(matchingRun.worker_batch_policy_hash),
      worker_suppression_policy_hash: cleanText(
        matchingRun.worker_suppression_policy_hash,
      ),
      worker_matcher_digest: cleanText(matchingRun.worker_matcher_digest),
    },
  };
}

async function validateAdminRequest() {
  if (!hasSupabaseConfig() || !hasSupabaseAdminConfig()) {
    return {
      response: NextResponse.json(
        { ok: false, error: "Admin verified promotions are not configured." },
        { status: 503 },
      ),
      user: null,
    } as const;
  }

  const user = await getCurrentUser();
  if (!user) {
    return {
      response: NextResponse.json(
        { ok: false, error: "Log in first." },
        { status: 401 },
      ),
      user: null,
    } as const;
  }
  if (!isSiteAdminEmail(user.email)) {
    return {
      response: NextResponse.json(
        {
          ok: false,
          error: "Only AwardPing site admins can advance verified promotions.",
        },
        { status: 403 },
      ),
      user,
    } as const;
  }

  return { response: null, user } as const;
}

export function buildMonitoringFeedbackRuleDraft(
  canonicalRuleId: string,
) {
  const definition = monitoringPolicyRuleDefinitionForReview(canonicalRuleId);
  if (!definition) return null;
  const rule = JSON.parse(JSON.stringify(definition)) as Json;
  const hash = createHash("sha256")
    .update(canonicalJson(rule), "utf8")
    .digest("hex");
  return { hash, rule };
}

function workflowDatabaseError(error: { code?: string; message?: string }) {
  const message = error.message || "The verified promotion workflow could not advance.";
  if (error.code === "P0002") {
    return NextResponse.json(
      { ok: false, error: "That feedback cluster no longer exists." },
      { status: 404 },
    );
  }
  if (
    error.code === "23505" &&
    /monitoring_feedback_promotion_clusters_unresolved_rule_idx|proposed_rule_id/i.test(
      message,
    )
  ) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "That candidate rule already belongs to another open verified-promotion cluster. Finish or roll back that workflow before reusing it.",
      },
      { status: 409 },
    );
  }
  if (
    error.code === "P0001" ||
    error.code === "23505" ||
    error.code === "40001" ||
    (error.code === "22023" && /request ID|advance sequentially|promotion stages/i.test(message))
  ) {
    return NextResponse.json({ ok: false, error: message }, { status: 409 });
  }
  if (error.code === "22004" || error.code === "22023" || error.code === "23514") {
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
  if (
    /get_monitoring_feedback_promotion_cluster|advance_monitoring_feedback_promotion_cluster|restart_monitoring_feedback_promotion_cluster|monitoring_feedback_promotion_clusters|schema cache|PGRST202|42P01/i.test(
      message,
    )
  ) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "Verified feedback promotion is not migrated for this deployment yet. Immediate event suppression is still active.",
      },
      { status: 503 },
    );
  }
  console.error("Verified monitoring feedback promotion failed", {
    code: error.code,
    message,
  });
  return NextResponse.json(
    { ok: false, error: "The verified promotion workflow could not advance." },
    { status: 500 },
  );
}

function plainStage(stage: MonitoringFeedbackPromotionStage) {
  return stage.replaceAll("_", " ");
}

function cleanText(value: unknown) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function jsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function canonicalPreciseRfc3339(value: string) {
  return preciseRfc3339Instant(value)?.canonical ?? null;
}

function comparePreciseRfc3339(left: string, right: string) {
  const leftInstant = preciseRfc3339Instant(left);
  const rightInstant = preciseRfc3339Instant(right);
  if (!leftInstant || !rightInstant) return null;
  if (leftInstant.epochMicros === rightInstant.epochMicros) return 0;
  return leftInstant.epochMicros < rightInstant.epochMicros ? -1 : 1;
}

function preciseRfc3339Instant(value: string) {
  const match = value.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|([+-])(\d{2}):(\d{2}))$/,
  );
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = Number(match[10] || 0);
  const offsetMinute = Number(match[11] || 0);
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59
  ) {
    return null;
  }

  const localSecond = new Date(0);
  localSecond.setUTCFullYear(year, month - 1, day);
  localSecond.setUTCHours(hour, minute, second, 0);
  if (
    localSecond.getUTCFullYear() !== year ||
    localSecond.getUTCMonth() !== month - 1 ||
    localSecond.getUTCDate() !== day ||
    localSecond.getUTCHours() !== hour ||
    localSecond.getUTCMinutes() !== minute ||
    localSecond.getUTCSeconds() !== second
  ) {
    return null;
  }

  const offsetSign = match[9] === "-" ? -1 : 1;
  const offsetMillis =
    offsetSign * (offsetHour * 60 + offsetMinute) * 60_000;
  const wholeSecondMillis = localSecond.getTime() - offsetMillis;
  const utcSecond = new Date(wholeSecondMillis).toISOString();
  if (!/^\d{4}-\d{2}-\d{2}T/.test(utcSecond)) return null;
  const fraction = (match[7] || "").padEnd(6, "0");
  return {
    canonical: `${utcSecond.slice(0, 19)}.${fraction}Z`,
    epochMicros:
      BigInt(wholeSecondMillis) * BigInt(1_000) + BigInt(fraction || "0"),
  };
}

function canonicalLegitimateNegativeEventIds(eventIds: readonly string[]) {
  return [...eventIds]
    .map((eventId) => eventId.toLocaleLowerCase("en-US"))
    .sort((left, right) => left.localeCompare(right));
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
