import { NextResponse } from "next/server";
import { z } from "zod";
import { appConfig, hasSupabaseAdminConfig } from "@/lib/config";
import { sendPublicUpdateConfirmationEmail } from "@/lib/email";
import { ensurePublicFormRateLimit } from "@/lib/public-form-rate-limit";
import { createOrRefreshPublicUpdateSubscription } from "@/lib/public-updates";

export const runtime = "nodejs";

const subscribeSchema = z.object({
  email: z.string().trim().email(),
  privacyConsent: z.literal(true),
  website: z.string().optional(),
});

export async function POST(request: Request) {
  const parsed = subscribeSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: "Enter a valid email address and accept the privacy terms." },
      { status: 400 },
    );
  }

  if (parsed.data.website?.trim()) {
    return NextResponse.json({ ok: true });
  }

  if (!hasSupabaseAdminConfig()) {
    return NextResponse.json(
      { ok: false, error: "Public updates are not configured yet." },
      { status: 503 },
    );
  }

  const rateLimit = await ensurePublicFormRateLimit({
    request,
    kind: "subscribe",
    limit: 5,
    windowMs: 60 * 60 * 1000,
  });

  if (!rateLimit.allowed) {
    return NextResponse.json(
      { ok: false, error: "Too many signup attempts. Try again later." },
      { status: 429 },
    );
  }

  const result = await createOrRefreshPublicUpdateSubscription(parsed.data.email);
  if (result.shouldSendConfirmation && result.confirmationToken) {
    const confirmUrl = `${appConfig.url}/api/public-updates/confirm?token=${encodeURIComponent(result.confirmationToken)}`;
    await sendPublicUpdateConfirmationEmail({
      to: result.email,
      confirmUrl,
    });
  }

  return NextResponse.json({
    ok: true,
    message: "Check your email to confirm daily AwardPing updates.",
  });
}
