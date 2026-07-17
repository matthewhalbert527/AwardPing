import { existsSync, readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");

const discoveryRoute = readFileSync(
  new URL("../src/app/api/awards/discover/route.ts", import.meta.url),
  "utf8",
);
const launchCheck = readFileSync(
  new URL("./check-private-beta.mjs", import.meta.url),
  "utf8",
);
const summaryBackfill = readFileSync(
  new URL("./backfill-award-summaries.mjs", import.meta.url),
  "utf8",
);
const baselineFactsBackfill = source("scripts/backfill-baseline-facts.mjs");
const openSourceBackfill = source("scripts/backfill-open-source-ai-determinations.mjs");
const oneTimeCatchup = source("scripts/run-one-time-catchup.mjs");
const maintenance = source("scripts/run-awardping-maintenance.mjs");
const sourceTitleBackfill = source("scripts/backfill-source-page-titles.mjs");
const awardDetailsBackfill = source("scripts/backfill-award-baseline-details.mjs");
const capture = source("scripts/capture-visual-snapshots.mjs");
const captureAiRequirements = source("scripts/lib/capture-ai-requirements.mjs");
const pageAudit = source("scripts/process-page-audit-batch.mjs");
const adminMaintenance = source("src/lib/admin-maintenance.ts");
const maintenanceRoute = source("src/app/api/admin/maintenance-runs/route.ts");
const coverageReader = source("scripts/read-ai-review-coverage.mjs");
const supabaseConfig = source("supabase/config.toml");
const packageJson = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);

