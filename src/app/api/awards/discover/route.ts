import { NextResponse } from "next/server";
import { z } from "zod";
import {
  classifyAwardCandidates,
  hasAwardClassifierConfig,
  searchAwardCandidates,
  sanitizeDiscoveryResult,
} from "@/lib/award-discovery";
import { getCurrentUser } from "@/lib/auth";
import { appConfig, hasSupabaseConfig } from "@/lib/config";
import { reserveDiscoveryRequest } from "@/lib/discovery-rate-limit";

export const runtime = "nodejs";

const discoverSchema = z.object({
  query: z.string().trim().min(2).max(120),
});

export async function POST(request: Request) {
  if (!hasSupabaseConfig()) {
    return NextResponse.json({ error: "Supabase is not configured." }, { status: 503 });
  }

  if (!appConfig.tavilyApiKey || !hasAwardClassifierConfig()) {
    return NextResponse.json(
      { error: "Award discovery needs Tavily plus Gemini or OpenAI API keys." },
      { status: 503 },
    );
  }

  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Log in first." }, { status: 401 });
  }

  const parsed = discoverSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Enter an award name to search." }, { status: 400 });
  }

  try {
    const rateLimit = await reserveDiscoveryRequest({
      request,
      user,
      query: parsed.data.query,
    });

    if (!rateLimit.allowed) {
      return NextResponse.json(
        { error: rateLimit.reason },
        {
          status: 429,
          headers: {
            "Retry-After": String(rateLimit.retryAfterSeconds),
          },
        },
      );
    }

    const candidates = await searchAwardCandidates(parsed.data.query);
    if (candidates.length === 0) {
      return NextResponse.json({
        ok: true,
        discovery: sanitizeDiscoveryResult({
          awardName: parsed.data.query,
          officialHomepage: null,
          summary:
            "No official source pages were found. Add an exact award URL manually.",
          confidence: 0,
          candidates: [],
        }),
        rawCandidateCount: 0,
      });
    }

    const discovery = await classifyAwardCandidates(parsed.data.query, candidates);
    return NextResponse.json({
      ok: true,
      discovery,
      rawCandidateCount: candidates.length,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Award discovery could not be completed.",
      },
      { status: 500 },
    );
  }
}
