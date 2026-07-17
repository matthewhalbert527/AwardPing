import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { hasSupabaseAdminConfig } from "@/lib/config";
import { fetchExtractedContent } from "@/lib/extract";
import {
  hashFreeCheckValue,
  resolveFreeCheckClientIp,
  resolveFreeCheckHourlyLimit,
} from "@/lib/free-check-rate-limit";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

const schema = z.object({
  url: z.string().url(),
});

const reservationSchema = z.object({
  attempt_id: z.string().uuid(),
  allowed: z.boolean(),
  retry_after_seconds: z.number().int().min(1).max(3600),
  effective_limit: z.number().int().min(1).max(10),
  window_started_at: z.string(),
});

type AdminClient = ReturnType<typeof createSupabaseAdminClient>;
type AttemptOutcome = "succeeded" | "failed";

export async function POST(request: NextRequest) {
  if (!hasSupabaseAdminConfig()) {
    return checkerUnavailable();
  }

  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: "Enter a valid public URL." },
      { status: 400 },
    );
  }

  const requestedUrl = new URL(parsed.data.url);
  const requestedHost = requestedUrl.hostname.toLowerCase() || "unknown";
  const ipHash = hashFreeCheckValue(resolveFreeCheckClientIp(request.headers));
  const urlHash = hashFreeCheckValue(requestedUrl.href);
  let admin: AdminClient;
  try {
    admin = createSupabaseAdminClient();
  } catch {
    return checkerUnavailable();
  }
  const reservation = await reserveAttempt(admin, {
    ipHash,
    urlHash,
    requestedHost,
  });

  if (!reservation) {
    return checkerUnavailable();
  }

  if (!reservation.allowed) {
    return NextResponse.json(
      { ok: false, error: "Too many checks. Try again later." },
      {
        status: 429,
        headers: {
          "Retry-After": String(reservation.retry_after_seconds),
        },
      },
    );
  }

  try {
    // This is intentionally after the durable database reservation. The fetch
    // helper independently validates every DNS result and redirect for SSRF.
    const content = await fetchExtractedContent(parsed.data.url);
    const recorded = await recordAttemptOutcome(
      admin,
      reservation.attempt_id,
      "succeeded",
    );
    if (!recorded) return checkerUnavailable();

    return NextResponse.json({
      ok: true,
      hash: content.hash,
      sample: content.sample,
      contentType: content.contentType,
      byteLength: content.byteLength,
    });
  } catch (error) {
    const recorded = await recordAttemptOutcome(
      admin,
      reservation.attempt_id,
      "failed",
      "fetch_failed",
    );
    if (!recorded) return checkerUnavailable();

    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "The URL could not be checked.",
      },
      { status: 400 },
    );
  }
}

async function reserveAttempt(
  admin: AdminClient,
  input: { ipHash: string; urlHash: string; requestedHost: string },
) {
  try {
    const { data, error } = await admin.rpc("reserve_free_check_attempt", {
      p_ip_hash: input.ipHash,
      p_url_hash: input.urlHash,
      p_requested_host: input.requestedHost,
      p_limit: resolveFreeCheckHourlyLimit(
        process.env.FREE_CHECK_HOURLY_IP_LIMIT,
      ),
    });
    if (error || !Array.isArray(data) || data.length !== 1) return null;

    const parsed = reservationSchema.safeParse(data[0]);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

async function recordAttemptOutcome(
  admin: AdminClient,
  attemptId: string,
  outcome: AttemptOutcome,
  failureKind: string | null = null,
) {
  try {
    const { data, error } = await admin.rpc("complete_free_check_attempt", {
      p_attempt_id: attemptId,
      p_outcome: outcome,
      p_failure_kind: failureKind,
    });
    return !error && data === true;
  } catch {
    return false;
  }
}

function checkerUnavailable() {
  return NextResponse.json(
    { ok: false, error: "The checker is temporarily unavailable." },
    { status: 503 },
  );
}
