import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  new URL("./capture-visual-snapshots.mjs", import.meta.url),
  "utf8",
);
const reconciliation = readFileSync(
  new URL("./lib/visual-snapshot-pointer-reconciliation.mjs", import.meta.url),
  "utf8",
);

describe("scheduled visual snapshot pointer wiring", () => {
  it("uploads immutable objects before CAS and cleans unreferenced losing uploads", () => {
    expect(source).toContain(
      "visual-snapshots/sources/${sourceId}/captures/${version}/${artifact.fileName}",
    );
    const upload = source.indexOf("const latestUpload = await uploadR2CaptureFiles");
    const upsert = source.indexOf("await upsertR2SnapshotRecord", upload);
    expect(upload).toBeGreaterThan(0);
    expect(upsert).toBeGreaterThan(upload);
    expect(source).toContain("reconcileVisualSnapshotPointerAdvance");
    expect(source).toContain("recordR2CleanupDebt(report, source, error?.r2Cleanup)");
    expect(source).toContain(
      "source_url, source_title, source_page_type, latest_captured_at",
    );
    expect(reconciliation).toContain("await advance()");
    expect(reconciliation).toContain("current = await reload()");
    expect(reconciliation).toContain("visualSnapshotUploadedKeysToDeleteAfterLostCas");
    expect(reconciliation).toContain("cleanupWithoutMasking");
    expect(reconciliation).toContain("visualSnapshotPointerExactlyMatchesProposal(current, proposed)");
  });
});
