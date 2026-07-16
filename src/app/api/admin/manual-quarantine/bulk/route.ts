import { NextResponse } from "next/server";
import { z } from "zod";
import { validateSameOriginAdminMutation } from "@/lib/admin-request-security";
import { getCurrentUser, isSiteAdminEmail } from "@/lib/auth";
import { hasSupabaseAdminConfig, hasSupabaseConfig } from "@/lib/config";
import type { Json } from "@/lib/database.types";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

const caseSchema = z.object({
  id: z.string().uuid(),
  evidenceHash: z.string().regex(/^[0-9a-f]{64}$/),
  status: z.enum(["quarantined", "in_review"]),
  assignedToEmail: z.string().trim().email().max(320).nullable(),
}).strict();

const bulkSchema = z
  .object({
    requestId: z.string().uuid(),
    action: z.enum(["assign_to_me", "unassign", "start_review"]),
    cases: z.array(caseSchema).min(1).max(100),
  })
  .strict()
  .superRefine((value, context) => {
    const ids = value.cases.map((item) => item.id);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: "custom",
        message: "A quarantine case can be selected only once.",
        path: ["cases"],
      });
    }
  });

const bulkResultSchema = z.object({
  accepted: z.literal(true),
  replayed: z.boolean(),
  request_id: z.string().uuid(),
  action: z.enum(["assign_to_me", "unassign", "start_review"]),
  requested: z.number().int().min(1).max(100),
  changed: z.number().int().min(0).max(100),
  creates_api_charge: z.literal(false),
  can_retry: z.literal(false),
  can_resolve: z.literal(false),
});

export async function POST(request: Request) {
  const originError = validateSameOriginAdminMutation(request);
  if (originError) return originError;

  const setup = await validateAdminRequest();
  if (setup.response) return setup.response;

  const parsed = bulkSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: parsed.error.issues[0]?.message || "Invalid bulk action." },
      { status: 400 },
    );
  }

  let result;
  try {
    const admin = createSupabaseAdminClient();
    result = await admin.rpc("apply_manual_quarantine_bulk_action", {
      p_request_id: parsed.data.requestId,
      p_action: parsed.data.action,
      p_actor_user_id: setup.user.id,
      p_actor_email: setup.user.email || "",
      p_cases: parsed.data.cases.map((item) => ({
        id: item.id,
        evidence_hash: item.evidenceHash,
        status: item.status,
        assigned_to_email: item.assignedToEmail?.toLowerCase() || null,
      })) satisfies Json,
    });
  } catch (error) {
    console.error("Manual quarantine bulk action threw", safeErrorDetails(error));
    return NextResponse.json(
      { ok: false, error: "The quarantine bulk action could not be applied." },
      { status: 500 },
    );
  }

  if (result.error) return backlogDatabaseError(result.error);
  const payload = bulkResultSchema.safeParse(result.data);
  if (
    !payload.success ||
    payload.data.request_id !== parsed.data.requestId ||
    payload.data.action !== parsed.data.action ||
    payload.data.requested !== parsed.data.cases.length ||
    payload.data.changed > payload.data.requested
  ) {
    console.error("Manual quarantine bulk action returned an invalid contract", {
      requestId: parsed.data.requestId,
      issue: payload.success ? "identity or count mismatch" : "invalid payload",
    });
    return NextResponse.json(
      { ok: false, error: "The no-charge bulk action returned an unsafe result." },
      { status: 500 },
    );
  }

  return NextResponse.json({
    ok: true,
    action: parsed.data.action,
    requestId: parsed.data.requestId,
    requested: payload.data.requested,
    changed: payload.data.changed,
    replayed: payload.data.replayed,
    createsApiCharge: false,
  });
}

async function validateAdminRequest() {
  if (!hasSupabaseConfig() || !hasSupabaseAdminConfig()) {
    return {
      response: NextResponse.json(
        { ok: false, error: "Admin quarantine actions are not configured." },
        { status: 503 },
      ),
      user: null,
    } as const;
  }

  const user = await getCurrentUser();
  if (!user) {
    return {
      response: NextResponse.json(
        { ok: false, error: "Log in first." },
        { status: 401 },
      ),
      user: null,
    } as const;
  }
  if (!isSiteAdminEmail(user.email)) {
    return {
      response: NextResponse.json(
        { ok: false, error: "Only AwardPing site admins can change quarantine ownership." },
        { status: 403 },
      ),
      user,
    } as const;
  }
  return { response: null, user } as const;
}

function backlogDatabaseError(error: { code?: string; message?: string }) {
  const code = error.code || "";
  const message = error.message || "";
  if (code === "40001" || code === "23505") {
    return NextResponse.json(
      { ok: false, error: "The selected quarantine cases changed. Refresh before retrying." },
      { status: 409 },
    );
  }
  if (code === "22004" || code === "22023" || code === "23514") {
    return NextResponse.json(
      { ok: false, error: "The quarantine bulk action was not valid." },
      { status: 400 },
    );
  }
  if (
    /^(?:PGRST20[25]|42P01|42883)$/.test(code) ||
    /apply_manual_quarantine_bulk_action|schema cache|PGRST20[25]|42P01|42883/i.test(
      message,
    )
  ) {
    return NextResponse.json(
      { ok: false, error: "No-charge quarantine controls are not migrated for this deployment yet." },
      { status: 503 },
    );
  }
  console.error("Manual quarantine bulk action failed", {
    code: error.code,
    message,
  });
  return NextResponse.json(
    { ok: false, error: "The quarantine bulk action could not be applied." },
    { status: 500 },
  );
}

function safeErrorDetails(error: unknown) {
  return error instanceof Error
    ? { name: error.name, message: error.message }
    : { type: typeof error };
}
