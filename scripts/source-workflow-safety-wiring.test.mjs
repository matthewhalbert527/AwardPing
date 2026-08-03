import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const backfill = source("./backfill-low-coverage-award-sources.mjs");
const worker = source("./process-source-intake-requests.mjs");
const retention = source("./lib/intake-artifact-retention.mjs");
const providerBinding = source("./lib/source-intake-provider-binding.mjs");
const route = source("../src/app/api/admin/source-intake/[id]/route.ts");

describe("source workflow safety wiring", () => {
  it("routes low-coverage apply through idempotent paid intake without direct source/homepage writes", () => {
    expect(backfill).toContain("buildLowCoverageSourceIntakeRequest");
    expect(backfill).toContain("enqueueLowCoverageSourceIntakeRequests");
    expect(backfill).not.toMatch(/from\(["']shared_award_sources["']\)\s*\.upsert/);
    expect(backfill).not.toMatch(/\.update\(\{\s*official_homepage/);
    expect(backfill).not.toContain("insertSourceRows");
    expect(backfill).toContain("openSourceRowsForCoverage(sources)");
    expect(backfill).toContain("admin_review_status,updated_at");
    expect(backfill).toContain("sources.map((source)");
    expect(backfill).toContain("captureIntakePage(candidate.url");
    expect(backfill).toContain("maxResponseBytes: verifyMaxResponseBytes");
    expect(backfill).toContain("maxPdfBytes: verifyMaxResponseBytes");
    expect(backfill).not.toContain("fetch(candidate.url");
    expect(backfill).toContain('redirect: "error"');
    expect(backfill).toContain("bytesRead > searchMaxResponseBytes");
    expect(backfill).not.toContain("response.text()");
  });

  it("stops reviewed backfill before source registration until exact operator approval", () => {
    const finalize = worker.indexOf("async function finalizeReviewedRequest");
    const manualGate = worker.indexOf("requiresManualBackfillSourceActivation(row)", finalize);
    const proposal = worker.indexOf("const acquisitionPreflight = buildSourceAcquisitionProposal", manualGate);
    const registration = worker.indexOf("await registerAcceptedSource", manualGate);

    expect(manualGate).toBeGreaterThan(-1);
    expect(proposal).toBeGreaterThan(manualGate);
    expect(registration).toBeGreaterThan(proposal);
    expect(worker.slice(manualGate, proposal)).toContain("official_homepage_changed: false");
    expect(worker.slice(manualGate, proposal)).toContain("created_source_ids: null");
  });

  it("replays approved activation from R2 evidence without fetch or AI and protects failed replay", () => {
    expect(worker).toContain("validateApprovedBackfillActivationReplay");
    expect(worker).toContain("SOURCE_BACKFILL_APPROVAL_REQUEST_REASON");
    expect(worker).toContain("SOURCE_BACKFILL_APPROVAL_CLAIM_REASON");
    expect(worker).toContain("SOURCE_BACKFILL_APPROVAL_PREFLIGHT_FAILURE_REASON");
    expect(worker).toContain("refetched_page: false");
    expect(worker).toContain("reran_ai_review: false");
    expect(worker).toContain("failOwnedBackfillActivation");
    expect(worker).toContain("automatic rematching or award creation is forbidden");
    expect(worker).toContain("low_coverage_backfill_matched_award_missing_or_inactive");
    expect(retention).toContain("Every response that can proceed to a paid new-page review must be retained");
    expect(retention).toContain("cleanText(capture?.capture_file_hash)");
    expect(retention).toContain("document_content_type: documentContentType");
  });

  it("keeps operator approval inside the existing admin and optimistic-CAS boundary", () => {
    expect(route).toContain('"approve_backfill_source"');
    expect(route).toContain("sourceIntakeBackfillApprovalPatch");
    expect(route).toContain("sourceIntakeBackfillActivationRetryPatch");
    expect(route).toContain('.eq("status", current.status)');
    expect(route).toContain('.eq("updated_at", current.updated_at)');
    expect(route).toContain("will not fetch the page, rerun AI");
  });

  it("binds paid provider input, accepted output, admin approval, and $0 replay to one immutable digest", () => {
    const paidFlow = worker.slice(
      worker.indexOf("async function submitAiReviewChunk"),
      worker.indexOf("async function claimSourceIntakeSubmissionRows"),
    );
    expect(paidFlow.indexOf("claimSourceIntakeSubmissionRows")).toBeLessThan(
      paidFlow.indexOf('kind: "source_intake_batch_create"'),
    );
    const claim = worker.slice(
      worker.indexOf("async function claimSourceIntakeSubmissionRows"),
      worker.indexOf("async function markSourceIntakeClaimsCreateStarted"),
    );
    expect(claim).toContain("provider_input_binding");
    expect(claim).toContain("withObservedUpdatedAt(query, row.updated_at)");
    expect(worker).toContain('{ providerResultMode: "provider_result" }');
    expect(worker).toContain('{ providerResultMode: "replay" }');
    expect(worker).toContain("validateSourceIntakeProviderReplayBinding");
    expect(worker).toContain("provider_input_binding).digest_sha256");
    expect(providerBinding).toContain("retained_capture_sha256");
    expect(providerBinding).toContain("normalized_text_sha256");
    expect(providerBinding).toContain("provider_result_sha256");
    expect(providerBinding).toContain('"source-intake-provider-input-v2"');
    expect(providerBinding).toContain("provider_envelope_sha256");
    expect(providerBinding).toContain("request_fields_sha256");
    expect(providerBinding).toContain("deterministic_review_sha256");
    expect(providerBinding).toContain("text_excerpt_sha256");
    expect(worker).toContain("model: reservationModel");
    expect(providerBinding).toContain("Historical unbound results cannot be replayed");
    expect(route).toContain("verifySourceIntakeProviderBindingForAdminApproval");
    expect(route.indexOf("verifySourceIntakeProviderBindingForAdminApproval({")).toBeLessThan(
      route.indexOf("patch = patchForAction("),
    );
  });

  it("uses the shared exact-count/revision loader in every targeted catalog script", () => {
    for (const path of [
      "./audit-shared-source-coverage.mjs",
      "./backfill-low-coverage-award-sources.mjs",
      "./post-crawl-cleanup-report.mjs",
      "./report-broken-sources.mjs",
    ]) {
      const value = source(path);
      expect(value, path).toContain("loadDeterministicSupabaseRows");
      expect(value, path).not.toMatch(/for \(let from = 0; ; from \+= 1000\)/);
      expect(value, path).not.toContain(".range(from");
    }
  });

  it("makes every post-crawl dependency table required before an apply mutation", () => {
    const postCrawl = source("./post-crawl-cleanup-report.mjs");
    expect(postCrawl).not.toContain("loadOptionalAll");
    expect(postCrawl).toContain('loadAll("monitors", "id,shared_award_source_id,updated_at")');
    expect(postCrawl).toContain('loadAll("award_sources", "id,shared_award_source_id,updated_at")');
    expect(postCrawl).toContain('"id,shared_award_source_id,source_url,created_at"');
    expect(postCrawl).toContain('"id,shared_award_id,shared_award_source_id,source_url,detected_at"');
  });
});

function source(path) {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}
