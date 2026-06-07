import { NextResponse } from "next/server";
import { hasSupabaseAdminConfig, hasSupabaseConfig } from "@/lib/config";
import { formatOfficeNameWithOrganization } from "@/lib/office-names";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

export async function GET(request: Request) {
  if (!hasSupabaseConfig() || !hasSupabaseAdminConfig()) {
    return NextResponse.json({ offices: [] });
  }

  const query = new URL(request.url).searchParams.get("query")?.trim() || "";
  const organizationId = new URL(request.url).searchParams.get("organizationId")?.trim() || "";
  const admin = createSupabaseAdminClient();
  let builder = admin
    .from("offices")
    .select("id, name, organization_id")
    .neq("name", "New award office")
    .neq("name", "New office")
    .order("name", { ascending: true })
    .limit(query.length >= 2 || organizationId ? 20 : 50);

  if (query.length >= 2) {
    builder = builder.ilike("name", `%${escapeLike(query)}%`);
  }

  if (organizationId) {
    builder = builder.eq("organization_id", organizationId);
  }

  const { data, error } = await builder;
  if (error) {
    return NextResponse.json({ error: "Offices could not be searched." }, { status: 500 });
  }

  const organizationIds = [
    ...new Set((data || []).map((office) => office.organization_id).filter(Boolean)),
  ] as string[];
  const { data: organizations, error: organizationError } = organizationIds.length
    ? await admin.from("organizations").select("id, name").in("id", organizationIds)
    : { data: [], error: null };

  if (organizationError) {
    return NextResponse.json({ error: "Offices could not be searched." }, { status: 500 });
  }

  const organizationsById = new Map(
    (organizations || []).map((organization) => [organization.id, organization.name]),
  );

  return NextResponse.json({
    offices: (data || []).map((office) => ({
      id: office.id,
      name: formatOfficeNameWithOrganization(
        office.name,
        office.organization_id ? organizationsById.get(office.organization_id) : null,
      ),
      officeName: office.name,
      organizationId: office.organization_id,
      organizationName: office.organization_id
        ? organizationsById.get(office.organization_id) || null
        : null,
    })),
  });
}

function escapeLike(value: string) {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}
