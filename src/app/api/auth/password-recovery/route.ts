import { NextResponse } from "next/server";
import { z } from "zod";
import { appConfig, hasSupabaseConfig } from "@/lib/config";
import { ensurePublicFormRateLimit } from "@/lib/public-form-rate-limit";
import { isSameOriginMutationRequest } from "@/lib/same-origin-mutation";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

const genericSuccessMessage =
  "If an invited AwardPing account uses that email, a password-reset link will arrive shortly.";

const recoveryRequestSchema = z
  .object({
    email: z.string().trim().email().max(240),
  })
  .strict();

export async function POST(request: Request) {
  if (!isSameOriginMutationRequest(request)) {
    return jsonResponse(
      { ok: false, error: "Invalid request origin." },
      403,
    );
  }

  const contentLength = Number(request.headers.get("content-length") || "0");
  if (Number.isFinite(contentLength) && contentLength > 8_192) {
    return jsonResponse(
      { ok: false, error: "Enter a valid email address." },
      400,
    );
  }

  const parsed = recoveryRequestSchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!parsed.success) {
    return jsonResponse(
      { ok: false, error: "Enter a valid email address." },
      400,
    );
  }

  if (!hasSupabaseConfig()) {
    return jsonResponse(
      {
        ok: false,
        error: "Password recovery is temporarily unavailable.",
      },
      503,
    );
  }

  let rateLimit: Awaited<ReturnType<typeof ensurePublicFormRateLimit>>;
  try {
    rateLimit = await ensurePublicFormRateLimit({
      request,
      kind: "password_recovery",
      limit: 10,
      windowMs: 60 * 60 * 1_000,
    });
  } catch (error) {
    reportRecoveryFailure(error);
    return jsonResponse(
      {
        ok: false,
        error: "Password recovery is temporarily unavailable.",
      },
      503,
    );
  }

  if (!rateLimit.allowed) {
    if (rateLimit.reason === "rate_limit_unavailable") {
      return jsonResponse(
        {
          ok: false,
          error: "Password recovery is temporarily unavailable.",
        },
        503,
      );
    }
    return NextResponse.json(
      {
        ok: false,
        error: "Too many password-reset requests. Try again later.",
      },
      {
        status: 429,
        headers: {
          "Cache-Control": "no-store",
          ...(rateLimit.retryAfterSeconds
            ? { "Retry-After": String(rateLimit.retryAfterSeconds) }
            : {}),
        },
      },
    );
  }

  try {
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.auth.resetPasswordForEmail(
      parsed.data.email.toLowerCase(),
      {
        redirectTo: recoveryConfirmationUrl(),
      },
    );
    if (error) reportRecoveryFailure(error);
  } catch (error) {
    reportRecoveryFailure(error);
  }

  // Existing, missing, and provider-rejected accounts deliberately receive the
  // same public response so this endpoint cannot be used to enumerate users.
  return jsonResponse(
    { ok: true, message: genericSuccessMessage },
    202,
  );
}

function recoveryConfirmationUrl() {
  // Keep the provider redirect exact so the production allow-list does not
  // need a query wildcard. The hosted recovery template appends the token and
  // the fixed, server-validated reset destination.
  return new URL("/auth/confirm", appConfig.url).toString();
}

function jsonResponse(body: unknown, status: number) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function reportRecoveryFailure(error: unknown) {
  const detail =
    error && typeof error === "object"
      ? {
          code: "code" in error ? String(error.code) : undefined,
          message: "message" in error ? String(error.message) : undefined,
        }
      : undefined;
  console.error("[password-recovery] request failed", detail);
}
