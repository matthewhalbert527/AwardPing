import { NextResponse } from "next/server";
import {
  candidateMonitoringPolicyFlagIds,
} from "@/lib/award-monitoring-policy";
import { currentMonitoringPromotionAppIdentity } from "@/lib/monitoring-feedback-promotion-identity";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET() {
  return NextResponse.json(
    {
      schemaVersion: "monitoring-promotion-app-identity-v1",
      ...currentMonitoringPromotionAppIdentity(),
      candidateRuleIds: candidateMonitoringPolicyFlagIds,
    },
    {
      headers: {
        "cache-control": "no-store, max-age=0",
      },
    },
  );
}
