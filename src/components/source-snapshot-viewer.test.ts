import { describe, expect, it } from "vitest";
import {
  selectPrimarySnapshotObject,
  snapshotInitialVersion,
  snapshotLocalizationLabel,
  snapshotRequestPath,
  snapshotUnavailableMessage,
} from "@/components/source-snapshot-viewer";
import { buildChangeEvidence } from "@/lib/change-evidence";

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
      "Exact location unavailable - full event screenshot. The location was ambiguous.",
    );
    const genericLabel = snapshotLocalizationLabel(genericSide, 0.4, "source_current");
    expect(genericLabel).toBe("Approximate text match in this retained source snapshot");
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

    expect(label).toBe(
      "Immutable event PDF - This PDF is AwardPing's first retained observation; no prior publisher version is asserted.",
    );
    expect(label).not.toMatch(/changed screenshot|full event screenshot|today/i);
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
