import { createHash } from "node:crypto";

export function emptyVariationBatchFixture() {
  return { schema: "awardping.program-variation-admin-batch.v1", awards: Array.from({ length: 25 }, (_, index) => ({
    cohort_key: `fixture_${index}`, inventory_sealed: false, draft_inventory_id: null, approval_id: null, current: false,
    expected_variants: 0, total_variants: 0, reviewed_variants: 0, ready_variants: 0, approved_variants: 0,
    current_approved_variants: 0, scope_total: 0, approved_source_ids: [], source_count: 0, blockers: ["provider_inventory_missing"] })) };
}

// Offline database double: sealed identity deliberately excludes capture state.
export function rosterPageFixture(manifest, sources) {
  const roles = manifest.map(role => ({ scope_key: "legacy_common", ...role })).sort((a, b) =>
    compare([a.cohort_key, a.scope_key, a.source_role], [b.cohort_key, b.scope_key, b.source_role]));
  const ordered = [...sources].sort((a, b) => compare(a.id, b.id));
  const identities = ordered.map(source => Object.fromEntries(Object.entries(source).filter(([key]) => key !== "text_monitoring_state")));
  const seal = createHash("sha256").update(JSON.stringify({ roles, sources: identities })).digest("hex");
  return params => {
    const all = params.p_kind === "roles" ? roles : params.p_kind === "sources" ? ordered : [];
    const key = row => params.p_kind === "roles" ? [row.cohort_key, row.scope_key, row.source_role] : row.id;
    const tail = all.filter(row => params.p_after === null || compare(key(row), params.p_after) > 0);
    const entries = tail.slice(0, params.p_limit);
    return { data: { schema: "awardping.program-text-worker-roster-page.v1", roster_seal: seal,
      role_count: roles.length, source_count: new Set(roles.flatMap(role => role.source_ids)).size,
      cohort_count: new Set(roles.map(role => role.cohort_key)).size, entries,
      next_cursor: tail.length > entries.length ? key(entries.at(-1)) : null } };
  };
}

function compare(a, b) {
  const left = Array.isArray(a) ? a : [a], right = Array.isArray(b) ? b : [b];
  for (let i = 0; i < left.length; i++) if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
  return 0;
}
