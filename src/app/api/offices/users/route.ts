import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { requireOfficeContext, requireOfficeRole } from "@/lib/offices";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Log in first." }, { status: 401 });
  }

  const context = await requireOfficeContext(user);
  await requireOfficeRole(user.id, context.current.officeId, ["owner", "admin"]);

  const query = new URL(request.url).searchParams.get("query")?.trim().toLowerCase() || "";
  if (query.length < 3) {
    return NextResponse.json({ users: [] });
  }

  const admin = createSupabaseAdminClient();
  const [{ data: profiles, error }, { data: members, error: membersError }] =
    await Promise.all([
      admin
        .from("profiles")
        .select("id, email")
        .ilike("email", `%${escapeLike(query)}%`)
        .limit(8),
      admin
        .from("office_members")
        .select("user_id")
        .eq("office_id", context.current.officeId)
        .eq("status", "active"),
    ]);

  if (error || membersError) {
    return NextResponse.json(
      { error: error?.message || membersError?.message || "Users could not be searched." },
      { status: 500 },
    );
  }

  const existingMembers = new Set((members || []).map((member) => member.user_id));
  const users = (profiles || [])
    .filter((profile) => profile.email && !existingMembers.has(profile.id))
    .map((profile) => ({ id: profile.id, email: profile.email }));

  return NextResponse.json({ users });
}

function escapeLike(value: string) {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}
