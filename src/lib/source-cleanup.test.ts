import { describe, expect, it } from "vitest";
import { buildPostCrawlCleanupModel, cleanupActions } from "../../scripts/source-cleanup-core.mjs";

const award = {
  id: "award-1",
  name: "National Institutes of Health (NIH) - Aging Research Dissertation Awards to Increase Diversity (R36)",
  official_homepage: null,
  status: "active",
};

function source(overrides: Record<string, unknown>) {
  return {
    id: "source-1",
    shared_award_id: award.id,
    url: "https://example.org/award",
    title: "Award page",
    page_type: "homepage",
    confidence: 0.9,
    source: "admin",
    last_error: null,
    last_checked_at: null,
    next_check_at: null,
    consecutive_failures: 0,
    updated_at: null,
    ...overrides,
  };
}

function actionFor(sources: Array<Record<string, unknown>>, sourceId: string) {
  const model = buildPostCrawlCleanupModel({ awards: [award], sources });
  return model.sourceRows.find((row: { source: { id: string } }) => row.source.id === sourceId);
}

describe("post-crawl source cleanup classification", () => {
  it("keeps blocked 403 and 429 sources", () => {
    expect(
      actionFor([source({ id: "blocked", last_error: "Fetch failed with HTTP 403." })], "blocked")?.action,
    ).toBe(cleanupActions.keepButBlocked);

    expect(
      actionFor([source({ id: "limited", last_error: "Fetch failed with HTTP 429." })], "limited")?.action,
    ).toBe(cleanupActions.keepButBlocked);
  });

  it("removes dead sources only when another useful source remains", () => {
    const rows = [
      source({ id: "dead", url: "https://example.org/old", last_error: "Fetch failed with HTTP 404." }),
      source({ id: "good", url: "https://example.org/current", last_error: null }),
    ];

    expect(actionFor(rows, "dead")?.action).toBe(cleanupActions.safeToRemove);
    expect(actionFor([rows[0]], "dead")?.action).toBe(cleanupActions.needsReplacement);
  });

  it("marks dead DNS only-source rows for replacement", () => {
    expect(
      actionFor([source({ id: "dns", url: "https://missing.example", last_error: "getaddrinfo ENOTFOUND missing.example" })], "dns")
        ?.action,
    ).toBe(cleanupActions.needsReplacement);
  });

  it("removes duplicate canonical URLs", () => {
    const rows = [
      source({ id: "keep", url: "https://www.pickeringfellowship.org/faq", confidence: 0.9 }),
      source({ id: "remove", url: "http://pickeringfellowship.org/faq/", confidence: 0.3 }),
    ];

    expect(actionFor(rows, "remove")?.action).toBe(cleanupActions.safeToRemove);
  });

  it("marks broad root agency homepages for replacement unless an award page remains", () => {
    const broadRoot = source({ id: "root", url: "https://www.nih.gov/", title: "National Institutes of Health" });
    const specific = source({
      id: "specific",
      url: "https://www.nia.nih.gov/research/training/r36-aging-research-dissertation-awards-promote-diversity",
      title: "R36 Aging Research Dissertation Awards",
    });

    expect(actionFor([broadRoot], "root")?.action).toBe(cleanupActions.needsReplacement);
    expect(actionFor([broadRoot, specific], "root")?.action).toBe(cleanupActions.safeToRemove);
  });

  it("keeps no-readable-text sources for manual review", () => {
    expect(
      actionFor([source({ id: "js", last_error: "No readable text was found on this URL." })], "js")?.action,
    ).toBe(cleanupActions.keepButBlocked);
  });

  it("does not remove trusted application or deadline sources because of generic URL shape", () => {
    const rows = [
      source({
        id: "deadline",
        url: "https://example.org/events/application-deadline",
        title: "Application Deadline",
        page_type: "deadline",
      }),
      source({ id: "good", url: "https://example.org/current", title: "Current award page" }),
    ];

    expect(actionFor(rows, "deadline")?.action).toBe(cleanupActions.noAction);
  });

  it("removes obvious boilerplate PDFs even though PDFs are protected source types", () => {
    const rows = [
      source({
        id: "login-pdf",
        url: "https://example.org/wp-content/uploads/Login-Instructions.pdf",
        title: "Login Instructions",
        page_type: "pdf",
      }),
      source({ id: "good", url: "https://example.org/current", title: "Current award page" }),
    ];

    expect(actionFor(rows, "login-pdf")?.action).toBe(cleanupActions.safeToRemove);
  });
});
