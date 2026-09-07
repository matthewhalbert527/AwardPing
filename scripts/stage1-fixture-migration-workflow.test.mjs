import { readFileSync } from "node:fs";
import { load } from "js-yaml";
import { describe, expect, it } from "vitest";

const text = readFileSync(new URL("../.github/workflows/stage1-fixture-migration-smoke.yml", import.meta.url), "utf8");
const workflow = load(text);
const gate = "${{ (github.event_name == 'push' && contains(github.event.head_commit.message, '[fixture-replay]')) || (github.event_name == 'workflow_dispatch' && inputs.fixture_replay == true) }}";

describe("explicitly opted-in fixture-assisted CI", () => {
  it("limits push runs to this isolated branch and all relevant test inputs", () => {
    expect(Object.keys(workflow.on)).toEqual(["push", "workflow_dispatch"]);
    expect(workflow.on.push.branches).toEqual(["claude/overnight-supervised-20260903"]);
    expect(workflow.on.push.paths).toEqual([
      ".github/workflows/stage1-fixture-migration-smoke.yml", "package.json", "package-lock.json",
      "vitest.config.ts", "docs/stage1-fixture-migration-smoke.md",
      "scripts/run-stage1-fixture-migration-smoke*.mjs", "scripts/stage1-identity-v3-prerequisite-fixture.test.mjs",
      "scripts/stage1-fixture-migration-workflow.test.mjs", "src/lib/stage1-cohort-identity.ts",
      "supabase/config.toml", "supabase/migrations/**", "supabase/tests/**",
    ]);
    expect(workflow.on.workflow_dispatch.inputs).toEqual({ fixture_replay: {
      description: "Start and destroy a disposable test-only database (not production)",
      type: "boolean", required: false, default: false,
    } });
  });

  it("requires the explicit marker or typed opt-in on every job and tests before execution", () => {
    expect(Object.keys(workflow.jobs)).toEqual(["fixture-contract-tests", "fixture-assisted-replay"]);
    for (const job of Object.values(workflow.jobs)) {
      expect(job.if).toBe(gate);
      expect(job["runs-on"]).toBe("ubuntu-latest");
      expect(job["timeout-minutes"]).toBeLessThanOrEqual(20);
    }
    expect(workflow.jobs["fixture-assisted-replay"].needs).toBe("fixture-contract-tests");
  });

  it("has read-only repository permissions, no persisted auth, secrets or deploy commands", () => {
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(text).not.toMatch(/secrets\.|--linked|--db-url|--include-all|supabase (?:link|login|db push|migration repair)|vercel|environment:/i);
    for (const job of Object.values(workflow.jobs)) {
      expect(job.permissions).toBeUndefined();
      expect(job.env).toBeUndefined();
      expect(job.steps[0]).toEqual({ uses: "actions/checkout@v4", with: { "persist-credentials": false } });
      for (const step of job.steps) {
        expect(step.env).toBeUndefined();
        expect(step.run ?? "").not.toContain("${{");
      }
    }
  });

  it("pins tools, plans first and delegates all DB execution/cleanup to the guarded runner", () => {
    const steps = workflow.jobs["fixture-assisted-replay"].steps;
    expect(steps[1]).toEqual({ uses: "actions/setup-node@v4", with: { "node-version": 22 } });
    expect(steps[2]).toMatchObject({ uses: "supabase/setup-cli@v1", with: { version: "2.109.1" } });
    expect(steps.filter((step) => step.run).map((step) => step.run)).toEqual([
      "if ! command -v psql >/dev/null 2>&1; then\n  sudo apt-get update\n  sudo apt-get install --yes postgresql-client\nfi\n",
      "node scripts/run-stage1-fixture-migration-smoke.mjs --plan",
      "node scripts/run-stage1-fixture-migration-smoke.mjs --execute-disposable-local",
    ]);
    const tests = workflow.jobs["fixture-contract-tests"].steps.at(-1).run;
    for (const path of ["run-stage1-fixture-migration-smoke", "stage1-identity-v3-prerequisite-fixture", "stage1-fixture-migration-workflow"]) {
      expect(tests).toContain(`scripts/${path}.test.mjs`);
    }
  });
});
