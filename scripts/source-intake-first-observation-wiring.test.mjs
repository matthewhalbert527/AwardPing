import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const captureWorker = readFileSync(
  new URL("./capture-visual-snapshots.mjs", import.meta.url),
  "utf8",
);
const intakeWorker = readFileSync(
  new URL("./process-source-intake-requests.mjs", import.meta.url),
  "utf8",
);

describe("new official document source-intake wiring", () => {
  it("queues discovered PDFs for paid new-page review instead of monitoring them immediately", () => {
    const pdfDiscovery = functionBody(captureWorker, "async function maybeRecordDiscoveredPdfSources");

    expect(pdfDiscovery).toContain("buildDiscoveredPdfIntakeRequest");
    expect(pdfDiscovery).not.toContain('.from("source_page_requests")');
    expect(pdfDiscovery).toContain("provenance.source_page_request_id");
    expect(captureWorker).toContain("provenance?.prior_source_page_request_id");
    expect(pdfDiscovery).toContain('"create_and_bind_shared_award_discovered_link_request"');
    expect(pdfDiscovery).toContain("registration?.quarantine_required === true");
    expect(pdfDiscovery).toContain("quarantineDiscoveredPdfNotificationConflict");
    expect(pdfDiscovery).toContain("discovery_skipped_prior_request");
    expect(pdfDiscovery).toContain("discovery_skipped_active_request");
    expect(pdfDiscovery).not.toContain("activeRequestStatuses");
    expect(pdfDiscovery).not.toMatch(/\.from\("shared_award_sources"\)[\s\S]*?\.upsert\(rows/);
  });

  it("registers every PDF link in convergent batches before queue caps can drop work", () => {
    const capture = functionBody(captureWorker, "async function discoverPdfLinksOnPage");
    const pdfDiscovery = functionBody(captureWorker, "async function maybeRecordDiscoveredPdfSources");

    expect(capture).not.toContain("maxProvenanceLinks");
    expect(capture).not.toMatch(/links\.length\s*>=/);
    expect(capture).toContain("return { links, truncated: false }");
    expect(capture).toContain("provenanceLinks.push({ url })");
    expect(capture).toContain("queueCandidates.push");
    expect(capture).not.toContain("queueCandidates.slice(0, maxPdfDiscoveryQueueCandidates)");
    expect(capture).toMatch(/\.catch\(\(error\) => \(\{[\s\S]*?links: \[\],[\s\S]*?truncated: true/);
    expect(capture.indexOf("provenanceLinks.push({ url })")).toBeLessThan(
      capture.indexOf("shouldRejectDiscoveredSource"),
    );
    expect(capture).not.toContain("candidates.slice(0, 25)");
    expect(pdfDiscovery).toContain("const provenanceLinks");
    expect(pdfDiscovery).toMatch(/const urls = \[\.\.\.new Set\(provenanceLinks/);
    expect(pdfDiscovery).toContain("const pdfLinks");
    expect(pdfDiscovery).toContain("chunkArray(urls, maxPdfDiscoveryRegistrationBatchSize)");
    expect(pdfDiscovery).toContain("p_scan_complete: pdfDiscovery.scanComplete === true && finalBatch");
    expect(pdfDiscovery).toContain("registration_batch_count: registrationBatches.length");
    expect(pdfDiscovery).toContain("rows.length >= maxPdfDiscoveryQueueCandidates");
    expect(pdfDiscovery.indexOf("provenance.source_page_request_id")).toBeLessThan(
      pdfDiscovery.indexOf("rows.length >= maxPdfDiscoveryQueueCandidates"),
    );
    expect(pdfDiscovery.indexOf('"register_shared_award_source_pdf_links"')).toBeLessThan(
      pdfDiscovery.indexOf("reserveDiscoveryCap"),
    );
  });

  it("quarantines terminal or non-live prior requests before an existing source can hide them", () => {
    const pdfDiscovery = functionBody(captureWorker, "async function maybeRecordDiscoveredPdfSources");
    const conflictGate = pdfDiscovery.indexOf(
      "discoveredPdfNotificationRequiresQuarantine(provenance)",
    );
    const existingSourceGate = pdfDiscovery.indexOf("existingUrls.has(comparableUrl)");

    expect(conflictGate).toBeGreaterThan(-1);
    expect(existingSourceGate).toBeGreaterThan(-1);
    expect(conflictGate).toBeLessThan(existingSourceGate);
    expect(pdfDiscovery).toContain("quarantineDiscoveredPdfNotificationConflict({");
    expect(pdfDiscovery).toContain("provenance,");
    expect(pdfDiscovery).toContain("continue;");
  });

  it("seeds history only after the final expanded, fully scrolled DOM is settled", () => {
    const capture = functionBody(captureWorker, "async function captureSource");
    const completeness = functionBody(captureWorker, "function pdfDiscoveryCompleteness");

    expect(capture.indexOf("const finalExpanded = await expandPageForSnapshot")).toBeLessThan(
      capture.indexOf("const pdfDiscovery = await discoverPdfLinksOnPage"),
    );
    expect(capture.indexOf("const pageSettle = await waitForPageSettledForSnapshot")).toBeLessThan(
      capture.indexOf("const pdfDiscovery = await discoverPdfLinksOnPage"),
    );
    expect(capture.indexOf("const pdfDiscovery = await discoverPdfLinksOnPage")).toBeLessThan(
      capture.indexOf("const finalTextGeometry = await captureStructuredVisibleTextGeometry"),
    );
    expect(completeness).toContain('"final_expansion_failed"');
    expect(completeness).toContain('"expandable_control_cap_hit"');
    expect(completeness).toContain('"scroll_activation_failed"');
    expect(completeness).toContain('"scroll_step_cap_hit"');
    expect(completeness).toContain('"page_not_settled"');
  });

  it("never treats a one-link request-binding refresh as a complete seed scan", () => {
    const refresh = functionBody(captureWorker, "async function refreshDiscoveredPdfRequestBinding");

    expect(refresh).toContain('"register_shared_award_source_pdf_links"');
    expect(refresh).toContain("p_scan_complete: false");
  });

  it("creates an immutable acquisition only after a genuinely new accepted source insert", () => {
    const acceptedSourceWrite = functionBody(intakeWorker, "async function registerAcceptedSource");

    expect(acceptedSourceWrite).toContain("buildSourceAcquisitionProposal");
    expect(acceptedSourceWrite).toContain('.rpc("register_shared_award_source_from_intake"');
    expect(acceptedSourceWrite).toContain("p_source: sourcePayload");
    expect(acceptedSourceWrite).toContain("p_acquisition: acquisitionProposal.row");
    expect(acceptedSourceWrite).toContain("source_inserted");
    expect(acceptedSourceWrite).toContain("effective_notification_mode");
    expect(acceptedSourceWrite).not.toContain('.from("shared_award_sources")');
    expect(acceptedSourceWrite).not.toContain('.from("shared_award_source_acquisitions")');
  });

  it("fails a known live first-capture evidence gap before registration and quarantines an unexpected server downgrade", () => {
    const finalize = functionBody(intakeWorker, "async function finalizeReviewedRequest");
    const manualReview = functionBody(
      intakeWorker,
      "async function finalizeLiveFirstCaptureManualReview",
    );

    expect(finalize).toContain("const acquisitionPreflight = buildSourceAcquisitionProposal({");
    expect(finalize).toContain("liveFirstCaptureRequested");
    expect(finalize).toContain('acquisitionPreflight.notification_mode !== "first_capture_candidate"');
    expect(finalize.indexOf("acquisitionPreflight.notification_mode")).toBeLessThan(
      finalize.indexOf("registerAcceptedSource"),
    );
    expect(finalize).toMatch(
      /liveFirstCaptureRequested\s+&& sourceWrite\.acquisition\?\.create\s+&& sourceWrite\.acquisition\.notification_mode === "manual_review"/,
    );
    expect(finalize).toContain('admin_review_status: "review_later"');
    expect(manualReview).toContain('status: "needs_manual_review"');
    expect(manualReview).toContain("No source was registered from this request.");
    expect(manualReview).toContain("do not absorb this document as a healthy baseline");
  });

  it("does not label an explicitly manual non-live intake as a failed live first capture", () => {
    const finalize = functionBody(intakeWorker, "async function finalizeReviewedRequest");
    const liveGate = finalize.match(
      /if \(\s*liveFirstCaptureRequested\s+&& sourceWrite\.acquisition\?\.create\s+&& sourceWrite\.acquisition\.notification_mode === "manual_review"\s*\)/,
    );

    expect(liveGate).not.toBeNull();
  });

  it("preserves the originally discovered URL when intake canonicalizes a redirect", () => {
    const captureStage = functionBody(intakeWorker, "async function processCaptureStage");

    expect(captureStage).toContain("homepage_url: normalizedUrl");
    expect(captureStage).toContain("submitted_url: row.submitted_url || row.homepage_url || normalizedUrl");
    expect(captureStage).toContain(
      "normalized_url: deterministicReview.normalizedUrl || capture.canonical_url || normalizedUrl",
    );
  });

  it("persists deterministic access failures as operator-visible manual review", () => {
    const captureStage = functionBody(intakeWorker, "async function processCaptureStage");
    const manualReviewBranch = captureStage.slice(
      captureStage.indexOf('deterministicReview.status === "needs_manual_review"'),
      captureStage.indexOf('if (geminiApiMode === "none")'),
    );

    expect(manualReviewBranch).toContain('status: "needs_manual_review"');
    expect(manualReviewBranch).toContain("status_reason: deterministicReview.reason");
    expect(manualReviewBranch).toContain("processed_at: new Date().toISOString()");
    expect(manualReviewBranch).toContain("report.needs_manual_review += 1");
  });
});

function functionBody(source, signature) {
  const start = source.indexOf(signature);
  if (start < 0) throw new Error(`Missing ${signature}`);
  const nextFunction = source.indexOf("\nasync function ", start + signature.length);
  return source.slice(start, nextFunction < 0 ? undefined : nextFunction);
}
