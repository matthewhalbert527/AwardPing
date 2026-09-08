import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { publicAwardFactsFromAward } from "@/lib/public-award-facts";

const mocks = vi.hoisted(() => ({
  image: vi.fn(),
  getAward: vi.fn(),
  hasConfig: vi.fn(),
}));

// Inspect the actual image component's JSX without reading credentials,
// contacting the database, loading fonts, or invoking the image rasterizer.
vi.mock("next/og", () => ({
  ImageResponse: class {
    constructor(element: ReactNode) {
      mocks.image(element);
    }
  },
}));
vi.mock("node:fs/promises", () => ({ readFile: vi.fn(async () => Buffer.from("test-font")) }));
vi.mock("@/lib/config", () => ({ hasSupabaseAdminConfig: mocks.hasConfig }));
vi.mock("@/lib/public-award-pages", () => ({ getPublicAwardPageBySlug: mocks.getAward }));

import AwardOpenGraphImage from "./opengraph-image";

describe("award sharing image deadline", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.hasConfig.mockReturnValue(true);
  });

  it.each([
    ["2026-03-27T17:00:00-05:00", "March 27, 2026 at 5:00 p.m. (UTC-05:00)"],
    ["2026-03-27", "March 27, 2026"],
    ["Last Friday in January, 5:00 p.m. Central Time", "Last Friday in January, 5:00 p.m. Central Time"],
    ["TBA", "TBA"],
    ["2026-02-30", "2026-02-30"],
  ])("displays %s consistently with award pages", async (deadline, expected) => {
    const facts = publicAwardFactsFromAward({ publicFacts: { deadline } });
    mocks.getAward.mockResolvedValue({ award: { name: "Example Award" }, facts, sources: [] });

    await AwardOpenGraphImage({ params: Promise.resolve({ slug: "example-award" }) });
    const html = renderToStaticMarkup(mocks.image.mock.calls[0][0]);

    expect(mocks.getAward).toHaveBeenCalledExactlyOnceWith("example-award");
    expect(html).toContain(`>${expected}</div>`);
    expect(facts.deadline).toBe(deadline);
    if (expected !== deadline) expect(html).not.toContain(deadline);
  });

  it("keeps the program scope in the label rather than beside the sharing-image date", async () => {
    const facts = publicAwardFactsFromAward({ publicFacts: { deadline: "January 27, 2027 (Boren Scholarships)" } });
    mocks.getAward.mockResolvedValue({ award: { name: "Boren Scholarships and Fellowships" }, facts, sources: [] });
    await AwardOpenGraphImage({ params: Promise.resolve({ slug: "boren-awards" }) });
    const html = renderToStaticMarkup(mocks.image.mock.calls[0][0]);
    expect(html).toContain(">Scholarships deadline</div>");
    expect(html).toContain(">January 27, 2027</div>");
    expect(html).not.toContain("(Boren Scholarships)");
    expect(facts.deadline).toBe("January 27, 2027 (Boren Scholarships)");
  });

  it("omits the deadline when no date was reviewed", async () => {
    mocks.getAward.mockResolvedValue({
      award: { name: "Example Award" },
      facts: publicAwardFactsFromAward({}),
      sources: [],
    });
    await AwardOpenGraphImage({ params: Promise.resolve({ slug: "example-award" }) });
    expect(renderToStaticMarkup(mocks.image.mock.calls[0][0])).not.toContain("Deadline");
  });

  it("keeps the unconfigured fallback free of database requests or invented dates", async () => {
    mocks.hasConfig.mockReturnValue(false);
    await AwardOpenGraphImage({ params: Promise.resolve({ slug: "example-award" }) });
    expect(mocks.getAward).not.toHaveBeenCalled();
    expect(renderToStaticMarkup(mocks.image.mock.calls[0][0])).not.toContain("Deadline");
  });
});
