import { describe, expect, it } from "vitest";
import { loadProgramTextSources } from "./program-text-worker.mjs";
import { rosterPageFixture } from "./fixtures/program-text-roster-pages.mjs";

const revision = "33333333-3333-4333-8333-333333333333", owner = "22222222-2222-4222-8222-222222222222";
function inventory(size = 1207) {
  const sources = Array.from({ length: size }, (_, index) => ({ id: `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    shared_award_id: owner, url: `https://example.org/source-${index}`, title: `Source ${index}`, page_type: "eligibility",
    admin_review_status: "open", text_monitoring_state: {} }));
  const roles = sources.map((source, index) => ({ cohort_key: `award_${index % 25}`, scope_key: index % 2 ? "track_one" : "common",
    source_role: `eligibility_${index}`, source_ids: [source.id], manifest_status: "reviewed_text", revision,
    evidence: { schema: "awardping.program-text-source-role.v1", source_bindings: { [source.id]: { source_url: source.url, shared_award_id: owner } } } }));
  return { sources, roles };
}
function database(values, mutate = () => {}) {
  const calls = [];
  return { calls, async rpc(name, params) {
    expect(name).toBe("get_program_text_worker_roster_page");
    calls.push(structuredClone(params));
    const response = rosterPageFixture(values.roles, values.sources)(params);
    mutate(response, params, calls.length);
    return response;
  } };
}

describe("complete sealed worker roster enumeration", () => {
  it("enumerates over1000 roles and over500 sources through bounded pages, sorted once per physical source", async () => {
    const values = inventory(); values.roles.reverse(); values.sources.reverse();
    const db = database(values), result = await loadProgramTextSources(db);
    expect(result.manifest).toHaveLength(1207); expect(result.sources).toHaveLength(1207);
    expect(result.sources.every(row => row.manifest_bound)).toBe(true);
    expect(result.sources.map(row => row.id)).toEqual([...values.sources.map(row => row.id)].sort());
    expect(db.calls.filter(call => call.p_kind === "roles")).toHaveLength(13);
    expect(db.calls.filter(call => call.p_kind === "sources")).toHaveLength(13);
    expect(db.calls.every(call => call.p_limit === 100)).toBe(true);
    expect(db.calls[0].p_expected_roster_seal).toBeNull();
    expect(db.calls.slice(1).every(call => call.p_expected_roster_seal === result.roster_seal)).toBe(true);
    expect(db.calls.at(-1)).toMatchObject({ p_kind: "check", p_after: null });
  });
  it("retains common/variation/alias roles while collecting one shared source only once", async () => {
    const values = inventory(1), original = values.roles[0];
    values.roles.push({ ...structuredClone(original), scope_key: "legacy_common" },
      { ...structuredClone(original), scope_key: "overseas" }, { ...structuredClone(original), cohort_key: "second_award" });
    const result = await loadProgramTextSources(database(values));
    expect(result.sources).toHaveLength(1); expect(result.manifest).toHaveLength(4);
    expect(result.sources[0]).toMatchObject({ manifest_bound: true, cohorts: ["award_0", "second_award"] });
    values.roles[1].evidence.source_bindings[original.source_ids[0]].shared_award_id = revision;
    expect((await loadProgramTextSources(database(values))).sources[0].manifest_bound).toBe(false);
  });
  it("permits mutable capture state to advance without treating it as a new source roster", async () => {
    const values = inventory(201);
    const result = await loadProgramTextSources(database(values, (_response, params) => {
      if (params.p_kind === "sources") values.sources.at(-1).text_monitoring_state = { status: "baseline_ready", successful_checks: 9 };
    }));
    expect(result.sources.at(-1).text_monitoring_state.successful_checks).toBe(9);
  });
  it.each(["roles", "sources", "check"])("rejects identity churn during %s enumeration", async kind => {
    const values = inventory(201);
    const db = database(values, (response, params, call) => {
      if (params.p_kind === kind && call > 1) response.data.roster_seal = "f".repeat(64);
    });
    await expect(loadProgramTextSources(db)).rejects.toThrow("changed during enumeration");
  });
  it.each(["role_count", "source_count", "cohort_count"])("rejects changed %s even with an unchanged seal", async field => {
    await expect(loadProgramTextSources(database(inventory(201), (response, _params, call) => {
      if (call === 2) response.data[field]++;
    }))).rejects.toThrow("changed during enumeration");
  });
  it.each(["roles", "sources"])("rejects a truncated non-final %s page", async kind => {
    await expect(loadProgramTextSources(database(inventory(201), (response, params) => {
      if (params.p_kind === kind && params.p_after === null) response.data.entries.pop();
    }))).rejects.toThrow("page is incomplete");
  });
  it.each(["roles", "sources"])("rejects premature final %s pages and never accepts partial coverage", async kind => {
    await expect(loadProgramTextSources(database(inventory(201), (response, params) => {
      if (params.p_kind === kind) response.data.next_cursor = null;
    }))).rejects.toThrow("identities are incomplete");
  });
  it.each(["roles", "sources"])("rejects duplicate %s keys within or across pages", async kind => {
    for (const crossPage of [false, true]) {
      let previousLast;
      await expect(loadProgramTextSources(database(inventory(201), (response, params) => {
        if (params.p_kind === kind) {
          if (crossPage && params.p_after !== null) response.data.entries[0] = previousLast;
          else if (!crossPage) response.data.entries[1] = structuredClone(response.data.entries[0]);
          previousLast = structuredClone(response.data.entries.at(-1));
        }
      }))).rejects.toThrow("duplicate or unordered");
    }
  });
  it("rejects a cursor that skips an unreturned row", async () => {
    await expect(loadProgramTextSources(database(inventory(201), (response, params) => {
      if (params.p_kind === "sources" && params.p_after === null) response.data.next_cursor = "10000000-0000-4000-8000-000000000199";
    }))).rejects.toThrow("page is incomplete");
  });
  it("rejects a same-count unknown source substitution and repeated IDs inside a role", async () => {
    const wrong = inventory(1); wrong.sources[0].id = revision;
    await expect(loadProgramTextSources(database(wrong))).rejects.toThrow("identities are incomplete");
    const duplicate = inventory(1); duplicate.roles[0].source_ids.push(duplicate.sources[0].id);
    await expect(loadProgramTextSources(database(duplicate))).rejects.toThrow("role is invalid");
  });
  it.each([null, {}, { entries: [] }])("rejects malformed or missing page envelopes %j", async data => {
    await expect(loadProgramTextSources({ rpc: async () => ({ data }) })).rejects.toThrow("missing or incomplete");
  });
  it("refuses a nonempty final check and strips database error messages", async () => {
    await expect(loadProgramTextSources(database(inventory(1), (response, params) => {
      if (params.p_kind === "check") response.data.entries.push({ secret: "not-loggable" });
    }))).rejects.toThrow("final check is invalid");
    const db = { rpc: async () => ({ error: { code: "40001", message: "private response details" } }) };
    await expect(loadProgramTextSources(db)).rejects.toThrow("database request failed (40001)");
  });
});
