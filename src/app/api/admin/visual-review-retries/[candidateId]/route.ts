import { NextResponse } from "next/server";
import { z } from "zod";
import { validateSameOriginAdminMutation } from "@/lib/admin-request-security";
import { getCurrentUser, isSiteAdminEmail } from "@/lib/auth";
import { hasSupabaseAdminConfig, hasSupabaseConfig } from "@/lib/config";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

type Props = {
  params: Promise<{ candidateId: string }>;
};

const bodySchema = z.object({
  expectedCandidateUpdatedAt: z.string().datetime({ offset: true }),
  reason: z.string().trim().min(1).max(1000),
});

export async function POST(request: Request, { params }: Props) {
  const originError = validateSameOriginAdminMutation(request);
  if (originError) return originError;
  if (!hasSupabaseConfig() || !hasSupabaseAdminConfig()) {
    return NextResponse.json(
      { error: "Supabase admin access is not configured." },
      { status: 503 },
    );
  }

  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Log in first." }, { status: 401 });
  }
  if (!isSiteAdminEmail(user.email)) {
    return NextResponse.json(
      { error: "Only AwardPing site admins can approve a paid review retry." },
      { status: 403 },
    );
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "A current failed-candidate timestamp and approval reason are required." },
      { status: 400 },
    );
  }
  const { candidateId } = await params;
  if (!z.string().uuid().safeParse(candidateId).success) {
    return NextResponse.json({ error: "Invalid visual review candidate." }, { status: 400 });
  }

  const admin = createSupabaseAdminClient();
  let result;
  try {
    result = await admin.rpc("approve_visual_review_paid_retry", {
      p_candidate_id: candidateId,
      p_expected_candidate_updated_at: parsed.data.expectedCandidateUpdatedAt,
      p_reason: parsed.data.reason,
      p_actor: user.email || user.id,
    });
  } catch (error) {
    console.error("Paid visual-review retry approval RPC threw", error);
    return NextResponse.json(
      { error: "Paid retry approval is temporarily unavailable." },
      { status: 500 },
    );
  }
  const { data, error } = result;
  if (error) {
    const conflict = error.code === "40001" || /changed before/i.test(error.message || "");
    return NextResponse.json(
      {
        error: conflict
          ? "This failure changed. Refresh the Action Inbox before approving it."
          : "The current provider state is not eligible for a paid retry approval.",
      },
      { status: conflict ? 409 : 422 },
    );
  }

  return NextResponse.json({
    ok: true,
    approval: {
      id: data.id,
      candidateId: data.candidate_id,
      laneKey: data.lane_key,
      expiresAt: data.expires_at,
      status: data.status,
    },
  });
}
