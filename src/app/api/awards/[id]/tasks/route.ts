import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth";
import { hasSupabaseConfig } from "@/lib/config";
import { assertOfficeMember, getAwardAndMembership } from "@/lib/award-workflow-server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

type Params = {
  params: Promise<{ id: string }>;
};

const taskSchema = z.object({
  title: z.string().trim().min(1).max(240),
  assignedMemberId: z.string().uuid().nullable().optional(),
});

export async function POST(request: Request, { params }: Params) {
  if (!hasSupabaseConfig()) {
    return NextResponse.json({ error: "Supabase is not configured." }, { status: 503 });
  }

  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Log in first." }, { status: 401 });
  }

  const parsed = taskSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Add a follow-up title." }, { status: 400 });
  }

  const { id } = await params;
  const result = await getAwardAndMembership(user.id, id);
  if (!result) {
    return NextResponse.json({ error: "Award was not found." }, { status: 404 });
  }

  if (parsed.data.assignedMemberId) {
    const assignee = await assertOfficeMember(result.award.office_id!, parsed.data.assignedMemberId);
    if (!assignee) {
      return NextResponse.json({ error: "Assignee must be an active office member." }, { status: 400 });
    }
  }

  const admin = createSupabaseAdminClient();
  const { data: task, error } = await admin
    .from("award_tasks")
    .insert({
      office_id: result.award.office_id!,
      award_id: id,
      created_by_user_id: user.id,
      assigned_member_id: parsed.data.assignedMemberId || null,
      title: parsed.data.title,
    })
    .select("*")
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, task });
}
