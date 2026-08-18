const cleanupRpc = "apply_shared_award_source_cleanup_plan";
const cleanupPlanSchema = "awardping-award-source-cleanup-plan-v1";
const sourceStateSchema = "awardping-source-retirement-cas-v1";

export function buildExpectedSourceRetirementState(source) {
  requireObject(source, "source cleanup row");
  requireText(source.id, "source id");
  requireText(source.shared_award_id, "source award id");
  requireText(source.url, "source URL");
  requireText(source.title, "source title");
  requireText(source.page_type, "source page type");
  requireText(source.source, "source origin");
  requireText(source.admin_review_status, "source review status");
  requireText(source.updated_at, "source revision");
  if (source.confidence === null || source.confidence === undefined) {
    throw new Error("Source cleanup CAS requires the observed source confidence.");
  }
  if (!("last_error" in source)) {
    throw new Error("Source cleanup CAS requires the observed source failure state.");
  }

  return {
    schema_version: sourceStateSchema,
    id: source.id,
    shared_award_id: source.shared_award_id,
    url: source.url,
    title: source.title,
    page_type: source.page_type,
    confidence: source.confidence,
    source: source.source,
    last_error: source.last_error ?? null,
    admin_review_status: source.admin_review_status,
    updated_at: source.updated_at,
  };
}

export function buildAwardSourceCleanupPlan({
  award,
  allSources,
  retireSources = [],
  usefulRemainingSourceIds = [],
  homepageAfter = award?.official_homepage ?? null,
  homepageReplacementSourceId = null,
}) {
  requireObject(award, "award cleanup row");
  requireText(award.id, "award id");
  requireText(award.name, "award name");
  requireText(award.status, "award status");
  requireText(award.updated_at, "award revision");
  if (!("official_homepage" in award)) {
    throw new Error("Source cleanup CAS requires the observed award homepage.");
  }
  if (award.status !== "active") {
    throw new Error("Source cleanup CAS can plan only an active award.");
  }
  if (!Array.isArray(allSources) || !Array.isArray(retireSources)) {
    throw new Error("Source cleanup CAS requires complete source arrays.");
  }

  const expectedSources = [...allSources]
    .map(buildExpectedSourceRetirementState)
    .sort((left, right) => left.id.localeCompare(right.id));
  const sourceById = uniqueSourceMap(expectedSources);
  for (const source of expectedSources) {
    if (source.shared_award_id !== award.id) {
      throw new Error("Source cleanup CAS source snapshot crosses award boundaries.");
    }
  }

  const retireIds = uniqueSortedIds(retireSources.map((source) => source?.id));
  for (const id of retireIds) {
    const source = sourceById.get(id);
    if (!source || source.admin_review_status !== "open") {
      throw new Error("Source cleanup CAS can retire only observed open sources.");
    }
  }
  const retireSet = new Set(retireIds);
  const remainingOpenIds = expectedSources
    .filter(
      (source) =>
        source.admin_review_status === "open" && !retireSet.has(source.id),
    )
    .map((source) => source.id);
  const usefulIds = uniqueSortedIds(usefulRemainingSourceIds);
  for (const id of usefulIds) {
    if (!remainingOpenIds.includes(id)) {
      throw new Error(
        "Source cleanup CAS planned useful source is not an observed remaining source.",
      );
    }
  }

  if (homepageAfter !== null) requireText(homepageAfter, "planned homepage");
  if (homepageReplacementSourceId !== null) {
    requireText(homepageReplacementSourceId, "homepage replacement source id");
    const replacement = sourceById.get(homepageReplacementSourceId);
    if (
      !replacement ||
      !usefulIds.includes(homepageReplacementSourceId) ||
      replacement.url !== homepageAfter
    ) {
      throw new Error(
        "Source cleanup CAS homepage replacement is not a planned useful remaining source.",
      );
    }
  } else if (award.official_homepage !== homepageAfter && homepageAfter !== null) {
    throw new Error(
      "Source cleanup CAS non-null homepage replacement requires a source identity.",
    );
  }
  if (
    award.official_homepage === homepageAfter &&
    homepageReplacementSourceId !== null
  ) {
    throw new Error("Source cleanup CAS unchanged homepage cannot claim a replacement.");
  }
  if (
    award.official_homepage === homepageAfter &&
    expectedSources.some(
      (source) =>
        retireSet.has(source.id) && source.url === award.official_homepage,
    )
  ) {
    throw new Error(
      "Source cleanup CAS cannot leave the homepage on a retiring source.",
    );
  }
  if (!retireIds.length && award.official_homepage === homepageAfter) {
    throw new Error("Source cleanup CAS refuses an empty award plan.");
  }

  return {
    schema_version: cleanupPlanSchema,
    expected_award: {
      id: award.id,
      name: award.name,
      official_homepage: award.official_homepage ?? null,
      status: award.status,
      updated_at: award.updated_at,
    },
    expected_sources: expectedSources,
    retire_source_ids: retireIds,
    expected_remaining_open_source_ids: remainingOpenIds,
    planned_useful_remaining_source_ids: usefulIds,
    homepage: {
      old_url: award.official_homepage ?? null,
      new_url: homepageAfter,
      replacement_source_id: homepageReplacementSourceId,
    },
  };
}

export async function applyAwardSourceCleanupPlanWithCas({
  supabase,
  plan,
  reason,
  actor,
}) {
  requireClient(supabase);
  requireObject(plan, "award cleanup plan");
  requireText(reason, "source retirement reason");
  requireText(actor, "source retirement actor");
  const awardId = plan.expected_award?.id;
  requireText(awardId, "planned award id");

  const { data, error } = await supabase.rpc(cleanupRpc, {
    p_plan: plan,
    p_reason: reason,
    p_actor: actor,
  });
  const result = Array.isArray(data) ? data[0] : data;
  if (error) {
    throw new Error(
      `Apply source cleanup for award ${awardId}: ${error.message || "CAS failed; requeue cleanup"}`,
    );
  }
  if (!result?.shared_award_id || result.shared_award_id !== awardId) {
    throw new Error(
      `Apply source cleanup for award ${awardId}: no atomic compare-and-swap result; award or source set changed after planning, requeue cleanup.`,
    );
  }
  return result;
}

function uniqueSourceMap(sources) {
  const result = new Map();
  for (const source of sources) {
    if (result.has(source.id)) {
      throw new Error(`Source cleanup CAS received duplicate source ${source.id}.`);
    }
    result.set(source.id, source);
  }
  return result;
}

function uniqueSortedIds(values) {
  const ids = values.filter((value) => value !== null && value !== undefined);
  for (const id of ids) requireText(id, "source identity");
  return [...new Set(ids)].sort((left, right) => left.localeCompare(right));
}

function requireClient(value) {
  if (!value || typeof value.rpc !== "function") {
    throw new Error("Source cleanup CAS requires a Supabase client.");
  }
}

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Source cleanup CAS requires an observed ${label}.`);
  }
}

function requireText(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Source cleanup CAS requires a non-empty ${label}.`);
  }
}
