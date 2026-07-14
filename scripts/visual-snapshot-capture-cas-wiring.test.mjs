import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  new URL("./capture-visual-snapshots.mjs", import.meta.url),
  "utf8",
);

describe("scheduled visual snapshot pointer wiring", () => {
  it("uploads immutable objects before CAS and cleans unreferenced losing uploads", () => {
    expect(source).toContain(
      "visual-snapshots/sources/${sourceId}/captures/${version}/${file.fileName}",
    );
    const upsertStart = source.indexOf("async function upsertR2SnapshotRecord");
    const upsertEnd = source.indexOf("function captureR2Files", upsertStart);
    const body = source.slice(upsertStart, upsertEnd);
    const cas = body.indexOf("await advanceVisualSnapshotPointer");
    const reload = body.indexOf("await loadR2SnapshotRecord", cas);
    const cleanup = body.indexOf("visualSnapshotUploadedKeysToDeleteAfterLostCas", reload);
    const deletion = body.indexOf("deleteR2Object", cleanup);
    expect(cas).toBeGreaterThan(0);
    expect(reload).toBeGreaterThan(cas);
    expect(cleanup).toBeGreaterThan(reload);
    expect(deletion).toBeGreaterThan(cleanup);
  });
});
