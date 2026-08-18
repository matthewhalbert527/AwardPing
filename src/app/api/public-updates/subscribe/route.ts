import { after, NextResponse } from "next/server";
import { z } from "zod";
import {
  hasPublicUpdateDeliveryConfig,
  hasSupabaseAdminConfig,
} from "@/lib/config";
import { ensurePublicFormRateLimit } from "@/lib/public-form-rate-limit";
import {
  createOrRefreshPublicUpdateSubscription,
  drainPublicUpdateConfirmationOutbox,
} from "@/lib/public-updates";

export const runtime = "nodejs";

const subscribeSchema = z.object({
  email: z.string().trim().email(),
  privacyConsent: z.literal(true),
  website: z.string().optional(),
});
const genericSubscriptionMessage =
  "Request received. If confirmation is needed, check your email; links expire after 24 hours, and if nothing arrives you can try again.";
const nonEnumeratingResponseFloorMs = 250;

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

  const responseFloor = new Promise<void>((resolve) =>
    setTimeout(resolve, nonEnumeratingResponseFloorMs),
  );
  let outboxId: string | null = null;
  try {
    const result = await createOrRefreshPublicUpdateSubscription(
      parsed.data.email,
    );
    outboxId = result.outboxId;
  } catch (error) {
    // Keep valid-address responses independent of subscriber existence and
    // persistence outcome. The caller can safely retry the idempotent request.
    console.error("Public-update confirmation enqueue failed", error);
  }

  after(async () => {
    try {
      await drainPublicUpdateConfirmationOutbox({ outboxId });
    } catch (error) {
      console.error("Public-update confirmation outbox drain failed", error);
    }
  });
  await responseFloor;

  return subscriptionRequestResponse();
}

function subscriptionRequestResponse() {
  return NextResponse.json(
    { ok: true, message: genericSubscriptionMessage },
    { status: 202 },
  );
}
