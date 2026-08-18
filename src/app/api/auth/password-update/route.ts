import { NextResponse } from "next/server";
import { z } from "zod";
import { hasSupabaseConfig } from "@/lib/config";
import { isSameOriginMutationRequest } from "@/lib/same-origin-mutation";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

const passwordUpdateSchema = z
  .object({
    password: z.string().min(12).max(128),
    confirmation: z.string().min(12).max(128),
  })
  .strict()
  .refine((value) => value.password === value.confirmation, {
    message: "Passwords must match.",
    path: ["confirmation"],
  });

export async function POST(request: Request) {
  if (!isSameOriginMutationRequest(request)) {
    return errorResponse("Invalid request origin.", 403);
  }

  const contentLength = Number(request.headers.get("content-length") || "0");
  if (Number.isFinite(contentLength) && contentLength > 8_192) {
    return errorResponse("Enter two matching passwords of at least 12 characters.", 400);
  }

  const parsed = passwordUpdateSchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!parsed.success) {
    return errorResponse("Enter two matching passwords of at least 12 characters.", 400);
  }

  if (!hasSupabaseConfig()) {
    return errorResponse("Password recovery is temporarily unavailable.", 503);
  }

  try {
    const supabase = await createSupabaseServerClient();
    const {
      data: { user },
      error: userError,
    } = await supabase.auth.getUser();
    if (userError || !user) {
      return errorResponse(
        "This password-reset session is invalid or expired. Request a new link.",
        401,
      );
    }

    const { error } = await supabase.auth.updateUser({
      password: parsed.data.password,
    });
    if (error) {
      reportUpdateFailure(error);
      return errorResponse(
        "The password could not be updated. Request a new reset link and try again.",
        400,
      );
    }
  } catch (error) {
    reportUpdateFailure(error);
    return errorResponse("Password recovery is temporarily unavailable.", 503);
  }

  return NextResponse.json(
    { ok: true },
    { headers: { "Cache-Control": "no-store" } },
  );
}

function errorResponse(error: string, status: number) {
  return NextResponse.json(
    { ok: false, error },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

function reportUpdateFailure(error: unknown) {
  const detail =
    error && typeof error === "object"
      ? {
          code: "code" in error ? String(error.code) : undefined,
          message: "message" in error ? String(error.message) : undefined,
        }
      : undefined;
  console.error("[password-recovery] password update failed", detail);
}
