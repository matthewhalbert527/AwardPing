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

describe("permanent first-observation discovery schedule", () => {
  it("enables bounded live PDF discovery in normal visual shards only", () => {
    const visual = functionBody(maintenance, "async function runVisualSnapshots");
    expect(visual).toContain('completeMissing ? "--discovery-mode=false" : "--discovery-mode=true"');
    expect(visual).toContain('completeMissing ? "--discovery-intent=historical_onboarding" : "--discovery-intent=live_recurring"');
    expect(visual).toContain('completeMissing ? "--discover-pdf-subpages=false" : "--discover-pdf-subpages=true"');
    expect(visual).toContain('"--discover-html-subpages=false"');
    expect(visual).toContain("--max-discoveries-per-award=");
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
    expect(launcher).toContain('`$workerArgs += "--discover-pdf-subpages=true"');
    expect(launcher).toContain("if (-not `$CompleteMissingBaselines -and -not `$BaselineRefresh)");
    expect(installer).toContain("queues newly linked official PDFs for review daily");
  });
});

function functionBody(source, signature) {
  const start = source.indexOf(signature);
  if (start < 0) throw new Error(`Missing ${signature}`);
  const next = source.indexOf("\nasync function ", start + signature.length);
  return source.slice(start, next < 0 ? undefined : next);
}
