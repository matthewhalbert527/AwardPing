import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../supabase/migrations/20260717025000_harden_award_work_items_tenant_binding.sql",
    import.meta.url,
  ),
  "utf8",
);
const noteRoute = readFileSync(
  new URL("../src/app/api/awards/[id]/notes/route.ts", import.meta.url),
  "utf8",
);
const taskRoute = readFileSync(
  new URL("../src/app/api/awards/[id]/tasks/route.ts", import.meta.url),
  "utf8",
);
const taskMutationRoute = readFileSync(
  new URL("../src/app/api/awards/[id]/tasks/[taskId]/route.ts", import.meta.url),
  "utf8",
);

describe("award work-item tenant binding migration", () => {
  it("fails closed on legacy cross-office relationships", () => {
    expect(migration).toContain(
      "where note.office_id is distinct from award.office_id",
    );
    expect(migration).toContain(
      "where task.office_id is distinct from award.office_id",
    );
    expect(migration).toContain(
      "Cross-office award notes or tasks require reviewed manual repair.",
    );
    expect(migration).toContain(
      "Cross-office award note authors or task assignees require reviewed manual repair.",
    );
  });

  it("binds every award and member reference to the child office", () => {
    expect(migration).toContain("constraint office_members_id_office_id_key unique (id, office_id)");

    for (const constraint of [
      "award_notes_award_office_fkey",
      "award_notes_author_member_office_fkey",
      "award_tasks_award_office_fkey",
      "award_tasks_assigned_member_office_fkey",
    ]) {
      expect(migration).toContain(`constraint ${constraint}`);
    }

    expect(migration.match(/foreign key \(award_id, office_id\)/g)).toHaveLength(2);
    expect(migration).toContain("foreign key (author_member_id, office_id)");
    expect(migration).toContain("foreign key (assigned_member_id, office_id)");
    expect(migration).toContain("on delete set null (author_member_id)");
    expect(migration).toContain("on delete set null (assigned_member_id)");
  });

  it("retires handcrafted browser mutations while preserving member reads", () => {
    for (const policy of [
      "award notes created by office members",
      "award tasks created by office members",
      "award tasks editable by office members",
    ]) {
      expect(migration).toContain(`drop policy if exists "${policy}"`);
    }

    for (const table of ["award_notes", "award_tasks"]) {
      expect(migration).toContain(`revoke all on table public.${table} from anon;`);
      expect(migration).toContain(
        `on table public.${table} from authenticated;`,
      );
      expect(migration).toContain(
        `grant select on table public.${table} to authenticated;`,
      );
      expect(migration).toContain(
        `grant select, insert, update, delete on table public.${table} to service_role;`,
      );
    }
  });

  it("keeps all application mutations same-origin and tenant-scoped", () => {
    for (const route of [noteRoute, taskRoute, taskMutationRoute]) {
      expect(route).toContain("isSameOriginMutationRequest(request)");
      expect(route).toContain("getAwardAndMembership(user.id, id)");
      expect(route).toContain("createSupabaseAdminClient");
    }

    expect(noteRoute).toContain("office_id: result.award.office_id!");
    expect(taskRoute).toContain("office_id: result.award.office_id!");
    expect(taskMutationRoute).toContain('.eq("award_id", id)');
    expect(taskMutationRoute).toContain(
      '.eq("office_id", result.award.office_id!)',
    );
  });
});
