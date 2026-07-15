import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const backfill = readFileSync(resolve(root, "scripts/backfill-visual-event-evidence.mjs"), "utf8");
const backfillHelper = readFileSync(
  resolve(root, "scripts/lib/visual-event-evidence-backfill.mjs"),
  "utf8",
);
const coverage = readFileSync(resolve(root, "scripts/read-event-visual-evidence-coverage.mjs"), "utf8");
const coverageHelper = readFileSync(
  resolve(root, "scripts/lib/event-visual-evidence-coverage.mjs"),
  "utf8",
);

describe("historical event visual evidence script wiring", () => {
  it("is dry-run by default and selects the strict or snapshotted-legacy idempotent RPC only with --apply", () => {
    expect(backfill).toContain("const apply = boolArg(args.apply, false)");
    expect(backfill).toContain("publishEvidence: apply");
    expect(backfill).toContain('"backfill_legacy_shared_award_visual_event_evidence"');
    expect(backfill).toContain('"backfill_shared_award_visual_event_evidence"');
    expect(backfill).toContain("const { data, error } = await supabase.rpc(rpc");
    expect(backfill).toContain("p_event_id: eventId");
    expect(backfill).toContain("p_evidence: backfillEvidenceRpcPayload(evidence)");
    expect(backfill).toContain("executeHistoricalBackfillStep({");
    expect(backfillHelper).toContain("if (!isDeterministicVisualArtifactError(error)) throw error");
    expect(backfillHelper.indexOf("await publishEvidence(result.evidence)")).toBeLessThan(
      backfillHelper.indexOf("await advance()"),
    );
  });

  it("paginates and resumes by stable event ID without current-pointer or timestamp matching", () => {
    expect(backfill).toContain('.order("id", { ascending: true })');
    expect(backfill).toContain('.gt("id", afterId)');
    expect(backfill).toContain("checkpoint?.last_event_id");
    expect(backfill).toContain('.contains("worker_metadata", { change_event_id: event.id })');
    expect(backfill).not.toContain("shared_award_source_visual_snapshots");
    expect(backfill).not.toMatch(/nearest|timestamp.*candidate|latest_object_keys/i);
  });

  it("cross-checks exact candidate visual identities and uses historical publication preparation", () => {
    expect(backfillHelper).toContain('visualHashFromCandidate(candidate, "previous")');
    expect(backfillHelper).toContain('visualHashFromCandidate(candidate, "new")');
    expect(backfill).toContain("preparePublishedVisualEventEvidence({");
    expect(backfill).toContain("historical: true");
    expect(backfill).toContain("legacyFallback");
    expect(backfill).toContain('from("shared_award_legacy_visual_evidence_eligibility")');
    expect(backfillHelper).toContain('methods.has("candidate_signature")');
    expect(backfillHelper).toContain('methods.has("reverse_worker_metadata")');
  });

  it("reports operator-safe repair guidance for unresolved and operational failures", () => {
    expect(backfill).toContain("repair_plan: {}");
    expect(backfill).toContain("failure_samples: []");
    expect(backfill).toContain("solution: repair.solution");
    expect(backfill).toContain("backfill_rpc_dependency_failure");
    expect(backfill).toContain("backfill_r2_dependency_failure");
    expect(backfillHelper).toContain("quarantine_identity_conflict");
    expect(backfillHelper).toContain("explicit_operator_linkage");
    expect(backfillHelper).toContain("preserve_survivors_mark_unavailable");
    expect(backfillHelper).toContain("dependency_repair_idempotent_retry");
  });

  it("keeps repairable gaps retryable while continuing independent recovery", () => {
    expect(backfill).toContain('args["terminal-loss-confirmations"]');
    expect(backfill).toContain("pending_linkage_event_ids: []");
    expect(backfill).toContain("contiguousCheckpointBlocked = true");
    expect(backfill).toContain("noncontiguous_completed_events");
    expect(backfill).toContain("terminalArtifactLossConfirmed: true");
    expect(backfillHelper).toContain("Unrecoverable evidence requires an explicit terminal artifact-loss confirmation");
    expect(backfill).not.toContain("break backfillPages");
  });

  it("coverage HEAD-checks event full/crop objects and summarizes verified event crop sides", () => {
    expect(coverage).toContain("new HeadObjectCommand({ Bucket: bucket, Key: key })");
    expect(coverageHelper).toContain('role: "full"');
    expect(coverageHelper).toContain('role: "crop"');
    expect(coverageHelper).toContain('role: "metadata"');
    expect(coverageHelper).toContain('{ role: "state.image", manifest: state.image, required: true }');
    expect(coverageHelper).toContain("classifyChangeEventVisualEvidence({ event, evidence, artifactChecks })");
    expect(coverageHelper).toContain("summarizeChangeEventVisualEvidence(rows)");
    expect(coverageHelper).toContain("public_unsuppressed");
  });
});
