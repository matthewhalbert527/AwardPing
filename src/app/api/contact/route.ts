import { NextResponse } from "next/server";
import { z } from "zod";
import { appConfig } from "@/lib/config";
import { sendContactFormEmail } from "@/lib/email";
import { ensurePublicFormRateLimit } from "@/lib/public-form-rate-limit";

export const runtime = "nodejs";

const contactSchema = z.object({
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

  const rateLimit = await ensurePublicFormRateLimit({
    request,
    kind: "contact",
    limit: 5,
    windowMs: 60 * 60 * 1000,
  });

  if (!rateLimit.allowed) {
    return NextResponse.json(
      { ok: false, error: "Too many contact messages. Try again later." },
      { status: 429 },
    );
  }

  await sendContactFormEmail({
    to: appConfig.contactToEmail,
    name: parsed.data.name,
    email: parsed.data.email.toLowerCase(),
    message: parsed.data.message,
  });

  return NextResponse.json({
    ok: true,
    message: "Thanks. Your message was sent.",
  });
}
