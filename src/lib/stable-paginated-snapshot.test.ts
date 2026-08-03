import { describe, expect, it } from "vitest";
import {
  loadStablePaginatedSnapshot,
  stableJsonStringify,
} from "@/lib/stable-paginated-snapshot";

type Row = { id: string; value: string; metadata: Record<string, unknown> };

function rows(count: number): Row[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `row-${String(index).padStart(4, "0")}`,
    value: `value-${index}`,
    metadata: { index },
  }));
}

function snapshotOptions(loadPage: (start: number, end: number) => Promise<{
  rows: Row[];
  count: number | null;
  error: string | null;
}>) {
  return {
    pageSize: 500,
    renderLimit: 500,
    loadPage,
    identity: (row: Row) => row.id,
    fingerprint: (row: Row) => stableJsonStringify(row),
  };
}

describe("stable paginated snapshots", () => {
  it("reports a verified exact total while rendering only the configured limit", async () => {
    const source = rows(900);
    const result = await loadStablePaginatedSnapshot(snapshotOptions(async (start, end) => ({
      rows: source.slice(start, end + 1),
      count: source.length,
      error: null,
    })));

    expect(result).toMatchObject({
      exactTotal: 900,
      errorCode: null,
    });
    expect(result.rows).toHaveLength(500);
  });

  it("rejects stable-count ID drift between verification passes", async () => {
    const first = rows(900);
    const second = [...first.slice(1), {
      id: "row-0900",
      value: "replacement",
      metadata: { index: 900 },
    }];
    let call = 0;
    const result = await loadStablePaginatedSnapshot(snapshotOptions(async (start, end) => {
      const source = call++ < 2 ? first : second;
      return { rows: source.slice(start, end + 1), count: 900, error: null };
    }));

    expect(result.exactTotal).toBeNull();
    expect(result.errorCode).toBe("snapshot_changed");
    expect(result.rows).toHaveLength(500);
  });

  it("rejects stable-count content drift between verification passes", async () => {
    const first = rows(900);
    const second = first.map((row, index) => index === 700
      ? { ...row, value: "changed-without-count-change" }
      : row);
    let call = 0;
    const result = await loadStablePaginatedSnapshot(snapshotOptions(async (start, end) => {
      const source = call++ < 2 ? first : second;
      return { rows: source.slice(start, end + 1), count: 900, error: null };
    }));

    expect(result.exactTotal).toBeNull();
    expect(result.errorCode).toBe("snapshot_changed");
  });

  it("counts exclusions across every page without hiding the verified total", async () => {
    const source = rows(900);
    const result = await loadStablePaginatedSnapshot({
      ...snapshotOptions(async (start, end) => ({
        rows: source.slice(start, end + 1),
        count: source.length,
        error: null,
      })),
      include: (row) => Number(row.metadata.index) % 3 !== 0,
    });

    expect(result.exactTotal).toBe(600);
    expect(result.rows).toHaveLength(500);
  });
});
