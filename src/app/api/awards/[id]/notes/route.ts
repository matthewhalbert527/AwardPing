import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth";
import { hasSupabaseConfig } from "@/lib/config";
import { getAwardAndMembership } from "@/lib/award-workflow-server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

type Params = {
  params: Promise<{ id: string }>;
};

const noteSchema = z.object({
  body: z.string().trim().min(1).max(2000),
});

export async function POST(request: Request, { params }: Params) {
  if (!hasSupabaseConfig()) {
    return NextResponse.json({ error: "Supabase is not configured." }, { status: 503 });
  }

  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Log in first." }, { status: 401 });
  }

  const parsed = noteSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Write a note first." }, { status: 400 });
  }

  const { id } = await params;
  const result = await getAwardAndMembership(user.id, id);
  if (!result) {
    return NextResponse.json({ error: "Award was not found." }, { status: 404 });
  }

  const admin = createSupabaseAdminClient();
  const { data: note, error } = await admin
    .from("award_notes")
    .insert({
      office_id: result.award.office_id!,
      award_id: id,
      author_user_id: user.id,
      author_member_id: result.membership.id,
      body: parsed.data.body,
    })
    .select("*")
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, note });
}
