import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const maintenance = readFileSync(
  new URL("./run-awardping-maintenance.mjs", import.meta.url),
  "utf8",
);
const installer = readFileSync(
  new URL("../installer/windows/Install-AwardPingWorker.ps1", import.meta.url),
  "utf8",
);
const capture = readFileSync(
  new URL("./capture-visual-snapshots.mjs", import.meta.url),
  "utf8",
);

describe("permanent first-observation discovery schedule", () => {
  it("enables bounded live PDF discovery in normal visual shards only", () => {
    const visual = functionBody(maintenance, "async function runVisualSnapshots");
    expect(visual).toContain('completeMissing ? "--discovery-mode=false" : "--discovery-mode=true"');
    expect(visual).toContain('completeMissing ? "--discovery-intent=historical_onboarding" : "--discovery-intent=live_recurring"');
    expect(visual).toContain('completeMissing ? "--discover-pdf-subpages=false" : "--discover-pdf-subpages=true"');
    expect(visual).toContain('"--discover-html-subpages=false"');
    expect(visual).toContain("--max-discoveries-per-award=");
    expect(visual).toContain('"--max-expansion-state-screenshots=24"');
    expect(visual).toContain('"--expansion-state-timeout-per-state-ms=60000"');
    expect(visual).not.toContain('"--source-timeout-ms=1500000"');
  });

  it("keeps explicit operator discovery historical unless deliberately selected live", () => {
    const discovery = functionBody(maintenance, "async function runSourceDiscovery");
    expect(discovery).toContain("--discovery-intent=${discoveryIntent}");
    expect(discovery).toContain('if (discoveryIntent === "historical_onboarding")');
    expect(discovery).toContain("--discovery-onboarding-batch-id=${discoveryOnboardingBatchId}");
  });

  it("installs the same live-discovery contract into the permanent 6 PM wrapper", () => {
    const launcher = installer.slice(
      installer.indexOf("function Write-LauncherScripts"),
      installer.indexOf("function Write-Downstream", installer.indexOf("function Write-LauncherScripts")),
    );
    expect(launcher).toContain('`$workerArgs += "--discovery-mode=true"');
    expect(launcher).toContain('`$workerArgs += "--discovery-intent=live_recurring"');
    expect(launcher).toContain('`$workerArgs += "--discovery-onboarding-batch-id="');
    expect(launcher).toContain('`$workerArgs += "--discover-pdf-subpages=true"');
    expect(launcher).toContain('"--visual-review-mode=batch"');
    expect(launcher).toContain('"--localization-repair=false"');
    expect(launcher).toContain('"--r2-snapshot-sync=true"');
    expect(launcher).toContain('"--max-expansion-state-screenshots=24"');
    expect(launcher).toContain('"--expansion-state-timeout-per-state-ms=60000"');
    expect(launcher).not.toContain('"--source-timeout-ms=1500000"');
    expect(launcher).not.toContain("`$BaselineRefresh");
    expect(launcher).not.toContain("`$CompleteMissingBaselines");
    expect(launcher).not.toContain("--discovery-mode=false");
    expect(installer).toContain("queues newly linked official PDFs for review daily");
  });

  it("validates the scheduled contract in the capture process before work starts", () => {
    const validationIndex = capture.indexOf(
      "const scheduledNightlyRunContract = classifyScheduledNightlyVisualRun({",
    );
    expect(validationIndex).toBeGreaterThan(0);
    expect(capture).toContain('if (runTrigger === "scheduled" && !scheduledNightlyRunContract.eligible)');
    expect(capture).toContain("Invalid scheduled visual run contract:");
    expect(validationIndex).toBeLessThan(capture.indexOf('process.on("uncaughtException"'));
    expect(validationIndex).toBeLessThan(capture.indexOf("await runOnce()"));
  });

  it("keeps the normal source deadline and grants a separate post-discovery expansion phase", () => {
    expect(capture).toContain('args["source-timeout-ms"]');
    expect(capture).toContain("Math.max(timeoutMs + 30_000, 90_000)");
    expect(capture).toContain("const sourceDeadline = createSourcePhaseDeadline(");
    expect(capture).toContain("sourceDeadline.beginPhase({");
    expect(capture).toContain('name: "expansion-state-capture"');
    expect(capture).toContain("expansionStateCaptureBudgetMs(descriptors.length");
    expect(capture).toContain("if (sourceDeadline?.expired?.()) throw error");
    expect(capture).not.toContain("expansionAwareSourceTimeoutFloorMs");
    expect(capture).toContain("timeoutMs: Math.min(sourceTimeoutMs, 60_000)");
  });

  it("pauses the short source budget only while the bounded expansion phase is active", async () => {
    const createDeadline = executableSourcePhaseDeadline();
    const deadline = createDeadline(100, "source deadline");
    const result = await deadline.run(async () => {
      await delay(20);
      const endExpansion = deadline.beginPhase({
        name: "expansion-state-capture",
        timeoutMs: 250,
        message: "expansion deadline",
      });
      await delay(150);
      endExpansion();
      await delay(20);
      return "complete";
    });
    expect(result).toBe("complete");

    const ordinary = createDeadline(40, "ordinary source deadline");
    await expect(ordinary.run(async () => {
      await delay(100);
    })).rejects.toMatchObject({
      code: "AWARDPING_SOURCE_TIMEOUT",
      timeout_phase: "source",
    });

    const expansion = createDeadline(200, "ordinary source deadline");
    await expect(expansion.run(async () => {
      expansion.beginPhase({
        name: "expansion-state-capture",
        timeoutMs: 40,
        message: "expansion deadline",
      });
      await delay(100);
    })).rejects.toMatchObject({
      code: "AWARDPING_SOURCE_TIMEOUT",
      timeout_phase: "expansion-state-capture",
    });
    expect(expansion.expired()).toBe(true);
  });
});

function functionBody(source, signature) {
  const start = source.indexOf(signature);
  if (start < 0) throw new Error(`Missing ${signature}`);
  const next = source.indexOf("\nasync function ", start + signature.length);
  return source.slice(start, next < 0 ? undefined : next);
}

function executableSourcePhaseDeadline() {
  const start = capture.indexOf("function createSourcePhaseDeadline");
  const end = capture.indexOf("\nfunction isCaptureNetworkBoundaryError", start);
  if (start < 0 || end < 0) throw new Error("Missing createSourcePhaseDeadline");
  return Function(`${capture.slice(start, end)}\nreturn createSourcePhaseDeadline;`)();
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
