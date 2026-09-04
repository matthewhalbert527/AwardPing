import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadModule, parseSync } from "libpg-query";

const migration = readFileSync(
  new URL(
    "../supabase/migrations/20260814223000_order_stage1_activation_release_locks.sql",
    import.meta.url,
  ),
  "utf8",
);
const smoke = readFileSync(
  new URL(
    "../supabase/tests/stage1_activation_release_lock_order_smoke.sql",
    import.meta.url,
  ),
  "utf8",
);
const workflow = readFileSync(
  new URL("../.github/workflows/supabase-migration-smoke.yml", import.meta.url),
  "utf8",
);
const workflowLines = workflow.replace(/\r\n?/g, "\n").split("\n");

// Line-level readers for the workflow's trigger block. Blocks are isolated by
// indentation, keys are read at one exact indent, and every heading must
// occur exactly once, so a duplicated key fails instead of being overwritten.
function blockUnder(lines, indent, key) {
  const heading = `${" ".repeat(indent)}${key}:`;
  expect(lines.filter((line) => line === heading), heading).toHaveLength(1);
  const start = lines.indexOf(heading) + 1;
  let end = start;
  while (end < lines.length && (lines[end] === "" || lines[end].startsWith(`${" ".repeat(indent)} `))) {
    end += 1;
  }
  return lines.slice(start, end).filter((line) => line !== "");
}

function keysAt(lines, indent) {
  const prefix = " ".repeat(indent);
  return lines
    .filter((line) => line.startsWith(prefix) && !line.startsWith(`${prefix} `) && line.endsWith(":"))
    .map((line) => line.slice(prefix.length, -1));
}

function quotedListAt(lines, indent) {
  const prefix = `${" ".repeat(indent)}- "`;
  for (const line of lines) {
    expect(line.startsWith(prefix) && line.endsWith('"'), `quoted list item: ${line}`).toBe(true);
  }
  return lines.map((line) => line.slice(prefix.length, -1));
}

describe("Stage 1 activation release-lock order migration", () => {
  it("is parseable PostgreSQL and changes no tables or application rows", async () => {
    await loadModule();
    expect(() => parseSync(migration)).not.toThrow();
    expect(() => parseSync(smoke)).not.toThrow();
    expect(migration).not.toMatch(
      /^\s*(?:insert|update|delete|truncate)\b|^\s*(?:create|alter|drop)\s+table\b/imu,
    );
    expect(smoke).not.toMatch(
      /^\s*(?:insert|update|delete|truncate)\b|^\s*(?:create|alter|drop)\s+table\b/imu,
    );
  });

  it("patches only finalize and fail through a reversible exact body delta", () => {
    for (const signature of [
      "public.finalize_stage1_source_baseline_activation(uuid,uuid,text,text,text,jsonb)",
      "public.fail_stage1_source_baseline_activation(uuid,uuid,uuid,text,jsonb)",
    ]) {
      expect(migration).toContain(signature);
    }
    expect(migration.match(/execute v_updated;/g)).toHaveLength(2);
    expect(
      migration.match(
        /pg_catalog\.replace\(v_updated, v_replacement, v_anchor\)/g,
      ),
    ).toHaveLength(2);
    expect(migration.match(/v_after_contract is distinct from v_before_contract/g)).toHaveLength(2);
    expect(migration.match(/pg_catalog\.pg_get_functiondef\(v_function_oid\) is distinct from/g)).toHaveLength(2);
    expect(migration).not.toMatch(/record_stage1_source_baseline_activation/);
    expect(migration).not.toMatch(/prepare_stage1/i);
    expect(migration).not.toMatch(/drop\s+function|set\s+schema|rename\s+to/i);
  });

  it("places the shared global lock before validation and the acquisition lock", () => {
    const firstStatement =
      "begin\\n  perform pg_catalog.pg_advisory_xact_lock(\\n    pg_catalog.hashtextextended(''stage1-national-25-release'', 0)\\n  );\\n\\n  if p_source_id is null";
    expect(migration.match(new RegExp(firstStatement.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"))).toHaveLength(3);
    expect(migration.match(/v_global_key\) >=/g)).toHaveLength(5);
    expect(migration).toContain(
      "'stage1-baseline-activation:'' || p_acquisition_id::text",
    );
    expect(smoke).toContain(
      "does not acquire the release lock before validation, acquisition locking, and source-row locking",
    );
  });

  it("retains service-only SECURITY DEFINER boundaries and smokes role entry", () => {
    for (const assertion of [
      "pg_catalog.pg_get_userbyid(candidate.proowner) = 'postgres'",
      "candidate.provolatile = 'v'",
      "candidate.prosecdef",
      "array['search_path=\"\"']::text[]",
      "privilege.grantee = 0",
      "privilege.grantee not in (",
    ]) {
      expect(migration).toContain(assertion);
      expect(smoke).toContain(assertion);
    }
    for (const role of ["service_role", "anon", "authenticated"]) {
      expect(migration).toMatch(
        new RegExp(`has_function_privilege\\(\\s*'${role}'`),
      );
      expect(smoke).toMatch(
        new RegExp(`has_function_privilege\\(\\s*'${role}'`),
      );
    }
    expect(smoke).toContain("set role anon;");
    expect(smoke).toContain("set role authenticated;");
    expect(smoke).toContain("set role service_role;");
    expect(smoke.match(/reset role;/g)).toHaveLength(3);
    expect(smoke.match(/exception when insufficient_privilege/g)).toHaveLength(4);
    expect(smoke.match(/exception when sqlstate '22023'/g)).toHaveLength(2);
  });

  it("wires static, rollback, and SQL smoke checks into migration CI", () => {
    expect(workflow).toContain(
      "scripts/stage1-activation-release-lock-order-migration.test.mjs",
    );
    expect(workflow).toContain(
      "scripts/stage1-activation-release-lock-order-rollback-probe.test.mjs",
    );
    expect(workflow).toContain(
      "--file=supabase/tests/stage1_activation_release_lock_order_smoke.sql",
    );
  });

  it("runs on pushes to redesign/ui-overhaul with the pull_request path filters", () => {
    const on = blockUnder(workflowLines, 0, "on");
    expect(keysAt(on, 2)).toEqual(["push", "pull_request", "workflow_dispatch"]);
    expect(blockUnder(on, 2, "workflow_dispatch")).toEqual([]);

    const push = blockUnder(on, 2, "push");
    const pullRequest = blockUnder(on, 2, "pull_request");
    expect(keysAt(push, 4)).toEqual(["branches", "paths"]);
    expect(keysAt(pullRequest, 4)).toEqual(["paths"]);
    expect(quotedListAt(blockUnder(push, 4, "branches"), 6)).toEqual(["redesign/ui-overhaul"]);

    const pushPaths = quotedListAt(blockUnder(push, 4, "paths"), 6);
    expect(pushPaths).toEqual(quotedListAt(blockUnder(pullRequest, 4, "paths"), 6));
    expect(pushPaths).toEqual([
      ".github/workflows/supabase-migration-smoke.yml",
      "package.json",
      "package-lock.json",
      "scripts/**",
      "supabase/config.toml",
      "supabase/migrations/**",
      "supabase/tests/**",
    ]);
  });
});
