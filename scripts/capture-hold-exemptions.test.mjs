import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const worker = readFileSync(
  resolve(root, "scripts", "capture-visual-snapshots.mjs"),
  "utf8",
);

describe("Stage 1 manifest exemption from automated holds", () => {
  it("loads the manifest once per run with the worker's service client, after the health check", () => {
    expect(worker).toContain('} from "./lib/stage1-manifest-sources.mjs";');
    expect(worker).toContain("let stage1ManifestSources = emptyStage1ManifestSources();");
    const runBody = functionBody("async function runOnce(", "function startRunHeartbeat");
    const health = runBody.indexOf("const supabaseHealth = await checkSupabaseHealth(supabase);");
    const load = runBody.indexOf("stage1ManifestSources = await loadStage1ManifestSources(supabase);");
    const sourcesLoad = runBody.indexOf("const loadedSources = authoritativeInventory");
    expect(health).toBeGreaterThan(-1);
    expect(load).toBeGreaterThan(health);
    expect(load).toBeLessThan(sourcesLoad);
    expect(occurrences(worker, "await loadStage1ManifestSources(supabase)")).toBe(1);
  });

  it("exposes a single predicate backed by manifest membership", () => {
    const predicate = functionBody("function automatedHoldExempt(", "function logStage1ManifestSourceKeptOpen(");
    expect(predicate).toContain("return isStage1ManifestSource(stage1ManifestSources, source?.id);");
    expect(worker).toContain("stage1 manifest source kept open");
    // Four call sites: pre-capture hygiene, pre-capture consolidation,
    // failure hygiene, and the baseline-facts verdict (definition excluded).
    expect(
      occurrences(worker, "automatedHoldExempt(source)")
        - occurrences(worker, "function automatedHoldExempt(source)"),
    ).toBe(4);
  });

  it("keeps manifest sources open through URL/title triage while human-owned holds stay untouched", () => {
    const triage = functionBody(
      'if (source.admin_review_status === "open" && !humanReviewOwnsSource)',
      "const baselinePath = baselinePathForSource(source.id);",
    );
    expect(triage).toContain('if (hygiene.action === "review_later") {');
    expect(triage).toContain('if (consolidation.action === "review_later") {');
    expect(occurrences(triage, "if (automatedHoldExempt(source)) {")).toBe(2);
    expect(occurrences(triage, "await markSharedSourceReviewLater(source, ")).toBe(2);
    expect(triage).toContain('logStage1ManifestSourceKeptOpen("pre_capture_hygiene", hygiene.reason, source)');
    expect(triage).toContain(
      'logStage1ManifestSourceKeptOpen("pre_capture_consolidation", consolidation.reason, source)',
    );
    // The exempt branch continues into capture; only the hold branch returns.
    for (const exemptBranch of triage.split("if (automatedHoldExempt(source)) {").slice(1)) {
      const kept = exemptBranch.indexOf("logStage1ManifestSourceKeptOpen(");
      const hold = exemptBranch.indexOf("await markSharedSourceReviewLater(");
      const stop = exemptBranch.indexOf("return;");
      expect(kept).toBeGreaterThan(-1);
      expect(hold).toBeGreaterThan(kept);
      expect(stop).toBeGreaterThan(hold);
    }
  });

  it("records failure details but withholds the failure-hygiene hold for manifest sources", () => {
    const body = functionBody(
      "async function markSharedSourceVisualCheckFailed(",
      "function recordStaleAdminReviewPlan(",
    );
    expect(body).toContain(
      'const holdExempt = finalHygiene.action === "review_later" && automatedHoldExempt(source);',
    );
    expect(body).toContain('if (finalHygiene.action === "review_later" && !holdExempt) {');
    expect(body).toContain("last_error: truncate(message, 1000),");
    expect(body).toContain("consecutive_failures: failures,");
    expect(body).toContain('logStage1ManifestSourceKeptOpen("visual_check_failed", finalHygiene.reason, source)');
    const holdWrite = body.indexOf('update.admin_review_status = "review_later";');
    const exemptGate = body.indexOf('if (finalHygiene.action === "review_later" && !holdExempt) {');
    expect(exemptGate).toBeGreaterThan(-1);
    expect(holdWrite).toBeGreaterThan(exemptGate);
    expect(body.indexOf("if (!data)")).toBeLessThan(body.indexOf("if (holdExempt) {"));
    // Existing evidence-capture escalation stays intact.
    expect(body).toContain(
      'hygiene.action === "review_later" || !aiReviewEvidenceCapture || failures < 2',
    );
  });
});