describe("paid provider surface", () => {
  it("retires the legacy discovery provider outside the two paid lanes", () => {
    expect(discoveryRoute).toContain("status: 410");
    expect(discoveryRoute).not.toMatch(/OPENAI_API_KEY|GEMINI_API_KEY/);
    expect(discoveryRoute).not.toContain("fetch(");
    expect(discoveryRoute).not.toContain("searchAwardCandidates");
    expect(discoveryRoute).not.toContain("classifyAwardCandidates");
  });

  it("does not require retired discovery-provider credentials for launch", () => {
    expect(launchCheck).not.toContain('["TAVILY_API_KEY"');
    expect(launchCheck).not.toContain('["OPENAI_API_KEY"');
  });

  it("retires the direct OpenAI summary backfill outside the paid lanes", () => {
    expect(packageJson.scripts["summary:backfill"]).toBeUndefined();
    expect(summaryBackfill).toContain("is retired and cannot submit provider work");
    expect(summaryBackfill).not.toContain("fetch(");
    expect(summaryBackfill).not.toContain("OPENAI_API_KEY");
  });

  it("removes unused direct provider helpers from the application bundle", () => {
    expect(
      existsSync(new URL("../src/lib/award-discovery.ts", import.meta.url)),
    ).toBe(false);
    expect(
      existsSync(new URL("../src/lib/change-details-ai.ts", import.meta.url)),
    ).toBe(false);
    expect(
      existsSync(new URL("../src/lib/discovery-rate-limit.ts", import.meta.url)),
    ).toBe(false);
  });

  it("keeps the complete provider-create code surface explicit and reviewable", () => {
    expect(providerCreateSurfaceFiles()).toEqual([
      "scripts/backfill-award-baseline-details.mjs",
      "scripts/backfill-baseline-facts.mjs",
      "scripts/capture-visual-snapshots.mjs",
      "scripts/lib/gemini-cli-analysis.mjs",
      "scripts/process-page-audit-batch.mjs",
      "scripts/process-source-intake-requests.mjs",
      "scripts/process-visual-review-batch.mjs",
    ]);
  });

  it("allows provider creation only in the two paid lane processors", () => {
    const authorized = [
      "scripts/process-source-intake-requests.mjs",
      "scripts/process-visual-review-batch.mjs",
    ];
    expect(
      authorized
        .map(source)
        .every((body) =>
          body.includes("reserveGeminiSpend") && body.includes("submitGeminiSpendReservation"),
        ),
    ).toBe(true);
    expect(source(authorized[0])).toContain("GEMINI_PAID_LANES.NEW_PAGE_REVIEW");
    expect(source(authorized[1])).toContain(
      "paidVisualReviewLaneForCandidate as paidReviewLaneForCandidate",
    );
  });

  it("retires the direct baseline-facts provider before any runtime setup", () => {
    const guard = baselineFactsBackfill.indexOf("const PAID_PROVIDER_ENTRYPOINT_RETIRED = true");
    expect(guard).toBeGreaterThan(0);
    expect(baselineFactsBackfill.indexOf("process.exit(2)", guard))
      .toBeLessThan(baselineFactsBackfill.indexOf("const root =", guard));
    expect(runScript("scripts/backfill-baseline-facts.mjs")).toMatchObject({
      status: 2,
      stderr: expect.stringContaining("is retired and cannot submit provider work"),
    });
  });

  it("allows open-source coverage reporting but refuses its legacy paid option", () => {
    const guard = openSourceBackfill.indexOf("const LEGACY_PAID_SUBMISSION_RETIRED = true");
    expect(guard).toBeGreaterThan(0);
    expect(openSourceBackfill.indexOf("process.exit(2)", guard))
      .toBeLessThan(openSourceBackfill.indexOf("writeReport();", guard));
    expect(
      runScript("scripts/backfill-open-source-ai-determinations.mjs", [
        "--apply=true",
        "--max-batch-requests=1",
      ], {
        NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
        SUPABASE_SERVICE_ROLE_KEY: "test-only-service-role",
      }),
    ).toMatchObject({
      status: 2,
      stderr: expect.stringContaining("can no longer submit paid provider work"),
    });
  });

  it("preserves catch-up forecasting but refuses catch-up apply before secrets or children", () => {
    const guard = oneTimeCatchup.indexOf("const PAID_CATCHUP_APPLY_RETIRED = true");
    expect(guard).toBeGreaterThan(0);
    expect(oneTimeCatchup.indexOf("process.exit(2)", guard))
      .toBeLessThan(oneTimeCatchup.indexOf("const envPath", guard));
    expect(runScript("scripts/run-one-time-catchup.mjs", ["--apply=true"])).toMatchObject({
      status: 2,
      stderr: expect.stringContaining("apply mode is retired"),
    });
  });

  it("rejects retired paid maintenance phases before a maintenance run starts", () => {
    expect(maintenance).toContain(
      'const retiredPaidPhases = new Set(["ai-review-completion", "baseline-facts"]);',
    );
    expect(maintenance).not.toContain('"scripts/backfill-baseline-facts.mjs"');
    expect(maintenance).not.toContain('"scripts/backfill-open-source-ai-determinations.mjs"');
    expect(
      runScript("scripts/run-awardping-maintenance.mjs", [
        "--profile=task",
        "--phases=baseline-facts",
      ]),
    ).toMatchObject({
      status: 2,
      stderr: expect.stringContaining("Retired paid maintenance phase(s): baseline-facts"),
    });
  });

  it("keeps older CLI provider tools fail closed", () => {
    expect(awardDetailsBackfill).toContain("const geminiCliDisabledByPolicy = true");
    expect(awardDetailsBackfill.indexOf("process.exit(1)"))
      .toBeLessThan(awardDetailsBackfill.indexOf("const supabase ="));
    expect(sourceTitleBackfill).toContain("const synchronousGeminiDisabled = true");
    expect(sourceTitleBackfill.indexOf("if (synchronousGeminiDisabled)"))
      .toBeLessThan(sourceTitleBackfill.indexOf("const supabase ="));
    expect(runScript("scripts/backfill-award-baseline-details.mjs").status).toBe(1);
    expect(runScript("scripts/backfill-source-page-titles.mjs").status).toBe(1);
  });

  it("proves capture's retained direct-provider functions are unreachable", () => {
    expect(capture).toContain('if (visualReviewMode === "immediate")');
    expect(capture).toContain(
      "Immediate Gemini visual review is disabled. Use --visual-review-mode=batch or --visual-review-mode=none.",
    );
    expect(occurrences(capture, "reviewCandidateWithAi(")).toBe(1);
    expect(captureAiRequirements).toContain(
      'if (["gemini-cli", "antigravity", "agy"].includes(requested)) return null;',
    );
    expect(functionBody(capture, "async function extractBaselineFactsWithGemini"))
      .toContain("Immediate Gemini baseline extraction is disabled");
  });

  it("keeps page audit historical polling but makes new submission impossible", () => {
    expect(pageAudit).toContain("const submit = false;");
    expect(pageAudit).toContain("if (submit && !pollOnly) await submitFlaggedAudits();");
    expect(pageAudit).not.toContain("submit = requestedSubmit");
    expect(pageAudit).toContain("only historical Gemini jobs will be polled");
  });

  it("removes legacy paid commands from package, admin, and operator guidance", () => {
    for (const alias of [
      "source:baseline-facts",
      "source:backfill-ai-review-coverage",
      "source:one-time-catchup",
      "award:baseline-details",
    ]) {
      expect(packageJson.scripts[alias]).toBeUndefined();
    }
    expect(adminMaintenance).not.toContain(
      "backfill-open-source-ai-determinations.mjs --apply=true",
    );
    expect(adminMaintenance).toContain("process-new-page-review-lane.mjs");
    expect(coverageReader).not.toContain(
      "backfill-open-source-ai-determinations.mjs --apply=true",
    );
    expect(coverageReader).toContain("process-new-page-review-lane.mjs");
    expect(maintenanceRoute).not.toContain("profile=catchup");
  });

  it("does not expose a third provider through local Supabase Studio", () => {
    expect(supabaseConfig).not.toMatch(/openai_api_key|OPENAI_API_KEY/);
    expect(supabaseConfig).not.toContain("[inbucket]");
    expect(supabaseConfig).toContain("[local_smtp]");
  });
});

function source(path) {
  return readFileSync(resolve(root, path), "utf8");
}

function providerCreateSurfaceFiles() {
  const signature =
    /api\.openai\.com|api\.tavily\.com|:batchGenerateContent|:generateContent|runGeminiCliJsonAnalysis\(/i;
  return runtimeFiles(resolve(root, "scripts"))
    .concat(runtimeFiles(resolve(root, "src")))
    .filter((path) => signature.test(readFileSync(path, "utf8")))
    .map((path) => relative(root, path).replaceAll("\\", "/"))
    .sort();
}

function runtimeFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...runtimeFiles(path));
    else if (
      /\.(?:mjs|js|ts|tsx)$/i.test(entry.name) &&
      !/\.test\.(?:mjs|js|ts|tsx)$/i.test(entry.name)
    ) {
      files.push(path);
    }
  }
  return files;
}

function runScript(path, args = [], env = {}) {
  const result = spawnSync(process.execPath, [resolve(root, path), ...args], {
    cwd: root,
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true,
  });
  return {
    status: result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    error: result.error?.message || null,
  };
}

function occurrences(body, value) {
  return body.split(value).length - 1;
}

function functionBody(body, signature) {
  const start = body.indexOf(signature);
  if (start < 0) return "";
  const next = body.indexOf("\nasync function ", start + signature.length);
  return body.slice(start, next < 0 ? undefined : next);
}
