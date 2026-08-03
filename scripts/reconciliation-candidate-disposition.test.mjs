import { describe, expect, it } from "vitest";
import {
  buildAtomicCandidateChanges,
  buildCandidateDispositionEntries,
} from "./lib/award-fact-reconciliation.mjs";

const WINNER_ID = "11111111-1111-4111-8111-111111111111";
const LOSER_ID = "22222222-2222-4222-8222-222222222222";
const REJECTED_ID = "33333333-3333-4333-8333-333333333333";

describe("reconciliation candidate disposition", () => {
  it("preserves a valid non-winning generated candidate as neutral superseded evidence", () => {
    const winner = candidate(WINNER_ID);
    const loser = candidate(LOSER_ID);
    const rejected = candidate(REJECTED_ID);
    const reconciliation = {
      selected: {
        eligibility: selection(winner),
      },
      rejected: [{
        candidate: rejected,
        reason: "missing_exact_evidence",
      }],
      candidates: [winner, loser, rejected],
    };

    const changes = buildAtomicCandidateChanges({
      preparedGeneratedCandidates: [winner, loser, rejected].map(prepared),
      reconciliation,
      conflictFields: new Set(),
    });
    const byId = new Map(
      changes.generatedCandidateRows.map((row) => [row.id, row]),
    );

    expect(byId.get(WINNER_ID)).toEqual(expect.objectContaining({
      candidate_status: "selected",
      selected_reason: "selected_eligibility_primary_identity_1.00",
      rejection_reason: null,
    }));
    expect(byId.get(LOSER_ID)).toEqual(expect.objectContaining({
      candidate_status: "superseded",
      selected_reason: null,
      rejection_reason: null,
      evidence_quote: "Exact official evidence",
    }));
    expect(byId.get(REJECTED_ID)).toEqual(expect.objectContaining({
      candidate_status: "rejected",
      selected_reason: null,
      rejection_reason: "missing_exact_evidence",
    }));
    expect(changes.candidateStatusUpdates).toEqual([]);
  });

  it("CAS-updates a former winner to superseded without falsely rejecting it", () => {
    const generatedWinner = candidate(WINNER_ID);
    const existingLoser = candidate(LOSER_ID, {
      candidate_status: "selected",
      selected_reason: "prior_winner",
      updated_at: "2026-07-17T06:00:00.000Z",
    });
    const reconciliation = {
      selected: {
        eligibility: selection(generatedWinner),
      },
      rejected: [],
      candidates: [generatedWinner, existingLoser],
    };

    const changes = buildAtomicCandidateChanges({
      preparedGeneratedCandidates: [prepared(generatedWinner)],
      reconciliation,
      conflictFields: new Set(),
    });

    expect(changes.candidateStatusUpdates).toEqual([{
      id: LOSER_ID,
      expected_status: "selected",
      expected_updated_at: "2026-07-17T06:00:00.000Z",
      candidate_status: "superseded",
      selected_reason: null,
      rejection_reason: null,
    }]);
  });

  it("CAS-promotes previously superseded evidence when it later wins", () => {
    const reconsideredWinner = candidate(WINNER_ID, {
      candidate_status: "superseded",
      updated_at: "2026-07-17T06:05:00.000Z",
    });
    const reconciliation = {
      selected: {
        eligibility: selection(reconsideredWinner),
      },
      rejected: [],
      candidates: [reconsideredWinner],
    };

    const changes = buildAtomicCandidateChanges({
      preparedGeneratedCandidates: [],
      reconciliation,
      conflictFields: new Set(),
    });

    expect(changes.generatedCandidateRows).toEqual([]);
    expect(changes.candidateStatusUpdates).toEqual([{
      id: WINNER_ID,
      expected_status: "superseded",
      expected_updated_at: "2026-07-17T06:05:00.000Z",
      candidate_status: "selected",
      selected_reason: "selected_eligibility_primary_identity_1.00",
      rejection_reason: null,
    }]);
  });

  it("emits true no-op CAS assertions for every existing reconciliation contributor", () => {
    const stableWinner = candidate(WINNER_ID, {
      candidate_status: "selected",
      selected_reason: "selected_eligibility_primary_identity_1.00",
      rejection_reason: null,
      updated_at: "2026-07-17T06:05:00.000Z",
    });
    const stableLoser = candidate(LOSER_ID, {
      candidate_status: "superseded",
      selected_reason: null,
      rejection_reason: null,
      updated_at: "2026-07-17T06:06:00.000Z",
    });
    const stableRejection = candidate(REJECTED_ID, {
      candidate_status: "rejected",
      selected_reason: null,
      rejection_reason: "missing_exact_evidence",
      updated_at: "2026-07-17T06:07:00.000Z",
    });
    const reconciliation = {
      selected: { eligibility: selection(stableWinner) },
      rejected: [{
        candidate: stableRejection,
        reason: "missing_exact_evidence",
      }],
      candidates: [stableWinner, stableLoser, stableRejection],
    };

    const changes = buildAtomicCandidateChanges({
      preparedGeneratedCandidates: [],
      reconciliation,
      conflictFields: new Set(),
    });

    expect(changes.generatedCandidateRows).toEqual([]);
    expect(changes.candidateStatusUpdates).toEqual([
      {
        id: WINNER_ID,
        expected_status: "selected",
        expected_updated_at: "2026-07-17T06:05:00.000Z",
        candidate_status: "selected",
        selected_reason: "selected_eligibility_primary_identity_1.00",
        rejection_reason: null,
      },
      {
        id: REJECTED_ID,
        expected_status: "rejected",
        expected_updated_at: "2026-07-17T06:07:00.000Z",
        candidate_status: "rejected",
        selected_reason: null,
        rejection_reason: "missing_exact_evidence",
      },
      {
        id: LOSER_ID,
        expected_status: "superseded",
        expected_updated_at: "2026-07-17T06:06:00.000Z",
        candidate_status: "superseded",
        selected_reason: null,
        rejection_reason: null,
      },
    ]);
  });

  it("emits CAS mutations for every status or disposition-reason change", () => {
    const reasonChangedWinner = candidate(WINNER_ID, {
      candidate_status: "selected",
      selected_reason: "prior_selection_reason",
      rejection_reason: null,
      updated_at: "2026-07-17T06:05:00.000Z",
    });
    const statusChangedLoser = candidate(LOSER_ID, {
      candidate_status: "pending",
      selected_reason: null,
      rejection_reason: null,
      updated_at: "2026-07-17T06:06:00.000Z",
    });
    const newlyRejected = candidate(REJECTED_ID, {
      candidate_status: "pending",
      selected_reason: null,
      rejection_reason: null,
      updated_at: "2026-07-17T06:07:00.000Z",
    });
    const reconciliation = {
      selected: { eligibility: selection(reasonChangedWinner) },
      rejected: [{
        candidate: newlyRejected,
        reason: "missing_exact_evidence",
      }],
      candidates: [
        reasonChangedWinner,
        statusChangedLoser,
        newlyRejected,
      ],
    };

    const changes = buildAtomicCandidateChanges({
      preparedGeneratedCandidates: [],
      reconciliation,
      conflictFields: new Set(),
    });
    const byId = new Map(
      changes.candidateStatusUpdates.map((mutation) => [mutation.id, mutation]),
    );

    expect(changes.candidateStatusUpdates).toHaveLength(3);
    expect(byId.get(WINNER_ID)).toEqual(expect.objectContaining({
      expected_status: "selected",
      candidate_status: "selected",
      selected_reason: "selected_eligibility_primary_identity_1.00",
    }));
    expect(byId.get(LOSER_ID)).toEqual(expect.objectContaining({
      expected_status: "pending",
      candidate_status: "superseded",
    }));
    expect(byId.get(REJECTED_ID)).toEqual(expect.objectContaining({
      expected_status: "pending",
      candidate_status: "rejected",
      rejection_reason: "missing_exact_evidence",
    }));
  });

  it("keeps the selected candidate conflicted while superseding valid alternatives", () => {
    const winner = candidate(WINNER_ID, { field_name: "deadline" });
    const loser = candidate(LOSER_ID, { field_name: "deadline" });
    const reconciliation = {
      selected: { deadline: selection(winner) },
      rejected: [],
      candidates: [winner, loser],
    };

    const dispositions = buildCandidateDispositionEntries(
      reconciliation,
      new Set(["deadline"]),
    );
    const byId = new Map(
      dispositions.map((disposition) => [
        disposition.candidate.id,
        disposition,
      ]),
    );

    expect(byId.get(WINNER_ID)?.candidate_status).toBe("conflicted");
    expect(byId.get(LOSER_ID)).toEqual(expect.objectContaining({
      candidate_status: "superseded",
      selected_reason: null,
      rejection_reason: null,
    }));
  });

  it("still fails closed when a generated row is absent from reconciliation", () => {
    const orphan = candidate(WINNER_ID);

    expect(() => buildAtomicCandidateChanges({
      preparedGeneratedCandidates: [prepared(orphan)],
      reconciliation: { selected: {}, rejected: [], candidates: [] },
      conflictFields: new Set(),
    })).toThrow(
      `Generated fact candidate ${WINNER_ID} has no reconciliation disposition.`,
    );
  });

  it("fails closed when an unchanged existing contributor lacks a CAS version", () => {
    const stableWinner = candidate(WINNER_ID, {
      candidate_status: "selected",
      selected_reason: "selected_eligibility_primary_identity_1.00",
      rejection_reason: null,
      updated_at: null,
    });

    expect(() => buildAtomicCandidateChanges({
      preparedGeneratedCandidates: [],
      reconciliation: {
        selected: { eligibility: selection(stableWinner) },
        rejected: [],
        candidates: [stableWinner],
      },
      conflictFields: new Set(),
    })).toThrow(
      `Existing fact candidate ${WINNER_ID} is missing its CAS version.`,
    );
  });

  it("fails closed before persistence if a terminal rejection is revived", () => {
    const terminalCandidate = candidate(REJECTED_ID, {
      candidate_status: "rejected",
      rejection_reason: "missing_exact_evidence",
      updated_at: "2026-07-17T06:10:00.000Z",
    });
    const reconciliation = {
      selected: {
        eligibility: selection(terminalCandidate),
      },
      rejected: [],
      candidates: [terminalCandidate],
    };

    expect(() => buildAtomicCandidateChanges({
      preparedGeneratedCandidates: [],
      reconciliation,
      conflictFields: new Set(),
    })).toThrow(
      `Rejected fact candidate ${REJECTED_ID} is terminal and its material state cannot change.`,
    );
  });

  it("fails closed before persistence if a terminal rejection reason changes", () => {
    const terminalCandidate = candidate(REJECTED_ID, {
      candidate_status: "rejected",
      rejection_reason: "prior_rejection_reason",
      updated_at: "2026-07-17T06:10:00.000Z",
    });
    const reconciliation = {
      selected: {},
      rejected: [{
        candidate: terminalCandidate,
        reason: "different_rejection_reason",
      }],
      candidates: [terminalCandidate],
    };

    expect(() => buildAtomicCandidateChanges({
      preparedGeneratedCandidates: [],
      reconciliation,
      conflictFields: new Set(),
    })).toThrow(
      `Rejected fact candidate ${REJECTED_ID} is terminal and its material state cannot change.`,
    );
  });

  it("atomically classifies the observed 210 valid non-winners", () => {
    const candidates = Array.from(
      { length: 211 },
      (_, index) => candidate(uuidFor(index + 1)),
    );
    const reconciliation = {
      selected: { eligibility: selection(candidates[0]) },
      rejected: [],
      candidates,
    };

    const changes = buildAtomicCandidateChanges({
      preparedGeneratedCandidates: candidates.map(prepared),
      reconciliation,
      conflictFields: new Set(),
    });

    expect(changes.generatedCandidateRows).toHaveLength(211);
    expect(changes.generatedCandidateRows.filter(
      (row) => row.candidate_status === "selected",
    )).toHaveLength(1);
    expect(changes.generatedCandidateRows.filter(
      (row) => row.candidate_status === "superseded" &&
        row.selected_reason === null &&
        row.rejection_reason === null,
    )).toHaveLength(210);
  });
});

function candidate(id, overrides = {}) {
  return {
    id,
    shared_award_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    shared_award_source_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    field_name: "eligibility",
    raw_value: ["Eligible applicants"],
    normalized_value: ["Eligible applicants"],
    evidence_quote: "Exact official evidence",
    evidence_location: "Eligibility",
    candidate_status: "pending",
    updated_at: null,
    ...overrides,
  };
}

function selection(value) {
  return {
    candidate: value,
    reason: "selected_eligibility_primary_identity_1.00",
    score: 143,
    source: null,
    value: value.normalized_value,
  };
}

function prepared(value) {
  return {
    row: {
      ...value,
      source_quality_decision: {},
      metadata: {},
    },
    candidate: value,
  };
}

function uuidFor(value) {
  return `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}
