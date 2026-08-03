import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  RECONCILIATION_SNAPSHOT_CHANGED,
  RECONCILIATION_SNAPSHOT_UNSAFE_MAX,
  loadStablePaginatedRows,
} from "./reconciliation-candidate-snapshot.mjs";

function rows(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `candidate-${String(index).padStart(6, "0")}`,
    created_at: `2026-07-17T12:${String(index % 60).padStart(2, "0")}:00.000Z`,
    field_name: "deadline",
    normalized_value: `value-${index}`,
  }));
}

function pageFrom(values) {
  return async ({ offset, limit }) => values.slice(offset, offset + limit);
}

describe("stable reconciliation candidate snapshots", () => {
  it("loads every row above the former 5,000-row cutoff", async () => {
    const values = rows(6_005);
    let countCalls = 0;
    const snapshot = await loadStablePaginatedRows({
      countRows: async () => {
        countCalls += 1;
        return values.length;
      },
      loadPage: pageFrom(values),
      pageSize: 211,
      maxRows: 10_000,
    });

    expect(snapshot.exactCount).toBe(6_005);
    expect(snapshot.rows).toHaveLength(6_005);
    expect(snapshot.rows.at(-1)?.id).toBe("candidate-006004");
    expect(snapshot.pagesRead).toBe(58);
    expect(snapshot.rowsObserved).toBe(12_010);
    expect(snapshot.revisionSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(countCalls).toBe(3);
  });

  it("uses exact deterministic offsets even with a very small page size", async () => {
    const values = rows(7);
    const calls = [];
    const snapshot = await loadStablePaginatedRows({
      countRows: async () => values.length,
      loadPage: async (request) => {
        calls.push(request);
        return values.slice(request.offset, request.offset + request.limit);
      },
      pageSize: 2,
      maxRows: 20,
    });

    expect(snapshot.rows.map((row) => row.id)).toEqual(values.map((row) => row.id));
    expect(calls).toEqual([
      { offset: 0, limit: 2, pass: 1 },
      { offset: 2, limit: 2, pass: 1 },
      { offset: 4, limit: 2, pass: 1 },
      { offset: 6, limit: 1, pass: 1 },
      { offset: 0, limit: 2, pass: 2 },
      { offset: 2, limit: 2, pass: 2 },
      { offset: 4, limit: 2, pass: 2 },
      { offset: 6, limit: 1, pass: 2 },
    ]);
  });

  it("fails closed when the exact count changes between passes", async () => {
    const values = rows(4);
    const counts = [4, 5];
    await expect(loadStablePaginatedRows({
      countRows: async () => counts.shift(),
      loadPage: pageFrom(values),
      pageSize: 2,
      maxRows: 10,
    })).rejects.toMatchObject({ code: RECONCILIATION_SNAPSHOT_CHANGED });
  });

  it("fails closed when row content changes without changing the count", async () => {
    const first = rows(5);
    const second = rows(5).map((row, index) => index === 3
      ? { ...row, normalized_value: "mutated-during-read" }
      : row);
    await expect(loadStablePaginatedRows({
      countRows: async () => 5,
      loadPage: async ({ offset, limit, pass }) => {
        const values = pass === 1 ? first : second;
        return values.slice(offset, offset + limit);
      },
      pageSize: 2,
      maxRows: 10,
    })).rejects.toMatchObject({ code: RECONCILIATION_SNAPSHOT_CHANGED });
  });

  it("quarantines an unsafe exact total before loading any page", async () => {
    let pagesLoaded = 0;
    await expect(loadStablePaginatedRows({
      countRows: async () => 101,
      loadPage: async () => {
        pagesLoaded += 1;
        return [];
      },
      pageSize: 10,
      maxRows: 100,
    })).rejects.toMatchObject({ code: RECONCILIATION_SNAPSHOT_UNSAFE_MAX });
    expect(pagesLoaded).toBe(0);
  });
});

describe("reconciliation candidate snapshot wiring", () => {
  it("uses exact count, stable tie-break ordering, and range pagination", () => {
    const worker = readFileSync(
      new URL("../reconcile-impacted-award-pages.mjs", import.meta.url),
      "utf8",
    );
    expect(worker).toContain("loadStablePaginatedRows({");
    expect(worker).toContain('.select("id", { count: "exact", head: true })');
    expect(worker).toContain('.order("created_at", { ascending: false, nullsFirst: false })');
    expect(worker).toContain('.order("id", { ascending: false })');
    expect(worker).toContain(".range(offset, offset + pageLimit - 1)");
    expect(worker).toContain("revision_sha256: snapshot.revisionSha256");
    expect(worker).not.toContain(".limit(5000)");
  });
});
