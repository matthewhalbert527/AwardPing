import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser, isSiteAdminEmail } from "@/lib/auth";
import { hasSupabaseAdminConfig, hasSupabaseConfig } from "@/lib/config";
import type { SourceIntakeType } from "@/lib/source-intake";
import {
  dedupeIntakeSubmissions,
  normalizeSourceIntakeUrl,
  parseBulkSourceIntakeText,
  sourceIntakeTypes,
} from "@/lib/source-intake";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

const activeStatuses = [
  "pending",
  "queued",
  "validating",
  "capturing",
  "ai_review_pending",
  "ai_review_submitted",
  "ai_review_succeeded",
  "matching",
  "needs_manual_review",
] as const;

const sourceIntakeSchema = z.object({
  url: z.string().trim().optional(),
  urls: z.union([z.string(), z.array(z.string())]).optional(),
  awardName: z.string().trim().max(180).optional(),
  notes: z.string().trim().max(2000).optional(),
  intakeType: z.enum(sourceIntakeTypes).default("unknown"),
  dryRun: z.boolean().optional().default(false),
});

export async function POST(request: Request) {
  const setup = await validateAdminRequest();
  if (setup.response) return setup.response;

  const parsed = sourceIntakeSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: "Paste one or more source URLs to queue for intake." },
      { status: 400 },
    );
  }

  let submissions = [];
  if (parsed.data.url) {
    submissions.push({
      url: parsed.data.url,
      awardName: parsed.data.awardName || null,
      notes: parsed.data.notes || null,
      intakeType: parsed.data.intakeType as SourceIntakeType,
    });
  }
  if (typeof parsed.data.urls === "string") {
    submissions.push(
      ...parseBulkSourceIntakeText(parsed.data.urls, {
        awardName: parsed.data.awardName || null,
        notes: parsed.data.notes || null,
        intakeType: parsed.data.intakeType as SourceIntakeType,
      }),
    );
  } else if (Array.isArray(parsed.data.urls)) {
    submissions.push(
      ...parsed.data.urls.map((url) => ({
        url,
        awardName: parsed.data.awardName || null,
        notes: parsed.data.notes || null,
        intakeType: parsed.data.intakeType as SourceIntakeType,
      })),
    );
  }

  try {
    submissions = dedupeIntakeSubmissions(submissions).slice(0, 200);
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "One URL could not be normalized." },
      { status: 400 },
    );
  }

  if (submissions.length === 0) {
    return NextResponse.json({ ok: false, error: "Paste at least one URL." }, { status: 400 });
  }

  const admin = createSupabaseAdminClient();
  const results = [];
  for (const submission of submissions) {
    const normalizedUrl = normalizeSourceIntakeUrl(submission.url);
    const awardName = submission.awardName || "Unknown award";
    const existing = await findExistingActiveRequest(admin, normalizedUrl, awardName);
    if (existing) {
      results.push({
        ok: true,
        requestId: existing.id,
        status: existing.status,
        normalizedUrl,
        duplicate: true,
      });
      continue;
    }

    const row = {
      user_id: setup.user?.id || null,
      office_id: null,
      award_name: awardName,
      homepage_url: normalizedUrl,
      submitted_url: submission.url,
      normalized_url: normalizedUrl,
      notes: submission.notes || null,
      intake_type: submission.intakeType || "unknown",
      status: "pending" as const,
      status_reason: "queued_from_admin_source_intake",
    };

    if (parsed.data.dryRun) {
      results.push({ ok: true, status: "dry_run", normalizedUrl, duplicate: false });
      continue;
    }

    const { data, error } = await admin
      .from("source_page_requests")
      .insert(row)
      .select("id,status,normalized_url")
      .single();

    if (error) {
      results.push({ ok: false, normalizedUrl, error: error.message });
      continue;
    }

    results.push({
      ok: true,
      requestId: data.id,
      status: data.status,
      normalizedUrl: data.normalized_url || normalizedUrl,
      duplicate: false,
    });
  }

  const failures = results.filter((result) => !result.ok);
  return NextResponse.json(
    {
      ok: failures.length === 0,
      requestId: results.length === 1 && "requestId" in results[0] ? results[0].requestId : null,
      status: results.length === 1 && "status" in results[0] ? results[0].status : "queued",
      results,
    },
    { status: failures.length ? 207 : 200 },
  );
}

async function findExistingActiveRequest(
  admin: ReturnType<typeof createSupabaseAdminClient>,
  normalizedUrl: string,
  awardName: string,
) {
  const { data, error } = await admin
    .from("source_page_requests")
    .select("id,status,normalized_url,award_name")
    .eq("normalized_url", normalizedUrl)
    .ilike("award_name", awardName)
    .in("status", [...activeStatuses])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return data;
}

async function validateAdminRequest() {
  if (!hasSupabaseConfig()) {
    return {
      response: NextResponse.json({ ok: false, error: "Supabase is not configured." }, { status: 503 }),
      user: null,
    };
  }

  if (!hasSupabaseAdminConfig()) {
    return {
      response: NextResponse.json(
        { ok: false, error: "Supabase service-role access is not configured." },
        { status: 503 },
      ),
      user: null,
    };
  }

  const user = await getCurrentUser();
  if (!user) {
    return {
      response: NextResponse.json({ ok: false, error: "Log in first." }, { status: 401 }),
      user: null,
    };
  }

  if (!isSiteAdminEmail(user.email)) {
    return {
      response: NextResponse.json(
        { ok: false, error: "Only AwardPing site admins can queue source intake." },
        { status: 403 },
      ),
      user,
    };
  }

  return { response: null, user };
}
