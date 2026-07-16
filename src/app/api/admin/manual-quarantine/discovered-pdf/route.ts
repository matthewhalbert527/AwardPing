import { NextResponse } from "next/server";
import { z } from "zod";
import { validateSameOriginAdminMutation } from "@/lib/admin-request-security";
import { getCurrentUser, isSiteAdminEmail } from "@/lib/auth";
import { hasSupabaseAdminConfig, hasSupabaseConfig } from "@/lib/config";
import type { Json } from "@/lib/database.types";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

const requestSchema = z.object({
  action: z.literal("approve_new_live_review"),
  caseId: z.string().uuid(),
  evidenceHash: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();

const resolutionSchema = z.array(z.object({
  bound_source_page_request_id: z.string().uuid(),
  created: z.literal(true),
  resolved: z.literal(true),
}).strict()).length(1);

export async function POST(request: Request) {
  const originError = validateSameOriginAdminMutation(request);
  if (originError) return originError;

  const setup = await validateAdminRequest();
  if (setup.response) return setup.response;

  const parsed = requestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: "Choose a valid discovered-PDF resolution." },
      { status: 400 },
    );
  }

  const admin = createSupabaseAdminClient();
  const { data: quarantine, error: quarantineError } = await admin
    .from("manual_quarantine_registry")
    .select("id,quarantine_key,category,status,evidence,evidence_hash,shared_award_source_id")
    .eq("id", parsed.data.caseId)
    .eq("evidence_hash", parsed.data.evidenceHash)
    .maybeSingle();
  if (quarantineError) return databaseError(quarantineError);
  if (!quarantine) {
    return NextResponse.json(
      { ok: false, error: "This quarantine case changed. Refresh before resolving it." },
      { status: 409 },
    );
  }

  if (
    quarantine.category !== "initial_document" ||
    quarantine.status !== "in_review" ||
    !quarantine.quarantine_key.startsWith("discovered-pdf-notification:")
  ) {
    return NextResponse.json(
      { ok: false, error: "This action is only available for an in-review discovered-PDF provenance conflict." },
      { status: 409 },
    );
  }

  const { data: assignment, error: assignmentError } = await admin
    .from("manual_quarantine_operator_assignments")
    .select("assigned_to_user_id,assigned_to_email")
    .eq("quarantine_id", quarantine.id)
    .maybeSingle();
  if (assignmentError) return databaseError(assignmentError);
  if (
    !assignment ||
    assignment.assigned_to_user_id !== setup.user.id ||
    assignment.assigned_to_email.trim().toLowerCase() !== (setup.user.email || "").trim().toLowerCase()
  ) {
    return NextResponse.json(
      { ok: false, error: "Assign this case to yourself and start review before approving a paid review." },
      { status: 409 },
    );
  }

  const evidence = objectValue(quarantine.evidence);
  const discoveredLink = objectValue(evidence.discovered_link);
  const parentSourceId = nullableText(discoveredLink.parent_shared_award_source_id);
  const normalizedUrl = normalizedHttpUrl(discoveredLink.normalized_url);
  if (
    !parentSourceId ||
    parentSourceId !== quarantine.shared_award_source_id ||
    !normalizedUrl
  ) {
    return NextResponse.json(
      { ok: false, error: "The preserved discovery evidence is incomplete. Keep this case quarantined and repair its provenance first." },
      { status: 409 },
    );
  }

  let result;
  try {
    result = await admin.rpc("resolve_shared_award_discovered_link_quarantine", {
      p_parent_source_id: parentSourceId,
      p_normalized_url: normalizedUrl,
      p_action: parsed.data.action,
      p_actor: setup.user.email || setup.user.id,
      p_actor_user_id: setup.user.id,
      p_expected_evidence_hash: parsed.data.evidenceHash,
      p_source_page_request_id: null,
    });
  } catch (error) {
    console.error("Discovered-PDF quarantine resolution threw", safeErrorDetails(error));
    return NextResponse.json(
      { ok: false, error: "The discovered-PDF quarantine could not be resolved." },
      { status: 500 },
    );
  }

  if (result.error) return databaseError(result.error);
  const receipt = resolutionSchema.safeParse(result.data);
  if (!receipt.success) {
    console.error("Discovered-PDF quarantine resolution returned an invalid contract", {
      caseId: parsed.data.caseId,
    });
    return NextResponse.json(
      { ok: false, error: "The resolution returned an unsafe receipt. Refresh before taking another action." },
      { status: 500 },
    );
  }

  return NextResponse.json({
    ok: true,
    action: parsed.data.action,
    requestId: receipt.data[0].bound_source_page_request_id,
    createsApiChargeNow: false,
    reviewMayCharge: true,
    message: "One new live PDF review was queued. It may use the New Page Review budget; no API charge was created by this button itself.",
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
      response: NextResponse.json({ ok: false, error: "Log in first." }, { status: 401 }),
      user: null,
    } as const;
  }
  if (!isSiteAdminEmail(user.email)) {
    return {
      response: NextResponse.json(
        { ok: false, error: "Only AwardPing site admins can resolve quarantine cases." },
        { status: 403 },
      ),
      user,
    } as const;
  }
  return { response: null, user } as const;
}

function objectValue(value: Json | undefined): Record<string, Json | undefined> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, Json | undefined>;
}

function nullableText(value: Json | undefined) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizedHttpUrl(value: Json | undefined) {
  const text = nullableText(value);
  if (!text) return null;
  try {
    const url = new URL(text);
    return url.protocol === "http:" || url.protocol === "https:" ? text : null;
  } catch {
    return null;
  }
}

function databaseError(error: { code?: string; message?: string }) {
  const code = error.code || "";
  const message = error.message || "";
  if (["40001", "23503", "23505", "23514"].includes(code)) {
    return NextResponse.json(
      { ok: false, error: "This quarantine case or its discovery evidence changed. Refresh before retrying." },
      { status: 409 },
    );
  }
  if (
    /^(?:PGRST20[25]|42P01|42883)$/.test(code) ||
    /resolve_shared_award_discovered_link_quarantine|schema cache|PGRST20[25]|42P01|42883/i.test(message)
  ) {
    return NextResponse.json(
      { ok: false, error: "Discovered-PDF quarantine resolution is not migrated for this deployment yet." },
      { status: 503 },
    );
  }
  console.error("Discovered-PDF quarantine resolution failed", { code, message });
  return NextResponse.json(
    { ok: false, error: "The discovered-PDF quarantine could not be resolved." },
    { status: 500 },
  );
}

function safeErrorDetails(error: unknown) {
  return error instanceof Error
    ? { name: error.name, message: error.message }
    : { type: typeof error };
}
