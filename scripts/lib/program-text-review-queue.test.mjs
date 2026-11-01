import { describe, expect, it } from "vitest";
import { hasPotentialProgramTextReview } from "./program-text-review-queue.mjs";

const epoch = "ec349339-ff62-4d2e-a610-8c361b4044ec", sourceId = "11111111-1111-4111-8111-111111111111";
function database(rows, error = null) {
  const calls = [];
  return { calls, from(table) {
    calls.push(["from", table]);
    const query = Object.fromEntries(["select", "eq", "is", "in", "limit"].map(method => [method, (...args) => { calls.push([method, ...args]); return query; }]));
    query.then = (yes, no) => Promise.resolve({ data: rows, error }).then(yes, no);
    return query;
  } };
}
describe("cheap text review queue probe", () => {
  it("uses only one bounded metadata query and excludes legacy, wrong-epoch, failed and human-owned work", async () => {
    const db = database([]);
    expect(await hasPotentialProgramTextReview(db, { epoch })).toBe(false);
    expect(db.calls).toEqual([["from", "shared_award_visual_review_candidates"], ["select", "id"],
      ["eq", "candidate_scope", "program_text_change"], ["eq", "worker_metadata->>epoch", epoch],
      ["is", "worker_metadata->>admin_alert_review_id", null], ["in", "status", ["pending", "submitted", "succeeded"]], ["limit", 1]]);
  });
  it("treats a positive result only as a reason to run the existing authoritative checks", async () => {
    const db = database([{ id: sourceId }]);
    expect(await hasPotentialProgramTextReview(db, { epoch, sourceId })).toBe(true);
    expect(db.calls).toContainEqual(["eq", "shared_award_source_id", sourceId]);
  });
  it.each([null, {}, [{ id: "invalid" }], [{ id: sourceId }, { id: sourceId }]])("fails closed on malformed probe data %j", async rows => {
    await expect(hasPotentialProgramTextReview(database(rows), { epoch })).rejects.toThrow("probe failed");
  });
  it("does not turn a database failure into an idle result", async () => {
    await expect(hasPotentialProgramTextReview(database([], { code: "database" }), { epoch })).rejects.toThrow("probe failed");
  });
  it("rejects invalid scope before database access", async () => {
    const db = database([]);
    for (const scope of [{}, { epoch: "wrong" }, { epoch, sourceId: "wrong" }]) await expect(hasPotentialProgramTextReview(db, scope)).rejects.toThrow("probe scope");
    expect(db.calls).toEqual([]);
  });
});
