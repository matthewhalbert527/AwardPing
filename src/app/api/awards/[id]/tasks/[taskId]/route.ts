import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth";
import { hasSupabaseConfig } from "@/lib/config";
import type { Database } from "@/lib/database.types";
import { awardTaskStatuses } from "@/lib/award-workflow";
import { assertOfficeMember, getAwardAndMembership } from "@/lib/award-workflow-server";
import { isSameOriginMutationRequest } from "@/lib/same-origin-mutation";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

type Params = {
  params: Promise<{ id: string; taskId: string }>;
};

const taskUpdateSchema = z.object({
  title: z.string().trim().min(1).max(240).optional(),
  status: z.enum(awardTaskStatuses).optional(),
  assignedMemberId: z.string().uuid().nullable().optional(),
});

export async function PATCH(request: Request, { params }: Params) {
  if (!isSameOriginMutationRequest(request)) {
    return NextResponse.json({ error: "This request is not allowed." }, { status: 403 });
  }

  if (!hasSupabaseConfig()) {
    return NextResponse.json({ error: "Supabase is not configured." }, { status: 503 });
  }

  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Log in first." }, { status: 401 });
  }

  const parsed = taskUpdateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid follow-up update." }, { status: 400 });
  }

  const { id, taskId } = await params;
  const result = await getAwardAndMembership(user.id, id);
  if (!result) {
    return NextResponse.json({ error: "Award was not found." }, { status: 404 });
  }

  const admin = createSupabaseAdminClient();
  const { data: task, error: taskError } = await admin
    .from("award_tasks")
    .select("*")
    .eq("id", taskId)
    .eq("award_id", id)
    .eq("office_id", result.award.office_id!)
    .maybeSingle();

  if (taskError) {
    return NextResponse.json({ error: taskError.message }, { status: 500 });
  }
  if (!task) {
    return NextResponse.json({ error: "Follow-up was not found." }, { status: 404 });
  }

  if (parsed.data.assignedMemberId) {
    const assignee = await assertOfficeMember(result.award.office_id!, parsed.data.assignedMemberId);
    if (!assignee) {
      return NextResponse.json({ error: "Assignee must be an active office member." }, { status: 400 });
    }
  }

  const update: Database["public"]["Tables"]["award_tasks"]["Update"] = {
    updated_at: new Date().toISOString(),
  };

  if (parsed.data.title) {
    update.title = parsed.data.title;
  }
  if (parsed.data.assignedMemberId !== undefined) {
    update.assigned_member_id = parsed.data.assignedMemberId;
  }
  if (parsed.data.status) {
    update.status = parsed.data.status;
    update.completed_at = parsed.data.status === "done" ? new Date().toISOString() : null;
    update.completed_by_user_id = parsed.data.status === "done" ? user.id : null;
  }

  const { data: updatedTask, error } = await admin
    .from("award_tasks")
    .update(update)
    .eq("id", taskId)
    .eq("award_id", id)
    .eq("office_id", result.award.office_id!)
    .select("*")
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, task: updatedTask });
}
