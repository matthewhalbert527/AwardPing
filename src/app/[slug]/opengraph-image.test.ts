import type { ReactNode } from "react";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { load } from "cheerio";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { publicAwardFactsFromAward } from "@/lib/public-award-facts";

const mocks = vi.hoisted(() => ({
  image: vi.fn(),
  getAward: vi.fn(),
  hasConfig: vi.fn(),
  readFile: vi.fn(async (path: string) => Buffer.from(path)),
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
vi.mock("node:fs/promises", () => ({ readFile: mocks.readFile }));
vi.mock("@/lib/config", () => ({ hasSupabaseAdminConfig: mocks.hasConfig }));
vi.mock("@/lib/public-award-pages", () => ({ getPublicAwardPageBySlug: mocks.getAward }));

import AwardOpenGraphImage from "./opengraph-image";

// Capture before beforeEach can erase evidence of an import-time font read.
const fontReadsAtImport = mocks.readFile.mock.calls.length;
const FONT_FILES = [
  "src/app/source-serif-4-semibold.ttf",
  "src/app/geist-sans-600.ttf",
  "src/app/geist-sans-700.ttf",
];

describe("award sharing image deadline", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.hasConfig.mockReturnValue(true);
  });

  it.each([
    ["2026-03-27T17:00:00-05:00", "March 27, 2026 at 5:00 p.m. (UTC-05:00)"],
    ["October 1, 2026 at 11:59PM PT", "October 1, 2026 at 11:59 p.m. (PT)"],
    ["2026-03-27", "March 27, 2026"],
    ["Last Friday in January, 5:00 p.m. Central Time", "Last Friday in January at 5:00 p.m. (Central Time)"],
    ["5:00 p.m. EST on the first Friday in December 2026", "First Friday in December 2026 at 5:00 p.m. (EST)"],
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

  it("reserves footer space for long deadlines without pushing sources or the domain off the image", async () => {
    const raw = "Second Friday in November at 11:59 pm Eastern Time";
    const facts = publicAwardFactsFromAward({ publicFacts: { deadline: raw } });
    mocks.getAward.mockResolvedValue({ award: { name: "GEM Fellowship" }, facts, sources: [{}, {}, {}] });
    await AwardOpenGraphImage({ params: Promise.resolve({ slug: "gem-national-consortium" }) });
    const $ = load(renderToStaticMarkup(mocks.image.mock.calls[0][0]));
    const root = $("body > div");
    const header = root.children().first();
    const footer = root.children().last();
    expect(header.text()).toContain("awardping.com");
    expect(header.children().last().css("font-family")).toContain("Geist");
    expect(footer.text()).not.toContain("awardping.com");
    expect(footer.children()).toHaveLength(2);
    const dateColumn = footer.children().first();
    const sourcesColumn = footer.children().last();
    expect(dateColumn.css("flex-grow")).toBe("1");
    expect(dateColumn.css("min-width")).toBe("0");
    expect(dateColumn.css("flex-basis")).toBe("0");
    expect(sourcesColumn.css("width")).toBe("280px");
    expect(sourcesColumn.css("flex-shrink")).toBe("0");
    expect(dateColumn.text()).toContain("Second Friday in November at 11:59 p.m. (Eastern Time)");
    expect(dateColumn.attr("style")).not.toContain("hidden");
    expect(sourcesColumn.text()).toContain("3 official pages");
    expect(facts.deadline).toBe(raw);
    // CSS/JSX contracts cannot prove raster geometry; inspect actual built PNGs too.
  });

  it.each([[0, "0 official pages"], [1, "1 official page"], [3, "3 official pages"]] as const)(
    "keeps the recorded count %i with correct source-page wording",
    async (count, expected) => {
      mocks.getAward.mockResolvedValue({
        award: { name: "Example Award" }, facts: publicAwardFactsFromAward({}),
        sources: Array.from({ length: count }, () => ({})),
      });
      await AwardOpenGraphImage({ params: Promise.resolve({ slug: "example-award" }) });
      const $ = load(renderToStaticMarkup(mocks.image.mock.calls[0][0]));
      expect($("body > div").children().last().text()).toBe(`Monitored sources${expected}`);
      expect($("body > div").children().first().text()).toContain("awardping.com");
    },
  );

  it("keeps the unconfigured fallback free of database requests or invented dates", async () => {
    mocks.hasConfig.mockReturnValue(false);
    await AwardOpenGraphImage({ params: Promise.resolve({ slug: "example-award" }) });
    expect(mocks.getAward).not.toHaveBeenCalled();
    expect(renderToStaticMarkup(mocks.image.mock.calls[0][0])).not.toContain("Deadline");
  });

  it("reads each font lazily from a project-root string path", async () => {
    expect(fontReadsAtImport).toBe(0);
    expect(mocks.readFile).not.toHaveBeenCalled();
    mocks.getAward.mockResolvedValue({
      award: { name: "Example Award" },
      facts: publicAwardFactsFromAward({}),
      sources: [],
    });
    await AwardOpenGraphImage({ params: Promise.resolve({ slug: "example-award" }) });
    expect(mocks.readFile.mock.calls.map(([path]) => path)).toEqual(
      FONT_FILES.map((file) => join(process.cwd(), file)),
    );
  });

  it("keeps every runtime font path literal and backed by an existing asset", () => {
    const source = readFileSync(new URL("./opengraph-image.tsx", import.meta.url), "utf8");
    expect([...source.matchAll(/"(src\/app\/[^"]+\.ttf)"/g)].map((match) => match[1])).toEqual(FONT_FILES);
    for (const file of FONT_FILES) expect(existsSync(join(process.cwd(), file)), file).toBe(true);
    expect(source).not.toContain("import.meta.url");
    expect(source).not.toContain("fileURLToPath");
    // Source contracts do not prove bundling; the built artifact must also be checked.
  });
});
