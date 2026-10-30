import { createHash } from "node:crypto";
import { monitoringPolicyRuleDefinitionForReview } from "@/lib/award-monitoring-policy";
import type { Json } from "@/lib/database.types";

/** Keep draft bytes and their hash independent of the Next route's allowed exports. */
export function buildMonitoringFeedbackRuleDraft(canonicalRuleId: string) {
  const definition = monitoringPolicyRuleDefinitionForReview(canonicalRuleId);
  if (!definition) return null;
  const rule = JSON.parse(JSON.stringify(definition)) as Json;
  const hash = createHash("sha256")
    .update(canonicalJson(rule), "utf8")
    .digest("hex");
  return { hash, rule };
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
