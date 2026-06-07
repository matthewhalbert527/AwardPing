import { planLimits, type PlanName } from "@/lib/plans";
import type { Database } from "@/lib/database.types";

type Subscription = Database["public"]["Tables"]["subscriptions"]["Row"] | null;

export function subscriptionPlan(subscription: Subscription): PlanName {
  if (
    subscription?.plan === "pro" &&
    ["active", "trialing"].includes(subscription.status)
  ) {
    return "pro";
  }

  return "free";
}

export function monitorLimitFor(subscription: Subscription) {
  return planLimits[subscriptionPlan(subscription)].monitors;
}
