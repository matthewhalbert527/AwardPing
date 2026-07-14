import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../supabase/migrations/20260714195500_add_monitoring_worker_state.sql",
    import.meta.url,
  ),
  "utf8",
);
const foreignKeyIndexMigration = readFileSync(
  new URL(
    "../supabase/migrations/20260714223500_index_visual_rejection_candidate_fk.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("monitoring worker state migration", () => {
  it("serializes publication and baseline side effects per source", () => {
    expect(migration).toContain("add column if not exists publication_claim_token text");
    expect(migration).toContain("add column if not exists publication_claimed_at timestamptz");
    expect(migration).toContain(
      "shared_award_visual_review_candidates_source_publication_claim_idx",
    );
    expect(migration).toContain(
      "on public.shared_award_visual_review_candidates (shared_award_source_id)",
    );
    expect(migration).toContain("where publication_claim_token is not null");
    expect(migration).toContain("advance_shared_award_visual_snapshot");
    expect(migration).toContain("and updated_at = p_expected_updated_at");
    expect(migration).toContain("latest_captured_at <= v_latest_captured_at");
    expect(migration).toContain("on conflict (shared_award_source_id) do nothing");
    expect(migration).toContain("security invoker");
    expect(migration).not.toContain("security definer");
    expect(migration).toContain(
      "revoke all on function public.advance_shared_award_visual_snapshot(boolean, timestamptz, jsonb)",
    );
    expect(migration).toContain(
      "grant execute on function public.advance_shared_award_visual_snapshot(boolean, timestamptz, jsonb)",
    );
  });

  it("creates a policy-versioned rejected-evidence ledger", () => {
    expect(migration).toContain(
      "create table if not exists public.shared_award_visual_rejection_ledger",
    );
    expect(migration).toContain(
      "unique (shared_award_source_id, evidence_signature, policy_hash)",
    );
    expect(migration).toContain(
      "candidate_id uuid references public.shared_award_visual_review_candidates(id) on delete set null",
    );
    expect(migration).toContain(
      "shared_award_source_id uuid not null references public.shared_award_sources(id) on delete cascade",
    );
    expect(foreignKeyIndexMigration).toContain(
      "shared_award_visual_rejection_ledger_candidate_idx",
    );
    expect(foreignKeyIndexMigration).toContain(
      "on public.shared_award_visual_rejection_ledger (candidate_id)",
    );
    expect(foreignKeyIndexMigration).toContain("where candidate_id is not null");
  });

  it("creates a paired timestamp-and-id cursor for bounded retro sweeps", () => {
    expect(migration).toContain(
      "create table if not exists public.monitoring_policy_sweep_state",
    );
    expect(migration).toContain("cursor_detected_at timestamptz");
    expect(migration).toContain("cursor_event_id uuid");
    expect(migration).toContain("monitoring_policy_sweep_cursor_pair_check");
    expect(migration).toContain(
      "shared_award_change_events_unsuppressed_sweep_idx",
    );
    expect(migration).toContain(
      "on public.shared_award_change_events (detected_at, id)",
    );
    expect(migration).toContain("where suppressed_at is null");
  });

  it.each([
    "shared_award_visual_rejection_ledger",
    "monitoring_policy_sweep_state",
  ])("keeps %s service-role-only", (table) => {
    expect(migration).toContain(`alter table public.${table} enable row level security;`);
    expect(migration).toContain(
      `revoke all on table public.${table} from public, anon, authenticated;`,
    );
    expect(migration).toContain(`grant all on table public.${table} to service_role;`);
  });
});
