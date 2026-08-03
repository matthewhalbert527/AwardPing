import { describe, expect, it } from "vitest";
import { stableRows } from "./stage1-manifest-draft-loader.mjs";

describe("Stage 1 manifest-draft stable loader", () => {
  it("returns rows only after two exact canonical passes match", async () => {
    const query = sequencedQuery([
      result(2, [{ id: "a", value: 1 }, { id: "b", value: 2 }]),
      result(2, [{ value: 1, id: "a" }, { value: 2, id: "b" }]),
    ]);
    await expect(stableRows(
      query.build,
      "test evidence",
      (row) => row.id,
    )).resolves.toEqual([{ value: 1, id: "a" }, { value: 2, id: "b" }]);
    expect(query.remaining()).toBe(0);
  });

  it("fails closed on revision drift, duplicate identities, partial pages, or unavailable counts", async () => {
    const drift = sequencedQuery([
      result(1, [{ id: "a", value: 1 }]),
      result(1, [{ id: "a", value: 2 }]),
    ]);
    await expect(stableRows(drift.build, "drift", (row) => row.id))
      .rejects.toThrow(/changed between/i);

    const duplicate = sequencedQuery([result(2, [{ id: "a" }, { id: "a" }])]);
    await expect(stableRows(duplicate.build, "duplicate", (row) => row.id))
      .rejects.toThrow(/duplicate row identity/i);

    const partial = sequencedQuery([result(2, [{ id: "a" }])]);
    await expect(stableRows(partial.build, "partial", (row) => row.id))
      .rejects.toThrow(/incomplete page/i);

    const noCount = sequencedQuery([{ data: [], count: null, error: null }]);
    await expect(stableRows(noCount.build, "count", (row) => row.id))
      .rejects.toThrow(/exact row count was unavailable/i);
  });

  it("propagates read errors and enforces the safety ceiling", async () => {
    const denied = sequencedQuery([{
      data: null,
      count: null,
      error: { code: "42501", message: "denied" },
    }]);
    await expect(stableRows(denied.build, "denied", (row) => row.id))
      .rejects.toThrow(/denied/i);

    const huge = sequencedQuery([result(2, [])]);
    await expect(stableRows(huge.build, "huge", (row) => row.id, { maxRows: 1 }))
      .rejects.toThrow(/safety ceiling/i);
  });
});

function result(count, data) {
  return { count, data, error: null };
}

function sequencedQuery(responses) {
  const queue = [...responses];
  return {
    remaining: () => queue.length,
    build() {
      return {
        async range() {
          if (!queue.length) throw new Error("Unexpected query");
          return queue.shift();
        },
      };
    },
  };
}