describe("baseline facts verdict re-application guard", () => {
  const body = functionBody("function sourcePageMetadataUpdate(", "function baselineFactsMatchSource(");

  it("marks fresh extractions on the capture object itself", () => {
    expect(worker).toContain("const freshBaselineFactsByCapture = new WeakMap();");
    const attach = functionBody("function attachBaselineFactsToCapture(", "function normalizeBaselineFacts(");
    expect(attach).toContain("capture.baseline_facts = facts;");
    expect(attach).toContain("freshBaselineFactsByCapture.set(capture, facts);");
    const fresh = functionBody(
      "function captureCarriesFreshBaselineFacts(",
      "function automatedHoldExempt(",
    );
    expect(fresh).toContain("freshBaselineFactsByCapture.get(capture) === capture.baseline_facts");
    // writeBaseline copies stored facts without marking them fresh.
    const write = functionBody("function writeBaseline(", "function readBaselineEvidence(");
    expect(write).toContain("capture.baseline_facts = details.baseline_facts;");
    expect(write).not.toContain("freshBaselineFactsByCapture");
  });

  it("gates the review_later branch on a fresh extraction and the manifest exemption", () => {
    expect(body).toContain("const freshExtraction = captureCarriesFreshBaselineFacts(capture);");
    const verdict = body.indexOf("if (shouldReviewLaterForBaselineFactsRejection(facts, sanity.reason)) {");
    const staleGate = body.indexOf("if (!freshExtraction) {", verdict);
    const exemptGate = body.indexOf("} else if (automatedHoldExempt(source)) {", staleGate);
    const holdWrite = body.indexOf('update.admin_review_status = "review_later";', exemptGate);
    expect(verdict).toBeGreaterThan(-1);
    expect(staleGate).toBeGreaterThan(verdict);
    expect(exemptGate).toBeGreaterThan(staleGate);
    expect(holdWrite).toBeGreaterThan(exemptGate);
    expect(occurrences(body, 'admin_review_status = "review_later"')).toBe(1);
    expect(body).toContain("SOURCE_HOLD_SKIPPED stale_baseline_facts_verdict");
    expect(body).toContain('logStage1ManifestSourceKeptOpen("baseline_facts_rejection", sanity.reason, source)');
  });

  it("keeps writing the rejection markers for carried-forward facts", () => {
    const rejection = body.slice(
      body.indexOf("if (!sanity.ok && !operatorVerdict) {"),
      body.indexOf("if (shouldReviewLaterForBaselineFactsRejection(facts, sanity.reason)) {"),
    );
    expect(rejection).toContain("baseline_facts_rejected: true,");
    expect(rejection).toContain("rejection_reason: sanity.reason,");
    expect(rejection).not.toContain("freshExtraction");
  });

  it("preserves the exact tokens the admin review guard asserts on", () => {
    const success = functionBody(
      "async function markSharedSourceVisualCheckSucceeded(",
      "async function markSharedSourceReviewLater(",
    );
    expect(success).toContain("sourcePageMetadataUpdate(source, capture)");
    expect(success).toContain('.select("id").maybeSingle()');
    expect(success).toContain("return false");
    expect(success).not.toContain("admin_review_status:");
  });
});

describe("baseline facts operator correction", () => {
  const body = functionBody("function sourcePageMetadataUpdate(", "function baselineFactsMatchSource(");

  it("carries the correction block across both metadata rebuilds with its own carry-over", () => {
    expect(worker).toContain(
      "const preservedOperatorCorrection = baselineFactsOperatorCorrectionMetadata(source);",
    );
    expect(worker.match(/\.\.\.preservedOperatorCorrection/g)).toHaveLength(2);
    expect(worker.match(/\.\.\.protectedStage1Approval/g)).toHaveLength(2);
    expect(worker).toContain(
      "jsonObjectOrEmpty(source?.page_metadata).baseline_facts_operator_correction",
    );
    const rejectedRebuild = body.indexOf("baseline_facts_rejected: true,");
    const acceptedRebuild = body.indexOf("baseline_facts_metadata: metadata,");
    expect(body.indexOf("...preservedOperatorCorrection", rejectedRebuild)).toBeLessThan(acceptedRebuild);
    expect(body.indexOf("...preservedOperatorCorrection", acceptedRebuild)).toBeGreaterThan(acceptedRebuild);
  });

  it("treats the block as a human verdict only for the corrected field's rejection", () => {
    expect(body).toContain("const operatorVerdict = hasBaselineFactsOperatorCorrection(source)");
    expect(body).toContain("&& operatorCorrectionCoversRejection(source, sanity.reason);");
    expect(body).toContain("const facts = applyBaselineFactsOperatorCorrection(source, normalizedFacts);");
    expect(body).toContain("if (!sanity.ok && !operatorVerdict) {");
    expect(body).toContain("BASELINE_FACTS operator_correction_overrides_rejection");
    const rejectionBranch = body.indexOf("if (!sanity.ok && !operatorVerdict) {");
    const hold = body.indexOf('update.admin_review_status = "review_later";');
    const acceptedReturn = body.indexOf("const displayTitle = facts.display_title");
    expect(hold).toBeGreaterThan(rejectionBranch);
    expect(hold).toBeLessThan(acceptedReturn);
  });

  it("re-applies the operator-corrected field from the stored facts", () => {
    const apply = functionBody(
      "function applyBaselineFactsOperatorCorrection(",
      "function captureCarriesFreshBaselineFacts(",
    );
    expect(apply).toContain("const field = cleanText(correction?.field);");
    expect(apply).toContain("jsonObjectOrEmpty(jsonObjectOrEmpty(source?.page_metadata).baseline_facts)");
    expect(apply).toContain("if (!field || !Object.hasOwn(storedFacts, field)) return facts;");
    expect(apply).toContain("return { ...facts, [field]: storedFacts[field] };");
  });
});

function functionBody(startSignature, endSignature) {
  const start = worker.indexOf(startSignature);
  const end = worker.indexOf(endSignature, start + startSignature.length);
  if (start < 0 || end < 0) {
    throw new Error(`Unable to locate source segment: ${startSignature} -> ${endSignature}`);
  }
  return worker.slice(start, end);
}

function occurrences(body, value) {
  return body.split(value).length - 1;
}
