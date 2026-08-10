import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AdminStage1ReleaseGate } from "@/components/admin-stage1-release-gate";
import type { Stage1ReleaseGateSummary } from "@/lib/stage1-release-gate-summary";

describe("AdminStage1ReleaseGate", () => {
  it("shows authoritative failures, Vault controls, and exact artifact bindings", () => {
    const html = renderToStaticMarkup(createElement(AdminStage1ReleaseGate, {
      summary: summaryFixture(),
    }));

    expect(html).toContain("Database release authority");
    expect(html).toContain("1/5 exact ID + hash");
    expect(html).toContain("legacy_contact_ciphertext_not_safe");
    expect(html).toContain("Authoritative Vault security");
    expect(html).toContain("Vault API surface safe: yes");
    expect(html).toContain("Service-role Data API profile blocked: no");
    expect(html).toContain("11111111-1111-4111-8111-111111111111");
    expect(html).toContain("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  });

  it("renders private pre-activation readiness as a passing release phase", () => {
    const summary = summaryFixture();
    summary.state = "READY";
    summary.phase = "preactivation_ready";
    summary.safeNextAction = "All pre-activation checks pass and the cohort remains private.";

    const html = renderToStaticMarkup(createElement(AdminStage1ReleaseGate, { summary }));
    const card = releaseCheckCard(html, "Atomic cohort release");

    expect(html).toContain('data-release-gate-phase="preactivation_ready"');
    expect(card).toContain(">Pass<");
    expect(card).not.toContain(">Hold<");
    expect(card).toContain("Ready for atomic activation");
    expect(card).toContain("remain private");
  });

  it("renders an active ready cohort without activation guidance", () => {
    const summary = summaryFixture();
    summary.state = "READY";
    summary.phase = "active_ready";
    summary.visibleCount = 25;
    summary.release = {
      state: "verified_beta",
      epoch: "11111111-1111-4111-8111-111111111111",
      effectiveReason: "cohort_release_verified",
      atomic: true,
    };
    summary.safeNextAction = "Stage 1 is active and all release checks pass.";

    const html = renderToStaticMarkup(createElement(AdminStage1ReleaseGate, { summary }));
    const card = releaseCheckCard(html, "Atomic cohort release");

    expect(html).toContain('data-release-gate-phase="active_ready"');
    expect(card).toContain(">Pass<");
    expect(card).toContain("25/25 active on one epoch");
    expect(html).toContain("Stage 1 is active and all release checks pass.");
  });
});

function releaseCheckCard(html: string, label: string) {
  const labelIndex = html.indexOf(label);
  if (labelIndex < 0) throw new Error(`Missing release check card: ${label}`);
  const articleStart = html.lastIndexOf("<article", labelIndex);
  const articleEnd = html.indexOf("</article>", labelIndex);
  if (articleStart < 0 || articleEnd < 0) {
    throw new Error(`Malformed release check card: ${label}`);
  }
  return html.slice(articleStart, articleEnd + "</article>".length);
}

function summaryFixture(): Stage1ReleaseGateSummary {
  return {
    state: "HOLD",
    phase: "hold",
    generatedAt: "2026-08-10T12:00:00.000Z",
    awards: [],
    registryCount: 0,
    visibleCount: 0,
    expectedAwardCount: 25,
    release: {
      state: "pending",
      epoch: null,
      effectiveReason: "cohort_release_pending",
      atomic: false,
    },
    invite: {
      status: "hold",
      disableSignup: true,
      detail: "Release remains held.",
    },
    inviteSecurityReissues: {
      status: "pass",
      count: 0,
      oldestAt: null,
      detail: "No reissues remain.",
    },
    identities: [],
    nightly: {
      status: "hold",
      label: "Awaiting cohorts",
      detail: "No qualifying cohort is available.",
      finishedAt: null,
      acceptance: {
        requiredCohorts: 3,
        observedCohorts: 0,
        healthyCohorts: 0,
        consecutive: false,
        soakStartedAt: null,
        soakRequiredHours: 24,
        soakElapsedHours: null,
        soakComplete: false,
        cohorts: [],
      },
    },
    budgets: [],
    lanes: [],
    recovery: {
      status: "hold",
      detail: "Recovery proof is missing.",
      reportingShards: 0,
      failed: 0,
      refused: 0,
      lastReportedAt: null,
    },
    authoritativeGate: {
      status: "hold",
      databaseState: "HOLD",
      generatedAt: "2026-08-10T12:00:00.000Z",
      stateHash: "b".repeat(64),
      failures: ["legacy_contact_ciphertext_not_safe"],
      productionTargetConfigured: true,
      vaultApiSurfaceSafe: true,
      serviceRoleDataApiProfileBlocked: false,
      profileHttpStatus: 200,
      profilePostgrestCode: null,
      currentValidArtifactBindings: 1,
      requiredArtifactBindings: 5,
      detail: "Database authority is not release-safe. Database gate reports HOLD: legacy_contact_ciphertext_not_safe.",
    },
    acceptanceArtifacts: [{
      kind: "rollback_drill",
      label: "Rollback and restoration drill",
      status: "pass",
      artifactId: "11111111-1111-4111-8111-111111111111",
      authoritativeArtifactId: "11111111-1111-4111-8111-111111111111",
      completedAt: "2026-08-10T11:00:00.000Z",
      validUntil: "2026-08-11T11:00:00.000Z",
      evidenceHash: "a".repeat(64),
      authoritativeEvidenceHash: "a".repeat(64),
      detail: "The exact retained artifact matches its authoritative binding.",
    }],
    safeNextAction: "Keep release on hold.",
    blockers: ["Database authority is not release-safe."],
    unknownReasons: [],
  };
}
