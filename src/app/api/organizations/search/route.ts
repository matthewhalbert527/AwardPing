import { NextResponse } from "next/server";
import { hasSupabaseAdminConfig, hasSupabaseConfig } from "@/lib/config";
import {
  dedupeOrganizationsForQuery,
  organizationSearchTokens,
} from "@/lib/organization-matching";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

export async function GET(request: Request) {
  if (!hasSupabaseConfig() || !hasSupabaseAdminConfig()) {
    return NextResponse.json({ organizations: [] });
  }

  const query = new URL(request.url).searchParams.get("query")?.trim() || "";
  const tokens = organizationSearchTokens(query);
  const admin = createSupabaseAdminClient();
  let builder = admin
    .from("organizations")
    .select("id, name, country, country_code, state_province")
    .order("name", { ascending: true })
    .limit(tokens.length ? 60 : 30);

  if (tokens.length) {
    for (const token of tokens) {
      builder = builder.ilike("name", `%${escapeLike(token)}%`);
    }
  }

  const { data, error } = await builder;
  if (error) {
    return NextResponse.json(
      { error: "Organizations could not be searched." },
      { status: 500 },
    );
  }

  return NextResponse.json({
    organizations: tokens.length
      ? dedupeOrganizationsForQuery(query, data || []).slice(0, 16)
      : data || [],
  });
}

function escapeLike(value: string) {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}
