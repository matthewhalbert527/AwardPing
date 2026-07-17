import { redirect } from "next/navigation";
import { SetupNotice } from "@/components/setup-notice";
import { requireUser } from "@/lib/auth";
import { canonicalAwardPath, normalizeAwardSlug } from "@/lib/award-slugs";
import { hasSupabaseConfig } from "@/lib/config";
import type { Database } from "@/lib/database.types";
import { getPublicAwardPageResolutionBySlug } from "@/lib/public-award-pages";
import { getStage1PublicationEntryForAward } from "@/lib/stage1-publication";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

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
  const award = await resolveSharedAwardForDashboard(id);

  if (!award) redirect("/award-directory");

  redirect(`${canonicalAwardPath(award.slug, award.name, award.id)}${queryString(query)}`);
}

async function resolveSharedAwardForDashboard(
  identifier: string,
): Promise<SharedAwardRow | null> {
  if (isUuid(identifier)) {
    const publication = await getStage1PublicationEntryForAward(identifier);
    if (!publication?.effectivelyVerified) return null;

    const admin = createSupabaseAdminClient();
    const { data } = await admin
      .from("shared_awards")
      .select("id, name, slug")
      .eq("id", publication.canonicalAwardId)
      .eq("status", "active")
      .maybeSingle();

    return data;
  }

  const normalized = normalizeAwardSlug(identifier);
  const resolution = await getPublicAwardPageResolutionBySlug(normalized);
  return resolution.kind === "published" ? resolution.data.award : null;
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
