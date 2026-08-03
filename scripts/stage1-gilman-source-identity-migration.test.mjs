import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../supabase/migrations/20260717114600_gilman_source_identity_fence.sql",
    import.meta.url,
  ),
  "utf8",
);
const readiness = readFileSync(
  new URL("./lib/stage1-cohort-readiness.mjs", import.meta.url),
  "utf8",
);

describe("Gilman source-identity fence migration", () => {
  it("installs the same distinct-program exclusion in SQL and readiness fallback", () => {
    for (const source of [migration, readiness]) {
      expect(source).toContain("exclude_gilman_mccain");
      expect(source).toContain("gilman[-_]?mccain|gilmanmccain");
      expect(source).toContain(
        "Gilman-McCain is a distinct scholarship and cannot supply Benjamin A. Gilman International Scholarship facts or updates.",
      );
    }
    expect(migration).toContain("on conflict (cohort_key, rule_key) do update");
    expect(migration).toContain("policy_version = excluded.policy_version");
  });

  it("proves the database regex blocks Gilman-McCain and preserves Gilman", () => {
    expect(migration).toContain(
      "'https://www.gilmanscholarship.org/program/gilman-mccain-scholarships/'\n      ~* v_url_pattern",
    );
    expect(migration).toContain(
      "not ('Gilman-McCain Scholarship eligibility' ~* v_title_pattern)",
    );
    expect(migration).toContain(
      "'https://www.gilmanscholarship.org/applicants/eligibility/'\n      ~* v_url_pattern",
    );
    expect(migration).toContain(
      "'Gilman Scholarship eligibility' ~* v_title_pattern",
    );
  });
});
