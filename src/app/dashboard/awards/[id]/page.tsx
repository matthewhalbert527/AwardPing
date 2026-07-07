import { redirect } from "next/navigation";
import { SetupNotice } from "@/components/setup-notice";
import { requireUser } from "@/lib/auth";
import { canonicalAwardPath, normalizeAwardSlug } from "@/lib/award-slugs";
import { hasSupabaseConfig } from "@/lib/config";
import type { Database } from "@/lib/database.types";
import { createSupabaseServerClient } from "@/lib/supabase/server";

type Params = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ source?: string; change?: string }>;
};

type SharedAwardRow = Pick<
  Database["public"]["Tables"]["shared_awards"]["Row"],
  "id" | "name" | "slug"
>;

export default async function SharedAwardDetailRedirectPage({ params, searchParams }: Params) {
  if (!hasSupabaseConfig()) return <SetupNotice />;

  await requireUser();

  const { id } = await params;
  const query = await searchParams;
  const supabase = await createSupabaseServerClient();
  const award = await resolveSharedAwardForDashboard(supabase, id);

  if (!award) redirect("/award-directory");

  redirect(`${canonicalAwardPath(award.slug, award.name, award.id)}${queryString(query)}`);
}

async function resolveSharedAwardForDashboard(
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>,
  identifier: string,
): Promise<SharedAwardRow | null> {
  const normalized = normalizeAwardSlug(identifier);

  if (isUuid(identifier)) {
    const { data } = await supabase
      .from("shared_awards")
      .select("id, name, slug")
      .eq("id", identifier)
      .eq("status", "active")
      .maybeSingle();

    return data;
  }

  const { data: direct } = await supabase
    .from("shared_awards")
    .select("id, name, slug")
    .eq("slug", normalized)
    .eq("status", "active")
    .maybeSingle();

  if (direct) return direct;

  const { data: alias } = await supabase
    .from("shared_award_slug_aliases")
    .select("slug, shared_awards!inner(id, name, slug, status)")
    .eq("slug", normalized)
    .eq("shared_awards.status", "active")
    .maybeSingle();

  return embeddedSharedAward(alias?.shared_awards);
}

function embeddedSharedAward(value: unknown): SharedAwardRow | null {
  if (Array.isArray(value)) return embeddedSharedAward(value[0]);
  return value && typeof value === "object" ? (value as SharedAwardRow) : null;
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function queryString(query: { source?: string; change?: string }) {
  const params = new URLSearchParams();
  if (query.source) params.set("source", query.source);
  if (query.change) params.set("change", query.change);
  const value = params.toString();
  return value ? `?${value}` : "";
}
