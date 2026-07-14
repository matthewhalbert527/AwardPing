import { describe, expect, it, vi } from "vitest";
import {
  applyAscendingAwardKeyset,
  ascendingAwardKeysetFilter,
  awardCursorAfterPage,
} from "./award-keyset-pagination.mjs";

describe("award keyset pagination", () => {
  it("orders every page by the requested column and the unique id tie-breaker", () => {
    const query = queryRecorder();

    expect(applyAscendingAwardKeyset(query, "created_at")).toBe(query);
    expect(query.order).toHaveBeenNthCalledWith(1, "created_at", { ascending: true });
    expect(query.order).toHaveBeenNthCalledWith(2, "id", { ascending: true });
    expect(query.or).not.toHaveBeenCalled();
  });

  it("keeps rows tied across a 1,000-row name boundary on the next page", () => {
    const tiedRows = Array.from({ length: 1_063 }, (_, index) => ({
      id: uuidFor(index + 1),
      name: "Repeated Award",
    }));
    const cursor = awardCursorAfterPage(tiedRows.slice(0, 1_000), "name");

    expect(cursor).toEqual({
      sortValue: "Repeated Award",
      id: uuidFor(1_000),
    });
    expect(ascendingAwardKeysetFilter("name", cursor)).toBe(
      `name.gt."Repeated Award",and(name.eq."Repeated Award",id.gt.${uuidFor(1_000)})`,
    );
    expect(tiedRows.slice(1_000).every((row) => row.id > cursor.id)).toBe(true);
  });

  it("quotes reserved PostgREST characters in award names", () => {
    const name = 'Award, "Special" (2026)';
    const id = uuidFor(20);

    expect(ascendingAwardKeysetFilter("name", { sortValue: name, id })).toBe(
      `name.gt.${JSON.stringify(name)},and(name.eq.${JSON.stringify(name)},id.gt.${id})`,
    );
  });
});

function queryRecorder() {
  const query = {
    order: vi.fn(() => query),
    or: vi.fn(() => query),
  };
  return query;
}

function uuidFor(value) {
  return `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}
