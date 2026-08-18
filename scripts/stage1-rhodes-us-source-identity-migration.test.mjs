import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../supabase/migrations/20260717114500_rhodes_us_source_identity_fence.sql",
    import.meta.url,
  ),
  "utf8",
);
const readiness = readFileSync(
  new URL("./lib/stage1-cohort-readiness.mjs", import.meta.url),
  "utf8",
);

describe("Rhodes (US) source-identity fence migration", () => {
  it("installs the same permanent exclusion identity in SQL and readiness fallback", () => {
    for (const source of [migration, readiness]) {
      expect(source).toContain("exclude_rhodes_non_us_constituencies");
      expect(source).toContain("canada|canadian");
      expect(source).toContain("united[-_]?kingdom");
      expect(source).toContain(
        "A country- or constituency-specific Rhodes source outside the United States cannot supply Rhodes (US) facts or updates.",
      );
    }
    expect(migration).toContain("on conflict (cohort_key, rule_key) do update");
    expect(migration).toContain("policy_version = excluded.policy_version");
  });

  it("proves the database regex blocks Canada but preserves the US source", () => {
    expect(migration).toContain(
      "canada-information-for-candidates-2027.pdf'\n      ~* v_url_pattern",
    );
    expect(migration).toContain(
      "'Rhodes Scholarship Canada Information for Candidates'\n      ~* v_title_pattern",
    );
    expect(migration).toContain(
      "'https://www.rhodeshouse.ox.ac.uk/files/usainformationforcandidates/'\n      ~* v_url_pattern",
    );
    expect(migration).toContain(
      "'Rhodes Scholarship USA Information for Candidates'\n      ~* v_title_pattern",
    );
    expect(migration).toContain(
      "The Rhodes (US) source-identity fence failed its country-specific postcondition.",
    );
  });
});
