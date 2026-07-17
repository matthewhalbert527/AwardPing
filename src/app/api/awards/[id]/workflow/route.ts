import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth";
import { hasSupabaseConfig } from "@/lib/config";
import type { Database } from "@/lib/database.types";
import {
  awardPriorities,
  awardWorkflowStatuses,
  workflowStatusAfterReview,
} from "@/lib/award-workflow";
import { assertOfficeMember, getAwardAndMembership } from "@/lib/award-workflow-server";
import { isSameOriginMutationRequest } from "@/lib/same-origin-mutation";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

type Params = {
  params: Promise<{ id: string }>;
};

const workflowSchema = z.object({
  workflowStatus: z.enum(awardWorkflowStatuses).optional(),
  priority: z.enum(awardPriorities).optional(),
  ownerMemberId: z.string().uuid().nullable().optional(),
  markReviewed: z.boolean().optional(),
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

  const parsed = workflowSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid award workflow update." }, { status: 400 });
  }

  const { id } = await params;
  const result = await getAwardAndMembership(user.id, id);
  if (!result) {
    return NextResponse.json({ error: "Award was not found." }, { status: 404 });
  }

  if (parsed.data.ownerMemberId) {
    const owner = await assertOfficeMember(result.award.office_id!, parsed.data.ownerMemberId);
    if (!owner) {
      return NextResponse.json({ error: "Owner must be an active office member." }, { status: 400 });
    }
  }

  const update: Database["public"]["Tables"]["awards"]["Update"] = {
    updated_at: new Date().toISOString(),
  };

  if (parsed.data.workflowStatus) {
    update.workflow_status = parsed.data.workflowStatus;
  }
  if (parsed.data.priority) {
    update.priority = parsed.data.priority;
  }
  if (parsed.data.ownerMemberId !== undefined) {
    update.owner_member_id = parsed.data.ownerMemberId;
  }
  if (parsed.data.markReviewed) {
    update.last_reviewed_at = new Date().toISOString();
    update.workflow_status = workflowStatusAfterReview(
      parsed.data.workflowStatus || result.award.workflow_status,
    );
  }

  const admin = createSupabaseAdminClient();
  const { data: award, error } = await admin
    .from("awards")
    .update(update)
    .eq("id", id)
    .eq("office_id", result.award.office_id!)
    .select("*")
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, award });
}
