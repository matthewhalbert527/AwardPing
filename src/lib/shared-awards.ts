import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { AwardPageType } from "@/lib/award-discovery-types";
import { displayAwardSummary } from "@/lib/award-summary";
import type { Database } from "@/lib/database.types";
import type { Cadence } from "@/lib/plans";
import { normalizeSharedAwardKey } from "@/lib/shared-awards-core";
import { isMonitorableAwardSource } from "@/lib/source-quality";
import {
  canonicalSourceUrlKey,
  filterTrackableOfficialSources,
} from "@/lib/source-url-policy";

export { normalizeSharedAwardKey };

type DatabaseClient = SupabaseClient<Database>;
type SharedAwardSource =
  Database["public"]["Tables"]["shared_award_sources"]["Row"];

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
  supabase: DatabaseClient,
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
  supabase: DatabaseClient;
  canonicalSharedAwardId: string;
  sharedSources: SharedAwardSource[];
  officeId: string;
  cadence: Cadence;
  expectedMemberSharedAwardIds: string[];
  expectedReleaseEpoch: string;
}) {
  const sharedSources = selectTrackableSharedAwardSources(
    input.sharedSources,
    input.canonicalSharedAwardId,
  );
  if (sharedSources.length === 0) {
    throw new Error(
      "This shared award does not have official organization source pages yet.",
    );
  }

  const expectedSourceBindings = sharedSources
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((source) => ({
      id: source.id,
      shared_award_id: source.shared_award_id,
      url: source.url,
      title: source.title,
      page_type: source.page_type,
      confidence: source.confidence,
      reason: source.reason,
      admin_review_status: source.admin_review_status,
      updated_at: source.updated_at,
    }));
  const { data, error } = await input.supabase.rpc(
    "track_office_shared_award_atomic",
    {
      p_office_id: input.officeId,
      p_canonical_shared_award_id: input.canonicalSharedAwardId,
      p_expected_member_shared_award_ids: input.expectedMemberSharedAwardIds,
      p_expected_release_epoch: input.expectedReleaseEpoch,
      p_expected_source_bindings: expectedSourceBindings,
      p_cadence: input.cadence,
    },
  );

  if (error) {
    throwRpcError(error, "Shared award could not be tracked.");
  }
  if (!isJsonObject(data) || !isJsonObject(data.award)) {
    throw new Error("Shared award tracking returned an invalid result.");
  }

  return data as unknown as {
    award: Database["public"]["Tables"]["awards"]["Row"];
    sources: Database["public"]["Tables"]["award_sources"]["Row"][];
    monitors: Database["public"]["Tables"]["monitors"]["Row"][];
    alreadyTracked: boolean;
  };
}

export function selectTrackableSharedAwardSources(
  sources: SharedAwardSource[],
  canonicalSharedAwardId: string,
) {
  const monitorableSources = sources.filter(isMonitorableAwardSource);
  const selectedByUrl = new Map(
    filterTrackableOfficialSources(monitorableSources).map((source) => [
      canonicalSourceUrlKey(source.url),
      source,
    ]),
  );

  // Prefer the reviewed canonical catalog identity when an alias owns the
  // same logical URL. The database independently rejects duplicate URL keys.
  for (const source of filterTrackableOfficialSources(
    monitorableSources.filter(
      (candidate) => candidate.shared_award_id === canonicalSharedAwardId,
    ),
  )) {
    selectedByUrl.set(canonicalSourceUrlKey(source.url), source);
  }

  return [...selectedByUrl.values()];
}

export async function untrackSharedAwardForOffice(input: {
  supabase: DatabaseClient;
  officeId: string;
  requestedSharedAwardId: string;
  expectedMemberSharedAwardIds: string[] | null;
  expectedReleaseEpoch: string | null;
  validateReleaseEpoch: boolean;
}) {
  const { data, error } = await input.supabase.rpc(
    "untrack_office_shared_award_atomic",
    {
      p_office_id: input.officeId,
      p_requested_shared_award_id: input.requestedSharedAwardId,
      p_expected_member_shared_award_ids: input.expectedMemberSharedAwardIds,
      p_expected_release_epoch: input.expectedReleaseEpoch,
      p_validate_release_epoch: input.validateReleaseEpoch,
    },
  );

  if (error) {
    throwRpcError(error, "Shared award could not be untracked.");
  }
  if (!isJsonObject(data) || data.ok !== true) {
    throw new Error("Shared award untracking returned an invalid result.");
  }

  return data;
}

export async function untrackSharedAwardSourceForOffice(input: {
  supabase: DatabaseClient;
  officeId: string;
  requestedSharedAwardId: string;
  sharedAwardSourceId: string;
  expectedMemberSharedAwardIds: string[] | null;
  expectedReleaseEpoch: string | null;
  validateReleaseEpoch: boolean;
}) {
  const { data, error } = await input.supabase.rpc(
    "untrack_office_shared_award_source_atomic",
    {
      p_office_id: input.officeId,
      p_requested_shared_award_id: input.requestedSharedAwardId,
      p_shared_award_source_id: input.sharedAwardSourceId,
      p_expected_member_shared_award_ids: input.expectedMemberSharedAwardIds,
      p_expected_release_epoch: input.expectedReleaseEpoch,
      p_validate_release_epoch: input.validateReleaseEpoch,
    },
  );

  if (error) {
    throwRpcError(error, "Award source page could not be untracked.");
  }
  if (!isJsonObject(data) || data.ok !== true) {
    throw new Error("Award source untracking returned an invalid result.");
  }

  return data;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function throwRpcError(
  error: { message?: string; code?: string },
  fallback: string,
): never {
  const wrapped = new Error(error.message || fallback) as Error & {
    code?: string;
  };
  wrapped.code = error.code;
  throw wrapped;
}

async function findSharedAward(supabase: DatabaseClient, searchKey: string) {
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
