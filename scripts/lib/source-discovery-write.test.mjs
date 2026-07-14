import { describe, expect, it } from "vitest";
import { insertedDiscoveryRows } from "./source-discovery-write.mjs";

describe("source discovery insert accounting", () => {
  const requested = [
    { url: "https://example.edu/apply", admin_review_status: "open" },
    { url: "https://example.edu/guide.pdf", admin_review_status: "review_later" },
  ];

  it("treats an empty trigger or conflict result as zero inserted rows", () => {
    expect(insertedDiscoveryRows(requested, [])).toEqual([]);
    expect(insertedDiscoveryRows(requested, null)).toEqual([]);
  });

  it("counts only rows authoritatively returned by Supabase", () => {
    expect(
      insertedDiscoveryRows(requested, [
        { id: "source-2", url: "https://example.edu/guide.pdf" },
      ]),
    ).toEqual([requested[1]]);
  });

  it("does not double-count a duplicate requested URL", () => {
    expect(
      insertedDiscoveryRows(
        [...requested, { ...requested[0] }],
        [{ id: "source-1", url: "https://example.edu/apply" }],
      ),
    ).toEqual([requested[0]]);
  });
});
