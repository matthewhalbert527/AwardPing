import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { awardSeeds } from "../src/lib/award-seeds.ts";
import { awardSourceOverrides } from "../src/lib/award-source-overrides.ts";
import { stage1CohortIdentity } from "../src/lib/stage1-cohort-identity.ts";
import { STAGE1_COHORT_DEFINITION } from "./lib/stage1-cohort-readiness.mjs";
import { buildPostStage1ExpansionPlan } from "./lib/post-stage1-expansion-plan.mjs";

/**
 * The offline report CLI around the existing expansion-plan builder.
 *
 * These tests drive the real script in a child process, with the real
 * candidate config, seeds, overrides and the exact 25-entry Stage 1 identity
 * projection, so the receipts describe the shipped command rather than an
 * in-process imitation. Nothing here approves a candidate: the builder pins
 * every lifecycle field, and the assertions below check that the report
 * carries those pinned values through unchanged.
 */

const REPO = resolve(import.meta.dirname, "..");
const SCRIPT = resolve(import.meta.dirname, "report-post-stage1-expansion-plan.mjs");
const CONFIG_PATH = resolve(REPO, "config", "post-stage1-expansion-candidates.json");

function runCli(args, { cwd = REPO, input } = {}) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd,
    windowsHide: true,
    timeout: 30_000,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    input,
  });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/**
 * The exact real cohort, joined from the two real sources on the shared
 * cohort key, exactly as the builder's own suite assembles it. This is the
 * only shape the builder's anchoring check accepts.
 */
function realStage1Identity() {
  const identityByCohortKey = new Map(stage1CohortIdentity.map((row) => [row[1], row]));
  return STAGE1_COHORT_DEFINITION.map((cohort) => ({
    cohortKey: cohort.cohortKey,
    canonicalName: cohort.canonicalName,
    canonicalSearchKey: cohort.canonicalSearchKey,
    aliasSearchKeys: cohort.aliasSearchKeys,
    canonicalSlug: identityByCohortKey.get(cohort.cohortKey)[4],
    officialHomepage: cohort.officialHomepage,
  }));
}

function realInput() {
  return {
    config: JSON.parse(readFileSync(CONFIG_PATH, "utf8")),
    seeds: awardSeeds,
    overrides: awardSourceOverrides,
    stage1Identity: realStage1Identity(),
  };
}

let workDir = "";
let inputPath = "";
let realText = "";

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "awardping-expansion-report-"));
  realText = JSON.stringify(realInput());
  inputPath = join(workDir, "expansion-input.json");
  await writeFile(inputPath, realText, "utf8");
});

afterAll(async () => {
  if (!workDir) return;
  const target = resolve(workDir);
  const parent = resolve(tmpdir());
  if (dirname(target) !== parent || !basename(target).startsWith("awardping-expansion-report-") || target === parent) {
    throw new Error("Refusing cleanup outside the generated test directory");
  }
  await rm(target, { recursive: true, force: true });
});

describe("post-Stage-1 expansion plan report", () => {
  it("reports the current Mitchell and Tillman candidates from the real fixtures", () => {
    const run = runCli(["--input", inputPath]);
    expect(run.status, run.stderr).toBe(0);

    const report = JSON.parse(run.stdout);
    expect(report.plan).toEqual(buildPostStage1ExpansionPlan(realInput()));
    expect(report.plan.plans.map((plan) => plan.candidateId)).toEqual(["mitchell", "tillman"]);
    expect(report.plan.totals.candidates).toBe(2);
  });

  it("produces byte-identical output from a file and from stdin", () => {
    const viaFile = runCli(["--input", inputPath]);
    const viaStdin = runCli(["--input", "-"], { input: realText });
    expect(viaStdin.status, viaStdin.stderr).toBe(0);
    expect(viaStdin.stdout).toBe(viaFile.stdout);
  });

  it("is deterministic across repeated runs", () => {
    expect(runCli(["--input", inputPath]).stdout).toBe(runCli(["--input", inputPath]).stdout);
  });

  it("carries every pinned lifecycle field through unchanged", () => {
    const report = JSON.parse(runCli(["--input", inputPath]).stdout);
    for (const plan of report.plan.plans) {
      expect(plan.lifecycle, plan.candidateId).toEqual({
        currentCycleAuthority: "unresolved",
        humanSourceReview: "unresolved",
        remoteIdentityCollisionCheck: "unresolved",
        monitoringReadiness: false,
        publicationEligibility: false,
      });
      expect(typeof plan.planHash, plan.candidateId).toBe("string");
    }
  });

  it("states that a successful report approves nothing", () => {
    const report = JSON.parse(runCli(["--input", inputPath]).stdout);
    expect(report.reviewStatus).toBe("offline_review_only_not_approved");
    const disclaimers = JSON.stringify(report.disclaimers);
    for (const phrase of [
      "unverified source candidates",
      "current-cycle authority",
      "human review",
      "monitoring",
      "publication",
    ]) {
      expect(disclaimers, phrase).toContain(phrase);
    }
  });

  it("runs the same from an unrelated working directory", () => {
    const fromRepo = runCli(["--input", inputPath]);
    const fromElsewhere = runCli(["--input", inputPath], { cwd: workDir });
    expect(fromElsewhere.status, fromElsewhere.stderr).toBe(0);
    expect(fromElsewhere.stdout).toBe(fromRepo.stdout);
  });

  it("prints usage for --help without needing an input", () => {
    const run = runCli(["--help"]);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("--input");
    expect(run.stdout).not.toContain("\"plan\"");
  });
});

describe("post-Stage-1 expansion plan report refuses bad invocations", () => {
  it.each([
    ["no arguments at all", []],
    ["an unknown option", ["--input", "-", "--format", "json"]],
    ["a repeated input", ["--input", "-", "--input", "-"]],
    ["a repeated help flag", ["--help", "--help"]],
    ["an input with no value", ["--input"]],
    ["an input followed by another option", ["--input", "--help"]],
    ["a bare positional argument", ["input.json"]],
  ])("exits non-zero with no output for %s", (_label, args) => {
    const run = runCli(args, { input: "" });
    expect(run.status).toBe(1);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("report-post-stage1-expansion-plan:");
  });

  it.each([
    ["text that is not JSON", "not json at all"],
    ["an empty document", ""],
    ["a JSON array", "[]"],
    ["JSON null", "null"],
    ["a truncated object", '{"config":'],
  ])("exits non-zero with no output for %s", (_label, text) => {
    const run = runCli(["--input", "-"], { input: text });
    expect(run.status).toBe(1);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("report-post-stage1-expansion-plan:");
  });

  it("exits non-zero when the input file does not exist", () => {
    const run = runCli(["--input", join(workDir, "absent-input.json")]);
    expect(run.status).toBe(1);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("report-post-stage1-expansion-plan:");
  });

  it.each([
    ["an empty candidate list", (input) => { input.config.candidates = []; }],
    ["a candidate with no matching seed", (input) => { input.config.candidates[0].awardName = "No Such Award Anywhere"; }],
    ["a Stage 1 identity that is one row short", (input) => { input.stage1Identity.pop(); }],
    ["a Stage 1 identity with an altered canonical name", (input) => { input.stage1Identity[0].canonicalName = "Altered Name"; }],
  ])("fails closed for %s", (_label, mutate) => {
    const input = realInput();
    mutate(input);
    const run = runCli(["--input", "-"], { input: JSON.stringify(input) });
    expect(run.status).toBe(1);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("report-post-stage1-expansion-plan:");
  });
});
