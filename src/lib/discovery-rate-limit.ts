import "server-only";

import crypto from "node:crypto";
import type { User } from "@supabase/supabase-js";
import { appConfig, hasSupabaseAdminConfig } from "@/lib/config";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

const windowMs = 24 * 60 * 60 * 1000;

export type DiscoveryRateLimitResult =
  | { allowed: true }
  | {
      allowed: false;
      reason: string;
      retryAfterSeconds: number;
    };

export async function reserveDiscoveryRequest(input: {
  request: Request;
  user: User;
  query: string;
}): Promise<DiscoveryRateLimitResult> {
  if (!hasSupabaseAdminConfig()) return { allowed: true };

  const supabase = createSupabaseAdminClient();
  const sinceDate = new Date(Date.now() - windowMs);
  const since = sinceDate.toISOString();
  const ipHash = hashIp(getClientIp(input.request));

  const [globalCount, userCount, ipCount] = await Promise.all([
    countDiscoveryRequests(supabase, since),
    countDiscoveryRequests(supabase, since, "user_id", input.user.id),
    countDiscoveryRequests(supabase, since, "ip_hash", ipHash),
  ]);

  const retryAfterSeconds = secondsUntilWindowResets(sinceDate);

  if (globalCount >= appConfig.discoveryDailyGlobalLimit) {
    return {
      allowed: false,
      reason: "Award discovery is at today's beta limit. Try again tomorrow.",
      retryAfterSeconds,
    };
  }

  if (userCount >= appConfig.discoveryDailyUserLimit) {
    return {
      allowed: false,
      reason: "You reached today's award discovery limit. Try again tomorrow.",
      retryAfterSeconds,
    };
  }

  if (ipCount >= appConfig.discoveryDailyIpLimit) {
    return {
      allowed: false,
      reason: "This network reached today's award discovery limit. Try again tomorrow.",
      retryAfterSeconds,
    };
  }

  const { error } = await supabase.from("discovery_requests").insert({
    user_id: input.user.id,
    ip_hash: ipHash,
    query: input.query,
  });

  if (error) {
    throw new Error(`Award discovery rate limit could not be recorded: ${error.message}`);
  }

  return { allowed: true };
}

async function countDiscoveryRequests(
  supabase: ReturnType<typeof createSupabaseAdminClient>,
  since: string,
  column?: "user_id" | "ip_hash",
  value?: string,
) {
  let query = supabase
    .from("discovery_requests")
    .select("id", { count: "exact", head: true })
    .gte("created_at", since);

  if (column && value) {
    query = query.eq(column, value);
  }

  const { count, error } = await query;
  if (error) {
    throw new Error(`Award discovery rate limit could not be checked: ${error.message}`);
  }

  return count || 0;
}

function getClientIp(request: Request) {
  const forwarded = request.headers.get("x-forwarded-for") || "";
  return (
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-real-ip") ||
    forwarded.split(",")[0]?.trim() ||
    "unknown"
  );
}

function hashIp(ip: string) {
  return crypto.createHash("sha256").update(ip).digest("hex");
}

function secondsUntilWindowResets(sinceDate: Date) {
  const resetAt = sinceDate.getTime() + windowMs;
  return Math.max(60, Math.ceil((resetAt - Date.now()) / 1000));
}
