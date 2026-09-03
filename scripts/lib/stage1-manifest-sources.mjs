// Stage 1 manifest awareness for worker lanes.
//
// The 25 released cohorts pin their reviewed sources in
// public.stage1_award_source_manifest (source_ids uuid[] per cohort/role).
// Those ~125 sources decide what appears on the live award pages, so worker
// lanes treat them as the high-importance tier: the strong Gemini model
// reviews their changes and verdicts, and automated holds never take them
// out of monitoring. Everything else stays on the fleet defaults.
//
// Loaded once per run. Tolerant of a database without the Stage 1 tables
// (local/dev), in which case nothing is tiered.

const STAGE1_MANIFEST_TABLE = "stage1_award_source_manifest";
const STAGE1_MEMBERS_TABLE = "stage1_award_members";
const STAGE1_REGISTRY_TABLE = "stage1_award_registry";

function isMissingStage1TableError(error) {
  const code = String(error?.code || "");
  const message = String(error?.message || "").toLowerCase();
  return (
    code === "42P01" ||
    code === "PGRST205" ||
    (message.includes("does not exist") && message.includes("stage1_")) ||
    (message.includes("could not find the table") && message.includes("stage1_"))
  );
}

export function emptyStage1ManifestSources() {
  return {
    available: false,
    sourceIds: new Set(),
    awardIds: new Set(),
    cohortBySourceId: new Map(),
  };
}

/**
 * Load the Stage 1 manifest once for a worker run.
 *
 * @param {object} supabase service-role client
 * @returns {Promise<{available: boolean, sourceIds: Set<string>, awardIds: Set<string>, cohortBySourceId: Map<string,string>}>}
 */
export async function loadStage1ManifestSources(supabase) {
  if (!supabase || typeof supabase.from !== "function") {
    return emptyStage1ManifestSources();
  }

  // Only cohorts that are actually published (verified_beta) count; a
  // pending or suspended cohort's sources stay on the fleet defaults.
  const registry = await supabase
    .from(STAGE1_REGISTRY_TABLE)
    .select("cohort_key, publication_state")
    .eq("publication_state", "verified_beta");
  if (registry.error) {
    if (isMissingStage1TableError(registry.error)) return emptyStage1ManifestSources();
    throw new Error(`Stage 1 registry load failed: ${registry.error.message}`);
  }
  const publishedCohorts = new Set(
    (registry.data || []).map((row) => String(row?.cohort_key || "").trim()).filter(Boolean),
  );

  const manifest = await supabase
    .from(STAGE1_MANIFEST_TABLE)
    .select("cohort_key, source_role, manifest_status, source_ids")
    .in("manifest_status", ["present", "combined"]);
  if (manifest.error) {
    if (isMissingStage1TableError(manifest.error)) return emptyStage1ManifestSources();
    throw new Error(`Stage 1 manifest load failed: ${manifest.error.message}`);
  }

  const members = await supabase
    .from(STAGE1_MEMBERS_TABLE)
    .select("shared_award_id, cohort_key");
  if (members.error && !isMissingStage1TableError(members.error)) {
    throw new Error(`Stage 1 members load failed: ${members.error.message}`);
  }

  const sourceIds = new Set();
  const cohortBySourceId = new Map();
  for (const row of manifest.data || []) {
    if (!publishedCohorts.has(String(row?.cohort_key || "").trim())) continue;
    for (const sourceId of Array.isArray(row?.source_ids) ? row.source_ids : []) {
      const id = String(sourceId || "").trim();
      if (!id) continue;
      sourceIds.add(id);
      if (!cohortBySourceId.has(id) && row.cohort_key) {
        cohortBySourceId.set(id, String(row.cohort_key));
      }
    }
  }

  const awardIds = new Set();
  for (const row of members.data || []) {
    if (!publishedCohorts.has(String(row?.cohort_key || "").trim())) continue;
    const id = String(row?.shared_award_id || "").trim();
    if (id) awardIds.add(id);
  }

  return { available: true, sourceIds, awardIds, cohortBySourceId };
}

export function isStage1ManifestSource(manifest, sourceId) {
  const id = String(sourceId || "").trim();
  return Boolean(id) && Boolean(manifest?.sourceIds?.has?.(id));
}

export function isStage1MemberAward(manifest, sharedAwardId) {
  const id = String(sharedAwardId || "").trim();
  return Boolean(id) && Boolean(manifest?.awardIds?.has?.(id));
}
