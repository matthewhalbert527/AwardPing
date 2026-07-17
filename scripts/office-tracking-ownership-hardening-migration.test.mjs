import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../supabase/migrations/20260717022006_harden_office_tracking_ownership.sql",
    import.meta.url,
  ),
  "utf8",
);
const awardIntakeRoute = readFileSync(
  new URL("../src/app/api/awards/route.ts", import.meta.url),
  "utf8",
);
const monitorIntakeRoute = readFileSync(
  new URL("../src/app/api/monitors/route.ts", import.meta.url),
  "utf8",
);
const monitorMutationRoute = readFileSync(
  new URL("../src/app/api/monitors/[id]/route.ts", import.meta.url),
  "utf8",
);
const awardWorkflowRoute = readFileSync(
  new URL("../src/app/api/awards/[id]/workflow/route.ts", import.meta.url),
  "utf8",
);
const consolidation = functionBody(
  "private.consolidate_office_award_tracking",
  "revoke all on function private.consolidate_office_award_tracking",
);
const sourceIntake = functionBody(
  "public.create_office_award_tracking_from_intake",
  "revoke all on function public.create_office_award_tracking_from_intake",
);

describe("office tracking ownership hardening migration", () => {
  it("denies raw browser-role DML and removes every legacy bypass policy", () => {
    for (const policy of [
      "awards are user owned",
      "award sources are user owned",
      "monitors are user owned",
      "awards workflow editable by office members",
    ]) {
      expect(migration).toContain(`drop policy if exists "${policy}"`);
    }

    for (const table of ["awards", "award_sources", "monitors"]) {
      expect(migration).toContain(
        `revoke insert, update, delete, truncate, references, trigger\n  on table public.${table} from anon, authenticated;`,
      );
      expect(migration).toContain(
        `grant select, insert, update, delete on table public.${table} to service_role;`,
      );
    }

    expect(migration).toMatch(
      /revoke all on function public\.create_office_award_tracking_from_intake\([\s\S]*?from public, anon, authenticated, service_role;/,
    );
    expect(migration).toMatch(
      /grant execute on function public\.create_office_award_tracking_from_intake\([\s\S]*?to service_role;/,
    );
    expect(migration).not.toMatch(
      /grant execute on function public\.create_office_award_tracking_from_intake\([\s\S]*?to (?:anon|authenticated|public);/,
    );
  });

  it("keeps office history alive when its creator auth user is deleted", () => {
    for (const [table, column, constraint] of [
      ["awards", "user_id", "awards_user_id_fkey"],
      ["award_sources", "user_id", "award_sources_user_id_fkey"],
      ["monitors", "user_id", "monitors_user_id_fkey"],
      ["award_notes", "author_user_id", "award_notes_author_user_id_fkey"],
      ["award_tasks", "created_by_user_id", "award_tasks_created_by_user_id_fkey"],
    ]) {
      expect(migration).toContain(`alter column ${column} drop not null`);
      expect(migration).toContain(`add constraint ${constraint}`);
      expect(migration).toMatch(
        new RegExp(
          `alter table public\\.${table}[\\s\\S]*?foreign key \\(${column}\\) references auth\\.users\\(id\\) on delete set null;`,
        ),
      );
    }

    for (const table of ["awards", "award_sources", "monitors"]) {
      expect(migration).toMatch(
        new RegExp(`alter table public\\.${table}[\\s\\S]*?alter column office_id set not null`),
      );
    }
    expect(migration).toContain("foreign key (award_id, office_id)");
    expect(migration).toContain("on delete set null (award_id)");
  });

  it("fails closed instead of transferring legacy cross-office rows", () => {
    expect(migration).not.toContain(
      "set office_id = award.office_id\nfrom public.awards award\nwhere source.award_id = award.id\n  and source.office_id is distinct from award.office_id",
    );
    expect(migration).not.toContain(
      "set office_id = award.office_id\nfrom public.awards award\nwhere monitor.award_id = award.id\n  and monitor.office_id is distinct from award.office_id",
    );
    expect(migration).toContain(
      "Cross-office award tracking relationships require reviewed manual repair.",
    );
    expect(migration).toContain(
      "where source.office_id is distinct from award.office_id",
    );
    expect(migration).toContain(
      "where monitor.office_id is distinct from award.office_id",
    );
  });

  it("preserves immutable event attribution with detached monitor tombstones", () => {
    expect(consolidation).toContain("update public.monitor_snapshots");
    expect(consolidation).toContain("update public.change_events");
    expect(consolidation).toContain("event.first_reported_by_monitor_id = v_duplicate.duplicate_id");
    expect(consolidation).toContain("set award_id = null");
    expect(consolidation).toContain("status = 'paused'");
    expect(consolidation).not.toContain("update public.shared_award_change_events");
    expect(consolidation.indexOf("update public.monitor_snapshots"))
      .toBeLessThan(consolidation.indexOf("set award_id = null"));
    expect(consolidation.indexOf("update public.change_events"))
      .toBeLessThan(consolidation.indexOf("set award_id = null"));
  });

  it("keeps source intake transactional and server-only after revoking raw DML", () => {
    expect(sourceIntake).toContain("security definer");
    expect(sourceIntake).toContain("set search_path = ''");
    expect(sourceIntake).toContain("member.office_id = p_office_id");
    expect(sourceIntake).toContain("member.user_id = p_actor_user_id");
    expect(sourceIntake).toContain("member.role in ('owner', 'admin')");
    expect(sourceIntake).toContain("pg_advisory_xact_lock");
    expect(sourceIntake).toContain("insert into public.awards");
    expect(sourceIntake).toContain("insert into public.award_sources");
    expect(sourceIntake).toContain("insert into public.monitors");

    expect(awardIntakeRoute).toContain("isSameOriginMutationRequest(request)");
    expect(awardIntakeRoute).toContain(
      'admin.rpc(\n    "create_office_award_tracking_from_intake"',
    );
    expect(awardIntakeRoute).not.toContain("createSupabaseServerClient");
    expect(monitorIntakeRoute).toContain("isSameOriginMutationRequest(request)");
    expect(monitorIntakeRoute).toContain("createSupabaseAdminClient");
    expect(monitorIntakeRoute).not.toContain("createSupabaseServerClient");
  });

  it("preserves monitor history and guards every reviewed office mutation", () => {
    for (const route of [monitorMutationRoute, awardWorkflowRoute]) {
      expect(route).toContain("isSameOriginMutationRequest(request)");
    }
    expect(monitorMutationRoute).not.toContain(".delete()");
    expect(monitorMutationRoute).toContain("award_id: null");
    expect(monitorMutationRoute).toContain('status: "paused"');
    expect(monitorMutationRoute).toContain('.eq("office_id", monitor.office_id)');
    expect(awardWorkflowRoute).toContain(
      '.eq("office_id", result.award.office_id!)',
    );
  });

  it("removes the divergent unused JavaScript consolidation model", () => {
    expect(
      existsSync(new URL("../src/lib/office-award-consolidation.ts", import.meta.url)),
    ).toBe(false);
    expect(
      existsSync(new URL("../src/lib/office-award-consolidation.test.ts", import.meta.url)),
    ).toBe(false);
  });
});

function functionBody(startName, endMarker) {
  const start = migration.indexOf(`create or replace function ${startName}(`);
  const end = migration.indexOf(endMarker, start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return migration.slice(start, end);
}
