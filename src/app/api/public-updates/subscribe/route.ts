import { after, NextResponse } from "next/server";
import { z } from "zod";
import {
  appConfig,
  hasPublicUpdateDeliveryConfig,
  hasSupabaseAdminConfig,
} from "@/lib/config";
import { sendPublicUpdateConfirmationEmail } from "@/lib/email";
import { ensurePublicFormRateLimit } from "@/lib/public-form-rate-limit";
import {
  createOrRefreshPublicUpdateSubscription,
  markPublicUpdateConfirmationSent,
  publicUpdateConfirmationDeliveryIsCurrent,
} from "@/lib/public-updates";

export const runtime = "nodejs";

const subscribeSchema = z.object({
  email: z.string().trim().email(),
  privacyConsent: z.literal(true),
  website: z.string().optional(),
});
const genericSubscriptionMessage =
  "Request received. If confirmation is needed, check your email; links expire after 24 hours, and if nothing arrives you can try again.";

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

  if (!hasPublicUpdateDeliveryConfig()) {
    return NextResponse.json(
      { ok: false, error: "Public-update email delivery is not configured yet." },
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
    if (rateLimit.reason === "rate_limit_unavailable") {
      return NextResponse.json(
        { ok: false, error: "Signup protection is temporarily unavailable." },
        { status: 503 },
      );
    }
    return NextResponse.json(
      { ok: false, error: "Too many signup attempts. Try again later." },
      {
        status: 429,
        headers: rateLimit.retryAfterSeconds
          ? { "Retry-After": String(rateLimit.retryAfterSeconds) }
          : undefined,
      },
    );
  }

  const result = await createOrRefreshPublicUpdateSubscription(parsed.data.email);
  if (
    result.shouldSendConfirmation &&
    result.confirmationToken &&
    result.confirmationAttemptSeal &&
    result.confirmationIdempotencyKey
  ) {
    const confirmUrl = `${appConfig.url}/api/public-updates/confirm?token=${encodeURIComponent(result.confirmationToken)}`;
    after(async () => {
      try {
        const deliveryIsCurrent =
          await publicUpdateConfirmationDeliveryIsCurrent({
            subscriberId: result.subscriberId,
            confirmationToken: result.confirmationToken,
            confirmationAttemptSeal: result.confirmationAttemptSeal,
          });
        if (!deliveryIsCurrent) return;
        const delivery = await sendPublicUpdateConfirmationEmail({
          to: result.email,
          confirmUrl,
          idempotencyKey: result.confirmationIdempotencyKey,
        });
        if (!emailRequestAccepted(delivery)) {
          console.error(
            "Public-update confirmation provider did not accept the request",
          );
          return;
        }
        await markPublicUpdateConfirmationSent({
          subscriberId: result.subscriberId,
          confirmationToken: result.confirmationToken,
          confirmationAttemptSeal: result.confirmationAttemptSeal,
        });
      } catch (error) {
        console.error("Public-update confirmation delivery failed", error);
      }
    });
  }

  return subscriptionRequestResponse();
}

function subscriptionRequestResponse() {
  return NextResponse.json(
    { ok: true, message: genericSubscriptionMessage },
    { status: 202 },
  );
}

function emailRequestAccepted(delivery: unknown) {
  if (!delivery || typeof delivery !== "object") return false;
  const result = delivery as {
    skipped?: unknown;
    error?: unknown;
    data?: { id?: unknown } | null;
  };
  return (
    result.skipped !== true &&
    result.error === null &&
    typeof result.data?.id === "string" &&
    result.data.id.trim().length > 0
  );
}
