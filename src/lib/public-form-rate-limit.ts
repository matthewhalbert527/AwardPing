import "server-only";

import type { PublicFormRateLimitKind } from "@/lib/database.types";
import { hasSupabaseAdminConfig } from "@/lib/config";
import {
  hashFreeCheckValue,
  resolveFreeCheckClientIp,
} from "@/lib/free-check-rate-limit";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

type RateLimitInput = {
  request: Request;
  kind: PublicFormRateLimitKind;
  limit: number;
  windowMs: number;
};

export async function ensurePublicFormRateLimit(input: RateLimitInput) {
  if (!hasSupabaseAdminConfig()) {
    return {
      allowed: false,
      ipHash: null,
      reason: "rate_limit_unavailable" as const,
      retryAfterSeconds: 0,
    };
  }

  const ipHash = requestIpHash(input.request);
  const supabase = createSupabaseAdminClient();
  const windowSeconds = Math.ceil(input.windowMs / 1000);
  const { data, error } = await supabase.rpc("reserve_public_form_rate_limit", {
    p_kind: input.kind,
    p_ip_hash: ipHash,
    p_limit: input.limit,
    p_window_seconds: windowSeconds,
  });

  if (error) {
    throw error;
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Public form rate-limit reservation returned an invalid result.");
  }
  const result = data as Record<string, unknown>;
  const allowed = result.allowed === true;
  return {
    allowed,
    ipHash,
    reason: allowed ? null : "limit_exceeded" as const,
    retryAfterSeconds: nonNegativeInteger(result.retry_after_seconds),
  };
}

function nonNegativeInteger(value: unknown) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

function requestIpHash(request: Request) {
  return hashFreeCheckValue(resolveFreeCheckClientIp(request.headers));
}
