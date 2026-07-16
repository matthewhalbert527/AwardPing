import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = new URL("../", import.meta.url);

function read(relativePath) {
  return readFileSync(new URL(relativePath, root), "utf8");
}

describe("private-beta initial official-document migration gate", () => {
  it("requires the exact migration and its critical tables and RPCs", () => {
    const launchCheck = read("scripts/check-private-beta.mjs");

    expect(launchCheck).toContain(
      "20260716150000_initial_official_document_events.sql",
    );

    for (const table of [
      "shared_award_source_acquisitions",
      "shared_award_source_discovery_states",
      "shared_award_source_discovered_links",
    ]) {
      expect(launchCheck).toContain(`"${table}"`);
    }

    for (const rpc of [
      "register_shared_award_source_pdf_links",
      "bind_shared_award_discovered_link_request",
      "create_and_bind_shared_award_discovered_link_request",
      "record_shared_award_discovered_link_quarantine",
      "resolve_shared_award_discovered_link_quarantine",
      "register_shared_award_source_from_intake",
      "publish_shared_award_initial_document_event",
      "record_initial_official_document_quarantine",
      "resolve_initial_official_document_quarantine",
    ]) {
      expect(launchCheck).toContain(`"${rpc}"`);
    }

    for (const safetyContract of [
      "p_actor_user_id uuid",
      "p_expected_evidence_hash text",
      "v_quarantine.status <> 'in_review'",
      "v_quarantine.evidence_hash is distinct from p_expected_evidence_hash",
      "v_assignment.assigned_to_user_id is distinct from p_actor_user_id",
      "v_assignment.assigned_to_email is distinct from v_actor",
    ]) {
      expect(launchCheck).toContain(safetyContract);
    }

    expect(launchCheck).toContain(
      "Initial official-document migration is incomplete",
    );
  });

  it("recognizes the checked-in migration as launch-ready", () => {
    const result = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL("scripts/check-private-beta.mjs", root)),
        "--env",
        ".missing-private-beta-gate-test-env",
      ],
      {
        cwd: fileURLToPath(root),
        encoding: "utf8",
      },
    );

    expect(result.error).toBeUndefined();
    expect(result.stdout).toContain(
      "OK     Migration 20260716150000_initial_official_document_events.sql is present.",
    );
    expect(result.stdout).toContain(
      "OK     Migration 20260716152833_source_intake_fact_candidate_idempotency.sql is present.",
    );
    expect(result.stdout).toContain(
      "OK     Initial official-document migration includes immutable intake provenance, discovery state, publication, and quarantine surfaces.",
    );
    expect(result.stdout).toContain(
      "OK     Source-intake fact replay migration includes stable request/field/value identity and uniqueness guards.",
    );
  });

  it("requires every migration in filename order and explicitly names the new migration", () => {
    const runbook = read("docs/private-beta-launch.md");

    expect(runbook).toContain("run **every** `.sql` file currently present");
    expect(runbook).toContain("in filename order");
    expect(runbook).toContain("Do not stop at `0007_shared_award_catalog.sql`");
    expect(runbook).toContain(
      "`20260716150000_initial_official_document_events.sql`",
    );
    expect(runbook).toContain(
      "`20260716152833_source_intake_fact_candidate_idempotency.sql`",
    );
    expect(runbook).toContain("migration list --linked");
    expect(runbook).not.toContain(
      "run `supabase/migrations/0001_initial.sql` through `0007_shared_award_catalog.sql`",
    );
  });
});
