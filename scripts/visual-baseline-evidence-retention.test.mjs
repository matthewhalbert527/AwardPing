import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  new URL("./capture-visual-snapshots.mjs", import.meta.url),
  "utf8",
);
const catchupSource = readFileSync(
  new URL("./run-one-time-catchup.mjs", import.meta.url),
  "utf8",
);

function functionBody(name, nextName) {
  const start = source.indexOf(`function ${name}`);
  const end = source.indexOf(`function ${nextName}`, start + 1);
  return source.slice(start, end === -1 ? undefined : end);
}

describe("visual baseline evidence retention", () => {
  it("never deletes a text-noise capture after promoting it to baseline", () => {
    const body = functionBody("finishTextOnlyNoise", "reviewAndApplyCandidateChange");

    expect(body).toContain("baselinePromoted = writeBaseline");
    expect(body).toContain("if (!keepUnchanged && !baselinePromoted)");
  });

  it("never deletes a PDF capture after promoting a text-equivalent file", () => {
    const body = functionBody("processPdfComparison", "capturePdfSource");

    expect(body).toContain("baselinePromoted = writeBaseline");
    expect(body).toContain("if (!keepUnchanged && !baselinePromoted)");
  });

  it("defends the deletion boundary and treats dangling pointers as missing", () => {
    const removeBody = functionBody("removeGeneratedCaptureDir", "captureDirIsReferencedByCurrentBaseline");
    const coverageBody = functionBody("hasBaselineForSource", "needsMissingBaselineCompletion");
    const writeBody = functionBody("writeBaseline", "readBaselineEvidence");
    const runBody = functionBody("runOnce", "startRunHeartbeat");

    expect(removeBody).toContain("captureDirIsReferencedByCurrentBaseline");
    expect(removeBody).toContain("PRESERVE baseline_referenced_capture");
    expect(coverageBody).toContain("inspectLocalBaselineEvidence");
    expect(coverageBody).toContain("inspection.evidence_complete === true");
    expect(coverageBody).toContain("localBaselineEvidenceCache.has(source.id)");
    expect(writeBody).toContain("localBaselineEvidenceCache.set(source.id, true)");
    expect(runBody).toContain("localBaselineEvidenceCache.clear()");
  });

  it("limits the pre-review bypass to explicit evidence-capture mode", () => {
    const body = functionBody("filterMonitorableSourcesForCapture", "isSupabaseStatementTimeoutLike");

    expect(source).toContain(
      "--ai-review-evidence-capture=true requires --source-id or --source-ids-file.",
    );
    expect(body).toContain('sourceQualityDecision(source, { purpose: "discovery" })');
    expect(body).toContain('sourceQualityDecision(source, { purpose: "monitoring" })');
  });

  it("repairs and verifies local evidence before submitting source AI review", () => {
    const evidenceStage = catchupSource.indexOf(
      'runStage("source-ai-local-evidence", drainSourceAiEvidence)',
    );
    const reviewStage = catchupSource.indexOf(
      'runStage("source-ai-review", drainSourceAiReview)',
    );
    const reviewFunctionStart = catchupSource.indexOf("async function drainSourceAiReview");
    const evidenceFunctionStart = catchupSource.indexOf("async function drainSourceAiEvidence");
    const reviewFunction = catchupSource.slice(reviewFunctionStart, evidenceFunctionStart);

    expect(evidenceStage).toBeGreaterThan(-1);
    expect(reviewStage).toBeGreaterThan(evidenceStage);
    expect(reviewFunction).toContain("await drainSourceAiEvidence()");
    expect(catchupSource).toContain('"--ai-review-evidence-capture=true"');
    expect(catchupSource).toContain('"--require-complete=true"');
  });
});
