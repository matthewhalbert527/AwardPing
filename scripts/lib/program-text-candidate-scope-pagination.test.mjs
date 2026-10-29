import { describe, expect, it } from "vitest";
import { createProgramTextRepository } from "./program-text-repository.mjs";
const epoch = "ec349339-ff62-4d2e-a610-8c361b4044ec";
const sourceId = n => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const candidateId = n => `20000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const sources = Array.from({ length: 701 }, (_, index) => sourceId(index));
function candidate(n, source, timestamp, rank) {
  return { id: candidateId(n), shared_award_source_id: sourceId(source), candidate_scope: "program_text_change",
    worker_metadata: { epoch }, status: "pending", created_at: timestamp, database_order: rank };
}
function database(rows, mutate = () => {}) {
  const calls = [];
  return { calls, from() {
    const call = { filters: [], orders: [] }; calls.push(call);
    const q = { select: columns => { call.columns = columns; return q; }, eq: (key, value) => { call.filters.push(["eq", key, value]); return q; },
      in: (key, values) => { call.filters.push(["in", key, values]); return q; }, is: (key, value) => { call.filters.push(["is", key, value]); return q; }, order: key => { call.orders.push(key); return q; },
      limit: limit => { call.limit = limit; return q; }, then(yes, no) {
        let selected = rows.filter(row => call.filters.every(([op, key, value]) => {
          const actual = key.startsWith("worker_metadata->>") ? row.worker_metadata[key.split("->>")[1]] : row[key];
          return op === "is" ? (actual ?? null) === value : op === "eq" ? actual === value : value.includes(actual);
        })).sort((a, b) => a.database_order - b.database_order || a.id.localeCompare(b.id));
        const count = selected.length; selected = selected.slice(0, call.limit);
        if (call.columns !== "*") selected = selected.map(({ id, created_at, shared_award_source_id }) => ({ id, created_at, shared_award_source_id }));
        selected = structuredClone(selected); mutate(selected, call, calls.length);
        return Promise.resolve({ data: selected, count }).then(yes, no);
      } }; return q;
  } };
}
const repository = db => createProgramTextRepository(db, { bucket: "private", loadCapture: () => { throw Error("No capture work in queue enumeration"); } });

describe("large approved-source candidate scope remains bounded", () => {
  it("selects globally oldest candidates across701 sources without losing PostgreSQL microseconds", async () => {
    const rows = [candidate(1, 0, "2026-10-26T17:00:00.123456Z", 3), candidate(999, 100, "2026-10-26T17:00:00.123455+00:00", 2),
      candidate(500, 200, "2026-10-26T18:00:00.123454+01:00", 0), candidate(998, 300, "2026-10-26T17:00:00.123455Z", 1)];
    const db = database(rows), result = await repository(db).listCandidates(["pending", "submitted", "succeeded"], 3, { source_ids: sources, epoch });
    expect(result.map(row => row.id)).toEqual([candidateId(500), candidateId(998), candidateId(999)]);
    expect(db.calls).toHaveLength(9);
    expect(db.calls.slice(0, -1).every(call => call.columns === "id,created_at,shared_award_source_id" && call.limit === 3)).toBe(true);
    expect(db.calls.flatMap(call => call.filters.filter(filter => filter[0] === "in").map(filter => filter[2].length)).every(size => size <= 100)).toBe(true);
    expect(db.calls.at(-1).filters.find(filter => filter[1] === "id")[2]).toHaveLength(3);
  });
  it("never broadens scope to fill a concurrently claimed vacancy", async () => {
    const rows = [candidate(1, 0, "2026-10-26T17:00:00.123455Z", 0), candidate(2, 100, "2026-10-26T17:00:00.123456Z", 1)];
    const db = database(rows, (page, call) => { if (call.columns === "*") page.shift(); });
    expect((await repository(db).listCandidates(["pending"], 2, { source_ids: sources, epoch })).map(row => row.id)).toEqual([candidateId(2)]);
    expect(db.calls.filter(call => call.columns === "*")).toHaveLength(1);
  });
  it.each([
    row => { row.shared_award_source_id = sourceId(9999); }, row => { row.worker_metadata.epoch = candidateId(99); },
    row => { row.status = "failed"; }, row => { row.candidate_scope = "content_change"; },
    row => { row.created_at = "2026-10-26T17:00:00.123457Z"; }, row => { row.worker_metadata.admin_alert_review_id = candidateId(1); },
  ])("rejects changed full-row identity, failed provider scope or epoch %#", async mutate => {
    const db = database([candidate(1, 0, "2026-10-26T17:00:00.123456Z", 0)], (page, call) => { if (call.columns === "*") mutate(page[0]); });
    await expect(repository(db).listCandidates(["pending"], 1, { source_ids: sources, epoch })).rejects.toThrow("identity changed");
  });
  it("rejects duplicated metadata/full rows rather than reviewing a source twice", async () => {
    for (const full of [false, true]) {
      const db = database([candidate(1, 0, "2026-10-26T17:00:00.123456Z", 0)], (page, call) => {
        if ((call.columns === "*") === full && page.length) page.push(structuredClone(page[0]));
      });
      await expect(repository(db).listCandidates(["pending"], 2, { source_ids: sources, epoch })).rejects.toThrow();
    }
  });
  it("detects a silently truncated metadata response from the API", async () => {
    const db = database([candidate(1, 0, "2026-10-26T17:00:00.123456Z", 0)], (page, call) => { if (call.columns !== "*") page.pop(); });
    await expect(repository(db).listCandidates(["pending"], 2, { source_ids: sources, epoch })).rejects.toThrow("Incomplete bounded");
  });
  it.each(["2026-02-30T17:00:00.123456Z", "2026-10-26T17:00:00.1234567Z", "2026-10-26T25:00:00Z", "not-a-date"])("fails closed on malformed exact timestamps %s", async timestamp => {
    await expect(repository(database([candidate(1, 0, timestamp, 0)])).listCandidates(["pending"], 1, { source_ids: sources, epoch })).rejects.toThrow("timestamp");
  });
  it("retains the existing small-scope query and cannot raise the global candidate cap", async () => {
    const db = database([]); await repository(db).listCandidates(["pending"], 20, { source_ids: sources.slice(0, 100), epoch });
    expect(db.calls).toHaveLength(1); expect(db.calls[0].columns).toBe("*");
    await expect(repository(db).listCandidates(["pending"], 101, { source_ids: sources, epoch })).rejects.toThrow("bounded");
    expect(db.calls).toHaveLength(1);
  });
  it.each([1, 100, 701])("waiting human reviews cannot starve later review work across%i source IDs", async sourceCount => {
    const rows = Array.from({ length: 101 }, (_, n) => ({ ...candidate(n + 1, n % sourceCount, "2026-10-26T17:00:00.000000Z", n),
      status: "succeeded", worker_metadata: { epoch, admin_alert_review_id: candidateId(n + 1) } }));
    rows.push(candidate(102, 0, "2026-10-26T17:00:01.000000Z", 102));
    const db = database(rows), found = await repository(db).listCandidates(["pending", "submitted", "succeeded"], 1,
      { source_ids: sources.slice(0, sourceCount), epoch });
    expect(found.map(row => row.id)).toEqual([candidateId(102)]);
    expect(db.calls.every(call => call.filters.some(([op,key,value]) => op === "is" && key === "worker_metadata->>admin_alert_review_id" && value === null))).toBe(true);
  });
  it("rejects a small-scope response that ignores the human-review exclusion", async () => {
    const db = database([candidate(1, 0, "2026-10-26T17:00:00.000000Z", 0)], page => { page[0].worker_metadata.admin_alert_review_id = candidateId(1); });
    await expect(repository(db).listCandidates(["succeeded", "pending"], 1, { source_ids: [sources[0]], epoch })).rejects.toThrow("Invalid selected");
  });
});
