import "server-only";

import type { SupabaseClient, User } from "@supabase/supabase-js";
import {
  contentTypeForPage,
  pageTypeLabel,
  type AwardPageType,
} from "@/lib/award-discovery-types";
import { displayAwardSummary } from "@/lib/award-summary";
import type { Database } from "@/lib/database.types";
import { nextCheckDate, type Cadence } from "@/lib/plans";
import { normalizeSharedAwardKey } from "@/lib/shared-awards-core";
import {
  displayHomepageForAward,
  filterTrackableOfficialSources,
} from "@/lib/source-url-policy";

export { normalizeSharedAwardKey };

type AdminClient = SupabaseClient<Database>;
type SharedAward = Database["public"]["Tables"]["shared_awards"]["Row"];
type SharedAwardSource = Database["public"]["Tables"]["shared_award_sources"]["Row"];

export type SharedAwardInput = {
  name: string;
  officialHomepage?: string | null;
  summary?: string | null;
  confidence?: number;
  source: "seed" | "user" | "admin";
  submittedByUserId?: string | null;
  sources: Array<{
    url: string;
    title: string;
    pageType: AwardPageType;
    confidence?: number;
    reason?: string | null;
  }>;
};

export async function upsertSharedAward(
  supabase: AdminClient,
  input: SharedAwardInput,
) {
  const searchKey = normalizeSharedAwardKey(input.name);
  if (!searchKey) {
    throw new Error("Shared award name is required.");
  }

  const inputSummary = displayAwardSummary(input.summary);
  let sharedAward = await findSharedAward(supabase, searchKey);
  if (!sharedAward) {
    const { data, error } = await supabase
      .from("shared_awards")
      .insert({
        search_key: searchKey,
        name: input.name.trim(),
        official_homepage: input.officialHomepage || null,
        summary: inputSummary,
        confidence: input.confidence || 0,
        source: input.source,
        submitted_by_user_id: input.submittedByUserId || null,
      })
      .select("*")
      .single();

    if (error || !data) {
      throw new Error(error?.message || "Shared award could not be created.");
    }

    sharedAward = data;
  } else {
    const updates: Database["public"]["Tables"]["shared_awards"]["Update"] = {};

    if (!sharedAward.official_homepage && input.officialHomepage) {
      updates.official_homepage = input.officialHomepage;
    }

    if (!sharedAward.summary && inputSummary) {
      updates.summary = inputSummary;
    }

    if ((input.confidence || 0) > sharedAward.confidence) {
      updates.confidence = input.confidence || 0;
    }

    if (Object.keys(updates).length > 0) {
      updates.updated_at = new Date().toISOString();
      const { data, error } = await supabase
        .from("shared_awards")
        .update(updates)
        .eq("id", sharedAward.id)
        .select("*")
        .single();

      if (error || !data) {
        throw new Error(error?.message || "Shared award could not be updated.");
      }

      sharedAward = data;
    }
  }

  if (input.sources.length > 0) {
    const { error } = await supabase.from("shared_award_sources").upsert(
      input.sources.map((source) => ({
        shared_award_id: sharedAward.id,
        url: source.url,
        title: source.title.trim() || input.name.trim(),
        page_type: source.pageType,
        confidence: source.confidence || 0,
        reason: source.reason || null,
        source: input.source,
        submitted_by_user_id: input.submittedByUserId || null,
      })),
      { onConflict: "shared_award_id,url", ignoreDuplicates: true },
    );

    if (error) {
      throw new Error(error.message);
    }
  }

  return sharedAward;
}

