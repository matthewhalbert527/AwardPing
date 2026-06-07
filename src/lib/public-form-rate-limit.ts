import "server-only";

import crypto from "node:crypto";
import type { PublicFormRateLimitKind } from "@/lib/database.types";
import { hasSupabaseAdminConfig } from "@/lib/config";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

type RateLimitInput = {
  request: Request;
  kind: PublicFormRateLimitKind;
  limit: number;
  windowMs: number;
};

export async function ensurePublicFormRateLimit(input: RateLimitInput) {
  if (!hasSupabaseAdminConfig()) {
    return { allowed: true, ipHash: null };
  }

  const ipHash = requestIpHash(input.request);
  const since = new Date(Date.now() - input.windowMs).toISOString();
  const supabase = createSupabaseAdminClient();

  const { count, error } = await supabase
    .from("public_form_rate_limits")
    .select("id", { count: "exact", head: true })
    .eq("kind", input.kind)
    .eq("ip_hash", ipHash)
    .gte("created_at", since);

  if (error) {
    throw error;
  }

  if ((count || 0) >= input.limit) {
    return { allowed: false, ipHash };
  }

  const { error: insertError } = await supabase.from("public_form_rate_limits").insert({
    kind: input.kind,
    ip_hash: ipHash,
  });

  if (insertError) {
    throw insertError;
  }

  return { allowed: true, ipHash };
}

function requestIpHash(request: Request) {
  const forwarded = request.headers.get("x-forwarded-for") || "";
  const ip =
    forwarded.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown";

  return crypto.createHash("sha256").update(ip).digest("hex");
}
