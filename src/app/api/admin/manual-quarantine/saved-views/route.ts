import { NextResponse } from "next/server";
import { z } from "zod";
import { validateSameOriginAdminMutation } from "@/lib/admin-request-security";
import { getCurrentUser, isSiteAdminEmail } from "@/lib/auth";
import { hasSupabaseAdminConfig, hasSupabaseConfig } from "@/lib/config";
import type { Json } from "@/lib/database.types";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

const groupBySchema = z.enum([
  "repair_group",
  "domain",
  "evidence_failure",
  "policy_reason",
  "likely_repair",
]);
const sortSchema = z.enum(["oldest", "newest", "priority", "domain"]);
const filterValue = z.string().trim().min(1).max(180);
const filtersSchema = z
  .object({
    domains: z.array(filterValue).max(20),
    evidenceFailures: z.array(filterValue).max(20),
    policyReasons: z.array(filterValue).max(20),
    repairs: z.array(filterValue).max(20),
    owners: z.array(filterValue).max(20),
    statuses: z.array(z.enum(["quarantined", "in_review"])).max(2),
    ageBucket: z
      .enum([
        "under_24h",
        "one_to_three_days",
        "four_to_seven_days",
        "eight_to_thirty_days",
        "over_thirty_days",
      ])
      .nullable(),
    search: z.string().trim().max(160),
  })
  .strict();
const saveSchema = z
  .object({
    viewId: z.string().uuid().nullable().optional(),
    name: z.string().trim().min(1).max(80),
    filters: filtersSchema,
    groupBy: groupBySchema,
    sort: sortSchema,
    pageSize: z.union([z.literal(10), z.literal(25), z.literal(50), z.literal(100)]),
  })
  .strict();
const deleteSchema = z.object({ viewId: z.string().uuid() }).strict();
const timestampSchema = z
  .string()
  .trim()
  .min(1)
  .refine((value) => Number.isFinite(Date.parse(value)));
const savedViewResultSchema = z
  .array(
    z.object({
      saved_view_id: z.string().uuid(),
      saved_view_name: z.string().trim().min(1).max(80),
      saved_updated_at: timestampSchema,
    }),
  )
  .length(1);

export async function POST(request: Request) {
  const originError = validateSameOriginAdminMutation(request);
  if (originError) return originError;

  const setup = await validateAdminRequest();
  if (setup.response) return setup.response;
  const parsed = saveSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: parsed.error.issues[0]?.message || "Invalid saved view." },
      { status: 400 },
    );
  }

  const filters = {
    domains: parsed.data.filters.domains,
    evidence_failures: parsed.data.filters.evidenceFailures,
    policy_reasons: parsed.data.filters.policyReasons,
    repairs: parsed.data.filters.repairs,
    owners: parsed.data.filters.owners,
    statuses: parsed.data.filters.statuses,
    age_bucket: parsed.data.filters.ageBucket,
    search: parsed.data.filters.search,
  } satisfies Json;
  let result;
  try {
    const admin = createSupabaseAdminClient();
    result = await admin.rpc("save_manual_quarantine_saved_view", {
      p_user_id: setup.user.id,
      p_user_email: setup.user.email || "",
      p_name: parsed.data.name,
      p_filters: filters,
      p_group_by: parsed.data.groupBy,
      p_sort: parsed.data.sort,
      p_page_size: parsed.data.pageSize,
      p_view_id: parsed.data.viewId || null,
    });
  } catch (error) {
    return unexpectedSavedViewError(error);
  }

  if (result.error) return savedViewDatabaseError(result.error);
  const saved = savedViewResultSchema.safeParse(result.data);
  if (
    !saved.success ||
    saved.data[0].saved_view_name !== parsed.data.name ||
    (parsed.data.viewId && saved.data[0].saved_view_id !== parsed.data.viewId)
  ) {
    console.error("Manual quarantine saved view returned an invalid contract", {
      issue: saved.success ? "identity mismatch" : "invalid payload",
    });
    return NextResponse.json(
      { ok: false, error: "The saved view returned no durable result." },
      { status: 500 },
    );
  }
  const view = saved.data[0];
  return NextResponse.json({
    ok: true,
    view: {
      id: view.saved_view_id,
      name: view.saved_view_name,
      updatedAt: view.saved_updated_at,
    },
  });
}

export async function DELETE(request: Request) {
  const originError = validateSameOriginAdminMutation(request);
  if (originError) return originError;

  const setup = await validateAdminRequest();
  if (setup.response) return setup.response;
  const parsed = deleteSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: "Choose a valid saved backlog view." },
      { status: 400 },
    );
  }

  let result;
  try {
    const admin = createSupabaseAdminClient();
    result = await admin.rpc("delete_manual_quarantine_saved_view", {
      p_view_id: parsed.data.viewId,
      p_user_id: setup.user.id,
    });
  } catch (error) {
    return unexpectedSavedViewError(error);
  }
  if (result.error) return savedViewDatabaseError(result.error);
  const deleted = z.boolean().safeParse(result.data);
  if (!deleted.success) {
    console.error("Manual quarantine saved view delete returned an invalid contract");
    return NextResponse.json(
      { ok: false, error: "The saved backlog view could not be changed." },
      { status: 500 },
    );
  }
  if (!deleted.data) {
    return NextResponse.json(
      { ok: false, error: "That saved backlog view no longer exists." },
      { status: 404 },
    );
  }
  return NextResponse.json({ ok: true });
}

async function validateAdminRequest() {
  if (!hasSupabaseConfig() || !hasSupabaseAdminConfig()) {
    return {
      response: NextResponse.json(
        { ok: false, error: "Saved quarantine views are not configured." },
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
        { ok: false, error: "Only AwardPing site admins can save quarantine views." },
        { status: 403 },
      ),
      user,
    } as const;
  }
  return { response: null, user } as const;
}

function savedViewDatabaseError(error: { code?: string; message?: string }) {
  const code = error.code || "";
  const message = error.message || "";
  if (code === "P0002") {
    return NextResponse.json(
      { ok: false, error: "That saved backlog view no longer exists." },
      { status: 404 },
    );
  }
  if (code === "23505" || code === "40001") {
    return NextResponse.json(
      { ok: false, error: "That saved view changed or its name is already in use." },
      { status: 409 },
    );
  }
  if (code === "22004" || code === "22023" || code === "23514") {
    return NextResponse.json(
      { ok: false, error: "The saved backlog view was not valid." },
      { status: 400 },
    );
  }
  if (
    /^(?:PGRST20[25]|42P01|42883)$/.test(code) ||
    /manual_quarantine_saved_view|schema cache|PGRST20[25]|42P01|42883/i.test(
      message,
    )
  ) {
    return NextResponse.json(
      { ok: false, error: "Saved quarantine views are not migrated for this deployment yet." },
      { status: 503 },
    );
  }
  console.error("Manual quarantine saved view failed", {
    code: error.code,
    message,
  });
  return NextResponse.json(
    { ok: false, error: "The saved backlog view could not be changed." },
    { status: 500 },
  );
}

function unexpectedSavedViewError(error: unknown) {
  console.error(
    "Manual quarantine saved view threw",
    error instanceof Error
      ? { name: error.name, message: error.message }
      : { type: typeof error },
  );
  return NextResponse.json(
    { ok: false, error: "The saved backlog view could not be changed." },
    { status: 500 },
  );
}
