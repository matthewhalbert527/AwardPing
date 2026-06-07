import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser, getUserProfile } from "@/lib/auth";
import { appConfig, hasSupabaseAdminConfig, hasSupabaseConfig } from "@/lib/config";
import { sendContactFormEmail } from "@/lib/email";
import { requireOfficeContext } from "@/lib/offices";
import { ensurePublicFormRateLimit } from "@/lib/public-form-rate-limit";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { assertPublicHttpUrl } from "@/lib/url-safety";

export const runtime = "nodejs";

const sourceRequestSchema = z.object({
  awardName: z.string().trim().min(2).max(160),
  homepageUrl: z.string().trim().url(),
  notes: z.string().trim().max(1200).optional(),
  website: z.string().optional(),
});

export async function POST(request: Request) {
  if (!hasSupabaseConfig() || !hasSupabaseAdminConfig()) {
    return NextResponse.json({ ok: false, error: "Source requests are not configured yet." }, { status: 503 });
  }

  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: "Log in first." }, { status: 401 });
  }

  const parsed = sourceRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: "Enter an award name and the official main award page." },
      { status: 400 },
    );
  }

  if (parsed.data.website?.trim()) {
    return NextResponse.json({ ok: true });
  }

  let safeUrl: URL;
  try {
    safeUrl = await assertPublicHttpUrl(parsed.data.homepageUrl);
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Award page URL is not monitorable." },
      { status: 400 },
    );
  }

  const rateLimit = await ensurePublicFormRateLimit({
    request,
    kind: "source_request",
    limit: 10,
    windowMs: 60 * 60 * 1000,
  });

  if (!rateLimit.allowed) {
    return NextResponse.json(
      { ok: false, error: "Too many source requests. Try again later." },
      { status: 429 },
    );
  }

  const [officeContext, profile] = await Promise.all([
    requireOfficeContext(user),
    getUserProfile(user.id),
  ]);
  const supabase = createSupabaseAdminClient();
  const awardName = parsed.data.awardName;
  const homepageUrl = safeUrl.toString();
  const notes = parsed.data.notes || null;

  const { data, error } = await supabase
    .from("source_page_requests")
    .insert({
      user_id: user.id,
      office_id: officeContext.current.officeId,
      award_name: awardName,
      homepage_url: homepageUrl,
      notes,
    })
    .select("id")
    .single();

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  if (appConfig.contactToEmail) {
    await sendContactFormEmail({
      to: appConfig.contactToEmail,
      name: profile?.full_name || user.email || "AwardPing user",
      email: user.email || "alerts@example.com",
      message: [
        "Source page request",
        "",
        `Award: ${awardName}`,
        `Official main page: ${homepageUrl}`,
        `Office: ${officeContext.current.officeName}`,
        `Requested by: ${profile?.full_name || user.email || user.id}`,
        data?.id ? `Request id: ${data.id}` : "",
        "",
        notes ? `Notes:\n${notes}` : "Notes: none",
      ].filter(Boolean).join("\n"),
    });
  }

  return NextResponse.json({
    ok: true,
    message: "Request queued. AwardPing will use this official main page as a starting point for the next source-discovery scrape.",
  });
}
