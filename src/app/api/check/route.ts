import crypto from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { hasSupabaseAdminConfig } from "@/lib/config";
import { fetchExtractedContent } from "@/lib/extract";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

const schema = z.object({
  url: z.string().url(),
});

export async function POST(request: NextRequest) {
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: "Enter a valid public URL." },
      { status: 400 },
    );
  }

  try {
    const content = await fetchExtractedContent(parsed.data.url);
    await recordFreeCheck(request, content.url);

    return NextResponse.json({
      ok: true,
      hash: content.hash,
      sample: content.sample,
      contentType: content.contentType,
      byteLength: content.byteLength,
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "The URL could not be checked.",
      },
      { status: 400 },
    );
  }
}

async function recordFreeCheck(request: NextRequest, url: string) {
  if (!hasSupabaseAdminConfig()) return;

  const forwarded = request.headers.get("x-forwarded-for") || "";
  const ip = forwarded.split(",")[0]?.trim() || "unknown";
  const ipHash = crypto.createHash("sha256").update(ip).digest("hex");
  const supabase = createSupabaseAdminClient();
  await supabase.from("free_checks").insert({ ip_hash: ipHash, url });
}
