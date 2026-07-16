import "server-only";
import {
  awardMonitoringPolicyIdentity,
  changeEventSuppressionPolicyIdentity,
  monitoringPromotionMatcherIdentity,
  visualReviewBatchPolicyIdentity,
} from "@/lib/award-monitoring-policy";

export function currentMonitoringPromotionAppIdentity() {
  return {
    revision:
      cleanText(
        process.env.VERCEL_GIT_COMMIT_SHA ||
          process.env.AWARDPING_APP_REVISION ||
          process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA,
      ) || "unavailable",
    policy_identity: awardMonitoringPolicyIdentity.id,
    policy_version: awardMonitoringPolicyIdentity.version,
    policy_hash: awardMonitoringPolicyIdentity.hash,
    batch_policy_identity: visualReviewBatchPolicyIdentity.id,
    batch_policy_version: visualReviewBatchPolicyIdentity.version,
    batch_policy_hash: visualReviewBatchPolicyIdentity.hash,
    suppression_policy_identity: changeEventSuppressionPolicyIdentity.id,
    suppression_policy_version: changeEventSuppressionPolicyIdentity.version,
    suppression_policy_hash: changeEventSuppressionPolicyIdentity.hash,
    matcher_identity: monitoringPromotionMatcherIdentity.id,
    matcher_version: monitoringPromotionMatcherIdentity.version,
    matcher_hash: monitoringPromotionMatcherIdentity.hash,
  };
}

function cleanText(value: string | undefined) {
  return String(value || "").replace(/\s+/g, " ").trim();
}