export async function trackSharedAwardForOffice(input: {
  supabase: AdminClient;
  sharedAward: SharedAward;
  sharedSources: SharedAwardSource[];
  user: User;
  officeId: string;
  cadence: Cadence;
}) {
  const sharedSources = filterTrackableOfficialSources(input.sharedSources);
  if (sharedSources.length === 0) {
    throw new Error("This shared award does not have official organization source pages yet.");
  }

  const officialHomepage = displayHomepageForAward(
    input.sharedAward.official_homepage,
    sharedSources,
  );
  const existing = await findOfficeAwardForSharedAward(
    input.supabase,
    input.officeId,
    input.sharedAward.id,
  );

  if (existing) {
    const trackedSources = await addSharedSourcesToOfficeAward({
      supabase: input.supabase,
      award: existing,
      sharedAward: input.sharedAward,
      sharedSources,
      user: input.user,
      officeId: input.officeId,
      cadence: input.cadence,
    });

    return { award: existing, ...trackedSources, alreadyTracked: true };
  }

  const { data: award, error: awardError } = await input.supabase
    .from("awards")
    .insert({
      office_id: input.officeId,
      user_id: input.user.id,
      shared_award_id: input.sharedAward.id,
      name: input.sharedAward.name,
      official_homepage: officialHomepage,
      summary: displayAwardSummary(input.sharedAward.summary),
      confidence: input.sharedAward.confidence,
      status: "active",
    })
    .select("*")
    .single();

  if (awardError || !award) {
    throw new Error(awardError?.message || "Award card could not be created.");
  }

  const trackedSources = await addSharedSourcesToOfficeAward({
    supabase: input.supabase,
    award,
    sharedAward: input.sharedAward,
    sharedSources,
    user: input.user,
    officeId: input.officeId,
    cadence: input.cadence,
  });

  return {
    award,
    ...trackedSources,
    alreadyTracked: false,
  };
}

async function addSharedSourcesToOfficeAward(input: {
  supabase: AdminClient;
  award: Database["public"]["Tables"]["awards"]["Row"];
  sharedAward: SharedAward;
  sharedSources: SharedAwardSource[];
  user: User;
  officeId: string;
  cadence: Cadence;
}) {
  const sharedSourceIds = input.sharedSources.map((source) => source.id);
  if (sharedSourceIds.length === 0) {
    return { sources: [], monitors: [] };
  }

  const [{ data: existingSources }, { data: existingMonitors }] = await Promise.all([
    input.supabase
      .from("award_sources")
      .select("shared_award_source_id")
      .eq("award_id", input.award.id)
      .in("shared_award_source_id", sharedSourceIds),
    input.supabase
      .from("monitors")
      .select("shared_award_source_id")
      .eq("award_id", input.award.id)
      .in("shared_award_source_id", sharedSourceIds),
  ]);

  const existingSourceIds = new Set(
    (existingSources || [])
      .map((source) => source.shared_award_source_id)
      .filter((id): id is string => Boolean(id)),
  );
  const existingMonitorIds = new Set(
    (existingMonitors || [])
      .map((monitor) => monitor.shared_award_source_id)
      .filter((id): id is string => Boolean(id)),
  );

  const sourceRows = input.sharedSources
    .filter((source) => !existingSourceIds.has(source.id))
    .map((source) => ({
      award_id: input.award.id,
      office_id: input.officeId,
      user_id: input.user.id,
      shared_award_source_id: source.id,
      url: source.url,
      title: source.title,
      page_type: source.page_type,
      confidence: source.confidence,
      reason: source.reason,
      selected: true,
    }));

  const { data: sources, error: sourcesError } = sourceRows.length
    ? await input.supabase.from("award_sources").insert(sourceRows).select("*")
    : { data: [], error: null };

  if (sourcesError) {
    throw new Error(sourcesError.message);
  }

  const monitorRows = input.sharedSources
    .filter((source) => !existingMonitorIds.has(source.id))
    .map((source) => ({
      office_id: input.officeId,
      user_id: input.user.id,
      award_id: input.award.id,
      shared_award_source_id: source.id,
      label: `${input.sharedAward.name} - ${pageTypeLabel(source.page_type)}`,
      url: source.url,
      content_type: contentTypeForPage(source.page_type, source.url),
      cadence: input.cadence,
      page_type: source.page_type,
      source_label: source.title,
      next_check_at: nextCheckDate(input.cadence, new Date(Date.now() - 86_400_000)),
    }));

  const { data: monitors, error: monitorsError } = monitorRows.length
    ? await input.supabase.from("monitors").insert(monitorRows).select("*")
    : { data: [], error: null };

  if (monitorsError) {
    throw new Error(monitorsError.message);
  }

  return {
    sources: sources || [],
    monitors: monitors || [],
  };
}

async function findSharedAward(supabase: AdminClient, searchKey: string) {
  const { data, error } = await supabase
    .from("shared_awards")
    .select("*")
    .eq("search_key", searchKey)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  return data;
}

async function findOfficeAwardForSharedAward(
  supabase: AdminClient,
  officeId: string,
  sharedAwardId: string,
) {
  const { data, error } = await supabase
    .from("awards")
    .select("*")
    .eq("office_id", officeId)
    .eq("shared_award_id", sharedAwardId)
    .eq("status", "active")
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  return data;
}
