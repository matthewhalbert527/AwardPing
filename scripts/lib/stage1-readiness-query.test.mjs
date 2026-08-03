import { describe, expect, it, vi } from "vitest";
import {
  fetchExactRows,
  fetchExactStableChunkedRows,
  fetchExactStableRows,
} from "./stage1-readiness-query.mjs";

describe("Stage 1 exact readiness pagination", () => {
  it("requires an exact count instead of accepting a capped or ambiguous result", async () => {
    const buildQuery = querySequence([
      { data: [{ id: "row-1" }], error: null, count: null },
    ]);

    await expect(fetchExactStableRows(buildQuery, "quarantine evidence"))
      .rejects.toMatchObject({ code: "stage1_exact_count_unavailable" });
  });

  it("rejects repeated identities across deterministic pages", async () => {
    const buildQuery = querySequence([
      { data: [{ id: "row-1" }, { id: "row-2" }], error: null, count: 3 },
      { data: [{ id: "row-2" }], error: null, count: 3 },
    ]);

    await expect(fetchExactStableRows(buildQuery, "quarantine evidence", { pageSize: 2 }))
      .rejects.toMatchObject({ code: "stage1_query_identity_repeated" });
  });

  it("requires two complete reads to have the same material revision", async () => {
    const buildQuery = querySequence([
      { data: [{ id: "row-1", status: "quarantined" }], error: null, count: 1 },
      { data: [{ id: "row-1", status: "resolved" }], error: null, count: 1 },
    ]);

    await expect(fetchExactStableRows(buildQuery, "quarantine evidence"))
      .rejects.toMatchObject({ code: "stage1_query_revision_changed" });
  });

  it("returns the exact rows only after count, identity, and revision converge", async () => {
    const rows = [
      { id: "row-1", status: "quarantined" },
      { id: "row-2", status: "in_review" },
      { id: "row-3", status: "resolved" },
    ];
    const buildQuery = querySequence([
      { data: rows.slice(0, 2), error: null, count: 3 },
      { data: rows.slice(2), error: null, count: 3 },
      { data: rows.slice(0, 2), error: null, count: 3 },
      { data: rows.slice(2), error: null, count: 3 },
    ]);

    await expect(fetchExactStableRows(buildQuery, "quarantine evidence", { pageSize: 2 }))
      .resolves.toEqual(rows);
    expect(buildQuery).toHaveBeenCalledTimes(4);
  });

  it("supports one exact paginated pass when a stable outer chunk loader verifies revision", async () => {
    const rows = [
      { id: "row-1", status: "quarantined" },
      { id: "row-2", status: "in_review" },
      { id: "row-3", status: "resolved" },
    ];
    const buildQuery = querySequence([
      { data: rows.slice(0, 2), error: null, count: 3 },
      { data: rows.slice(2), error: null, count: 3 },
    ]);

    await expect(fetchExactRows(buildQuery, "chunk pass", { pageSize: 2 }))
      .resolves.toEqual(rows);
    expect(buildQuery).toHaveBeenCalledTimes(2);
  });
});

describe("Stage 1 cross-chunk readiness consistency", () => {
  it("rejects a complete snapshot that changes between chunk passes", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce([{ id: "award-1", status: "verified_beta" }])
      .mockResolvedValueOnce([{ id: "award-2", status: "pending" }])
      .mockResolvedValueOnce([{ id: "award-1", status: "revalidation_pending" }])
      .mockResolvedValueOnce([{ id: "award-2", status: "pending" }]);

    await expect(fetchExactStableChunkedRows({
      values: ["award-1", "award-2"],
      chunkSize: 1,
      run,
      label: "award release state",
    })).rejects.toMatchObject({ code: "stage1_chunked_query_revision_changed" });
  });

  it("rejects duplicate row identities returned by separate chunks", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce([{ id: "same-row" }])
      .mockResolvedValueOnce([{ id: "same-row" }]);

    await expect(fetchExactStableChunkedRows({
      values: ["chunk-1", "chunk-2"],
      chunkSize: 1,
      run,
    })).rejects.toMatchObject({ code: "stage1_query_identity_repeated" });
  });

  it("returns only after two complete cross-chunk passes converge", async () => {
    const rows = [
      { id: "award-1", status: "verified_beta" },
      { id: "award-2", status: "pending" },
    ];
    const run = vi
      .fn()
      .mockResolvedValueOnce([rows[0]])
      .mockResolvedValueOnce([rows[1]])
      .mockResolvedValueOnce([rows[0]])
      .mockResolvedValueOnce([rows[1]]);

    await expect(fetchExactStableChunkedRows({
      values: ["award-1", "award-2"],
      chunkSize: 1,
      run,
    })).resolves.toEqual(rows);
    expect(run).toHaveBeenCalledTimes(4);
  });
});

function querySequence(results) {
  const queue = [...results];
  return vi.fn(() => ({
    range: vi.fn(async () => {
      const result = queue.shift();
      if (!result) throw new Error("Unexpected readiness page request.");
      return result;
    }),
  }));
}
