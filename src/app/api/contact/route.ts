import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { appConfig, hasEmailDeliveryConfig } from "@/lib/config";
import { sendContactFormEmail } from "@/lib/email";
import { ensurePublicFormRateLimit } from "@/lib/public-form-rate-limit";

export const runtime = "nodejs";

const contactSchema = z.object({
  requestId: z.string().trim().uuid(),
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().email().max(240),
  message: z.string().trim().min(10).max(5000),
  website: z.string().optional(),
});

export async function POST(request: Request) {
  const parsed = contactSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: "Enter your name, email, and a message." },
      { status: 400 },
    );
  }

  if (parsed.data.website?.trim()) {
    return NextResponse.json({ ok: true });
  }

  if (!appConfig.contactToEmail) {
    return NextResponse.json(
      { ok: false, error: "The contact form is not configured yet." },
      { status: 503 },
    );
  }

  if (!hasEmailDeliveryConfig()) {
    return NextResponse.json(
      { ok: false, error: "Email delivery is not configured yet." },
      { status: 503 },
    );
  }

  const rateLimit = await ensurePublicFormRateLimit({
    request,
    kind: "contact",
    limit: 5,
    windowMs: 60 * 60 * 1000,
  });

  if (!rateLimit.allowed) {
    if (rateLimit.reason === "rate_limit_unavailable") {
      return NextResponse.json(
        { ok: false, error: "Contact-form protection is temporarily unavailable." },
        { status: 503 },
      );
    }
    return NextResponse.json(
      { ok: false, error: "Too many contact messages. Try again later." },
      {
        status: 429,
        headers: rateLimit.retryAfterSeconds
          ? { "Retry-After": String(rateLimit.retryAfterSeconds) }
          : undefined,
      },
    );
  }

  try {
    const delivery = await sendContactFormEmail({
      to: appConfig.contactToEmail,
      name: parsed.data.name,
      email: parsed.data.email.toLowerCase(),
      message: parsed.data.message,
      idempotencyKey: contactIdempotencyKey({
        requestId: parsed.data.requestId,
        to: appConfig.contactToEmail,
        from: appConfig.alertFromEmail,
        name: parsed.data.name,
        email: parsed.data.email,
        message: parsed.data.message,
      }),
    });
    if (!emailRequestAccepted(delivery)) {
      return NextResponse.json(
        { ok: false, error: "Delivery could not be confirmed. You can safely retry this message." },
        { status: 502 },
      );
    }
  } catch (error) {
    console.error("Contact-form email delivery failed", error);
    return NextResponse.json(
      { ok: false, error: "Delivery could not be confirmed. You can safely retry this message." },
      { status: 502 },
    );
  }

  return NextResponse.json({
    ok: true,
    message: "Thanks. Your message was sent.",
  });
}

function contactIdempotencyKey(input: {
  requestId: string;
  to: string;
  from: string;
  name: string;
  email: string;
  message: string;
}) {
  const payload = JSON.stringify({
    kind: "awardping-contact-form-v1",
    requestId: input.requestId,
    to: input.to,
    from: input.from,
    name: input.name,
    email: input.email.toLowerCase(),
    message: input.message,
  });
  return `awardping-contact:${crypto.createHash("sha256").update(payload).digest("hex")}`;
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
