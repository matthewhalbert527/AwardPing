import { beforeEach, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

// React/Next owns the render dispatcher. Model its documented request lifetime
// here so the test cannot accidentally turn memoization into a global cache.
const state = vi.hoisted(() => ({ scope: null as Map<unknown, unknown> | null, read: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("react", () => ({ cache: (fn: () => unknown) => () => {
  if (!state.scope) return fn();
  if (!state.scope.has(fn)) state.scope.set(fn, fn());
  return state.scope.get(fn);
} }));
vi.mock("@/lib/stage1-publication", () => ({ loadStage1PublicationIndex: state.read }));
import { loadPublicRenderPublicationIndex } from "@/lib/public-render-publication";
import { loadStage1PublicationIndex } from "@/lib/stage1-publication";

beforeEach(() => { state.scope = null; state.read.mockReset(); });

it("metadata, body and feed share one in-flight public read only inside a render", async () => {
  const approved = { available: true, verifiedEntries: [{ canonicalAwardId: "public-award" }] };
  let finish!: (value: unknown) => void;
  state.read.mockReturnValue(new Promise(resolve => { finish = resolve; }));
  state.scope = new Map();
  const metadata = loadPublicRenderPublicationIndex(), body = loadPublicRenderPublicationIndex(), feed = loadPublicRenderPublicationIndex();
  expect(state.read).toHaveBeenCalledTimes(1);
  expect(metadata).toBe(body); expect(body).toBe(feed);
  finish(approved);
  expect(await body).toBe(approved);
});

it("a new render sees suspended or unavailable authority instead of a previous request's approval", async () => {
  state.read.mockResolvedValueOnce({ available: true, verifiedEntries: [{}] })
    .mockResolvedValueOnce({ available: true, verifiedEntries: [] })
    .mockResolvedValueOnce({ available: false, verifiedEntries: [] });
  state.scope = new Map();
  expect((await loadPublicRenderPublicationIndex()).verifiedEntries).toHaveLength(1);
  state.scope = new Map();
  expect((await loadPublicRenderPublicationIndex()).verifiedEntries).toHaveLength(0);
  state.scope = new Map();
  expect((await loadPublicRenderPublicationIndex()).available).toBe(false);
  expect(state.read).toHaveBeenCalledTimes(3);
});

it("raw authority/action reads stay uncached even during a render, and non-render callers do not reuse a memo", async () => {
  state.read.mockResolvedValue({ available: false, verifiedEntries: [] });
  state.scope = new Map();
  await loadStage1PublicationIndex(); await loadStage1PublicationIndex();
  expect(state.read).toHaveBeenCalledTimes(2);
  state.scope = null;
  await loadPublicRenderPublicationIndex(); await loadPublicRenderPublicationIndex();
  expect(state.read).toHaveBeenCalledTimes(4);
});

it("publication, read-state actions and subscriber delivery retain the raw current authority loader", () => {
  for (const path of ["../app/api/shared-awards/[id]/route.ts", "../app/api/shared-award-change-reads/route.ts", "./public-updates.ts"]) {
    const source = readFileSync(new URL(path, import.meta.url), "utf8");
    expect(source).toContain("loadStage1PublicationIndex");
    expect(source).not.toContain("public-render-publication");
  }
  const helper = readFileSync(new URL("./public-render-publication.ts", import.meta.url), "utf8");
  expect(helper).not.toMatch(/unstable_cache|setTimeout|new Map|userId|officeId|force-cache/);
});
