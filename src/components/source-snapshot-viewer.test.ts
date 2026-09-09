import { describe, expect, it } from "vitest";
import {
  selectPrimarySnapshotObject,
  snapshotInitialVersion,
  snapshotLocalizationLabel,
  snapshotRequestPath,
  snapshotUnavailableMessage,
} from "@/components/source-snapshot-viewer";
import { buildChangeEvidence } from "@/lib/change-evidence";

type SnapshotSide = NonNullable<Parameters<typeof snapshotLocalizationLabel>[0]>;

describe("source snapshot viewer evidence selection", () => {
  const evidence = buildChangeEvidence({
    sourceUrl: "https://example.edu/award",
    sourceTitle: "Award deadline",
    summary: "The application deadline changed.",
    previousTextSample: "Applications close April 1.",
    newTextSample: "Applications close April 15.",
    changeDetails: {
      structured_diff: {
        added_text: ["Applications close April 15."],
        removed_text: ["Applications close April 1."],
      },
    },
  });

  it("uses the event-specific endpoint whenever a change event is available", () => {
    expect(snapshotRequestPath("source-1", evidence, "event/1")).toBe(
      "/api/change-events/event%2F1/visual-evidence",
    );
  });

  it("opens removed wording on Previous and other semantic directions on Current", () => {
    expect(snapshotInitialVersion("removed")).toBe("previous");
    expect(snapshotInitialVersion("added")).toBe("latest");
    expect(snapshotInitialVersion("mixed")).toBe("latest");
    expect(snapshotInitialVersion("changed")).toBe("latest");
  });

  it("keeps the generic current-source endpoint for source-only viewing", () => {
    const path = snapshotRequestPath("source-1", evidence);

    expect(path).toMatch(/^\/api\/source-snapshots\/source-1\?/);
    expect(path).toContain("latest=");
    expect(path).toContain("previous=");
  });

  it("shows a crop only when the API marks it as verified exact overlap", () => {
    const crop = { key: "published/crop.jpg", url: "https://signed.test/crop" };
    const full = { key: "published/full.jpg", url: "https://signed.test/full" };

    expect(
      selectPrimarySnapshotObject({
        captured_at: null,
        exact_overlap: true,
        objects: { crop, full },
      }),
    ).toMatchObject({ evidenceKind: "verified_crop", key: crop.key });
    expect(
      selectPrimarySnapshotObject({
        captured_at: null,
        exact_overlap: false,
        objects: { crop, full },
      }),
    ).toMatchObject({ evidenceKind: "event_full", key: full.key });
  });

  it("describes event fallback honestly and never calls generic matching a changed section", () => {
    const eventSide = {
      captured_at: null,
      exact_overlap: false,
      localization_reason: "The location was ambiguous.",
      objects: {
        full: { key: "published/full.jpg", url: "https://signed.test/full" },
      },
    };
    const genericSide = {
      captured_at: null,
      localization_status: "localized",
      objects: {
        page: { key: "mutable/page.jpg", url: "https://signed.test/page" },
      },
    };

    expect(snapshotLocalizationLabel(eventSide, null, "change_event")).toBe(
      "Screenshot; change location unavailable",
    );
    const genericLabel = snapshotLocalizationLabel(genericSide, 0.4, "source_current");
    expect(genericLabel).toBe("Approximate text match");
    expect(genericLabel).not.toMatch(/changed section/i);
  });

  it("labels first-observed PDF evidence without calling it a changed screenshot", () => {
    const label = snapshotLocalizationLabel(
      {
        captured_at: "2026-07-16T18:00:00.000Z",
        kind: "pdf",
        localization_reason:
          "This PDF is AwardPing's first retained observation; no prior publisher version is asserted.",
        objects: {
          full: {
            key: "visual-snapshots/published/event-1/current/document.pdf",
            url: "https://signed.test/document.pdf",
            content_type: "application/pdf",
          },
        },
      },
      null,
      "change_event",
    );

    expect(label).toBe("Saved PDF");
    expect(label).not.toMatch(/changed screenshot|full event screenshot|today/i);
  });

  it.each(["change_event", "source_current"] as const)(
    "labels the selected PDF consistently for %s without exposing capture diagnostics",
    (scope) => {
      const pdf = { key: "document.pdf", url: "https://signed.test/document.pdf", content_type: "application/pdf" };
      const sides: SnapshotSide[] = [
        { captured_at: null, kind: "pdf", objects: { full: pdf } },
        { captured_at: null, objects: { full: pdf } },
        { captured_at: null, objects: { pdf } },
      ];
      for (const side of sides) {
        const snapshot = { ...side, localization_reason: "PDF evidence is retained but does not use webpage crop localization." };
        const before = structuredClone(snapshot);
        expect(snapshotLocalizationLabel(snapshot, 0.5, scope)).toBe("Saved PDF");
        expect(snapshot).toEqual(before);
      }
    },
  );

  it("describes the selected image even when unused metadata identifies a PDF", () => {
    const snapshot = {
      captured_at: null,
      kind: "pdf",
      exact_overlap: true,
      objects: {
        crop: { key: "crop.jpg", url: "https://signed.test/crop.jpg" },
        full: { key: "document.pdf", url: "https://signed.test/document.pdf", content_type: "application/pdf" },
      },
    };
    expect(snapshotLocalizationLabel(snapshot, null, "change_event")).toBe("Highlighted change area");
  });

  it("does not claim an exact highlight without both exact overlap and a crop", () => {
    const full = { key: "full.jpg", url: "https://signed.test/full.jpg" };
    const crop = { key: "crop.jpg", url: "https://signed.test/crop.jpg" };
    const sides: SnapshotSide[] = [
      { captured_at: null, exact_overlap: false, objects: { full, crop } },
      { captured_at: null, exact_overlap: true, objects: { full } },
      { captured_at: null, objects: { thumb: crop } },
    ];
    for (const side of sides) {
      const snapshot = { ...side, localization_reason: "Internal crop localization diagnostic." };
      expect(snapshotLocalizationLabel(snapshot, null, "change_event")).toBe("Screenshot; change location unavailable");
    }
  });

  it.each([
    ["historical_layout_unavailable", "Older screenshot; highlight unavailable"],
    ["capture_layout_unavailable", "Screenshot highlight unavailable"],
    ["evidence_not_found", "Changed text not found in this screenshot"],
    ["not_requested", "No change text available to highlight"],
    ["not_applicable", "Screenshot without a highlighted passage"],
    ["unknown_status", "Highlight unavailable"],
  ])("uses plain, bounded wording for source screenshot status %s", (status, expected) => {
    const snapshot = {
      captured_at: null,
      localization_status: status,
      localization_reason: "Internal capture-layout diagnostic.",
      objects: { page: { key: "page.jpg", url: "https://signed.test/page.jpg" } },
    };
    const before = structuredClone(snapshot);
    expect(snapshotLocalizationLabel(snapshot, null, "source_current")).toBe(expected);
    expect(snapshot).toEqual(before);
  });

  it("does not label a missing asset as an available screenshot or PDF", () => {
    for (const scope of ["change_event", "source_current"] as const) {
      expect(snapshotLocalizationLabel(null, null, scope)).toBe("Screenshot unavailable");
      expect(snapshotLocalizationLabel({ captured_at: null, kind: "pdf", objects: {} }, null, scope)).toBe("Screenshot unavailable");
    }
  });

  it("labels unrecoverable historical artifacts truthfully", () => {
    expect(snapshotUnavailableMessage({
      evidence_status: "historical_artifact_unrecoverable",
    })).toBe(
      "Historical visual evidence unavailable - retained artifacts could not be recovered for this update.",
    );
    expect(snapshotUnavailableMessage(null)).toBe(
      "Exact visual evidence is unavailable for this update.",
    );
  });
});
