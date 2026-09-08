import { createClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import type { Database } from "@/lib/database.types";
import type { Stage1PublicationEntry, Stage1PublicationIndex } from "@/lib/stage1-publication";

vi.mock("server-only", () => ({}));

import { loadFirstPublishedCaptureDates } from "@/lib/award-first-capture";

const firstSource = "10000000-0000-4000-8000-000000000001";
const secondSource = "10000000-0000-4000-8000-000000000002";
const capturedAt = "2026-07-01T18:00:00.123456+00:00";

function entry(cohortKey = "example", allowedSourceIds = [firstSource]): Stage1PublicationEntry {
  return {
    canonicalAwardId: `canonical-${cohortKey}`,
    memberAwardIds: [`alias-${cohortKey}`],
    allowedSourceIds,
    allowedSourceIdSet: new Set(allowedSourceIds),
    effectivelyVerified: true,
    registry: { cohort_key: cohortKey },
  } as unknown as Stage1PublicationEntry;
}

function index(entries = [entry()]): Stage1PublicationIndex {
  return {
    available: true,
    verifiedEntries: entries,
  } as Stage1PublicationIndex;
}

function row(overrides: Record<string, unknown> = {}) {
  return { id: 1, cohort_key: "example", source_id: firstSource, source_captured_at: capturedAt, ...overrides };
}

// Execute the installed Supabase query builder with an entirely local transport.
// No real project, credentials, or HTTP requests are used by this suite.
function mockAdmin(reply: (url: URL) => Response | Promise<Response>) {
  const requests: Array<{ url: URL; method: string }> = [];
  const fetchMock = vi.fn(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    requests.push({ url, method: init?.method || "GET" });
    return reply(url);
  });
  const admin = createClient<Database>("https://award-first-capture.invalid", "test-only-key", {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: fetchMock },
  });
  return { admin, requests, fetchMock };
}

function rowsResponse(rows: unknown[]) {
  return Response.json(rows);
}

describe("loadFirstPublishedCaptureDates", () => {
  it("issues only bounded, ordered ledger reads scoped by cohort and every allowed source", async () => {
    const publicationIndex = index([entry("example", [firstSource, secondSource]), entry("other", [secondSource])]);
    const { admin, requests } = mockAdmin((url) => rowsResponse([
      url.searchParams.get("cohort_key") === "eq.example"
        ? row({ source_id: secondSource })
        : row({ cohort_key: "other", source_id: secondSource, source_captured_at: "2026-06-20T01:02:03Z" }),
    ]));

    const result = await loadFirstPublishedCaptureDates({ admin, publicationIndex });

    expect([...result]).toEqual([
      ["canonical-example", capturedAt],
      ["canonical-other", "2026-06-20T01:02:03Z"],
    ]);
    expect(result.has("alias-example")).toBe(false);
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request.method).toBe("GET");
      expect(request.url.pathname).toBe("/rest/v1/stage1_award_fact_publication_ledger");
      expect(request.url.searchParams.get("select")).toBe("id,cohort_key,source_id,source_captured_at");
      expect(request.url.searchParams.get("order")).toBe("source_captured_at.asc,id.asc");
      expect(request.url.searchParams.get("limit")).toBe("1");
      expect([...request.url.searchParams.keys()].sort()).toEqual(["cohort_key", "limit", "order", "select", "source_id"]);
    }
    expect(requests[0].url.searchParams.get("cohort_key")).toBe("eq.example");
    expect(requests[0].url.searchParams.get("source_id")).toBe(`in.(${firstSource},${secondSource})`);
    expect(requests[1].url.searchParams.get("cohort_key")).toBe("eq.other");
    expect(requests[1].url.searchParams.get("source_id")).toBe(`in.(${secondSource})`);
  });

  it.each([
    ["unavailable publication", { ...index(), available: false }],
    ["empty publication", index([])],
    ["unverified entry", index([{ ...entry(), effectivelyVerified: false }])],
    ["no allowed sources", index([entry("example", [])])],
  ])("does not query for %s", async (_name, publicationIndex) => {
    const { admin, requests } = mockAdmin(() => { throw new Error("must not fetch"); });
    expect(await loadFirstPublishedCaptureDates({ admin, publicationIndex })).toEqual(new Map());
    expect(requests).toHaveLength(0);
  });

  it("omits a missing capture without borrowing row creation or verification dates", async () => {
    const publication = entry();
    publication.registry.created_at = "2020-01-01T00:00:00Z";
    publication.registry.last_verified_at = "2026-09-01T00:00:00Z";
    const { admin } = mockAdmin(() => rowsResponse([]));
    expect(await loadFirstPublishedCaptureDates({ admin, publicationIndex: index([publication]) })).toEqual(new Map());
  });

  it.each([
    ["wrong cohort", row({ cohort_key: "another-award" })],
    ["unlisted source", row({ source_id: secondSource })],
    ["missing date", { id: 1, cohort_key: "example", source_id: firstSource }],
  ])("omits a response with %s", async (_name, returnedRow) => {
    const { admin } = mockAdmin(() => rowsResponse([returnedRow]));
    expect(await loadFirstPublishedCaptureDates({ admin, publicationIndex: index() })).toEqual(new Map());
  });

  it.each([
    null, 0, "", "yesterday", "2026-07-01", "2026-07-01T18:00:00",
    "2026-02-30T18:00:00Z", "2026-07-01T24:00:00Z", "2026-07-01T18:00:00-00:00",
    "2026-07-01T18:00:00-0000", "2026-07-01T18:00:00+25:00", "2026-07-01T18:00:00Z ",
  ])("does not invent a date from invalid evidence %j", async (sourceCapturedAt) => {
    const { admin } = mockAdmin(() => rowsResponse([row({ source_captured_at: sourceCapturedAt })]));
    expect(await loadFirstPublishedCaptureDates({ admin, publicationIndex: index() })).toEqual(new Map());
  });

  it.each(["2026-07-01T18:00:00Z", "2026-07-01 18:00:00.123456+00:00", "2026-07-01T18:00:00-05:00"])(
    "preserves the exact valid database timestamp %s",
    async (sourceCapturedAt) => {
      const { admin } = mockAdmin(() => rowsResponse([row({ source_captured_at: sourceCapturedAt })]));
      expect(await loadFirstPublishedCaptureDates({ admin, publicationIndex: index() })).toEqual(new Map([["canonical-example", sourceCapturedAt]]));
    },
  );

  it("isolates a query error to one award while retaining a sibling's capture", async () => {
    const { admin } = mockAdmin((url) => url.searchParams.get("cohort_key") === "eq.example"
      ? Response.json({ code: "42501", message: "private driver diagnostic" }, { status: 403 })
      : rowsResponse([row({ cohort_key: "other" })]));

    expect(await loadFirstPublishedCaptureDates({ admin, publicationIndex: index([entry(), entry("other")]) }))
      .toEqual(new Map([["canonical-other", capturedAt]]));
  });

  it("contains a thrown query failure without exposing its diagnostic", async () => {
    const { admin, requests } = mockAdmin(() => rowsResponse([row({ cohort_key: "other" })]));
    vi.spyOn(admin, "from").mockImplementationOnce(() => { throw new Error("private setup diagnostic"); });

    expect(await loadFirstPublishedCaptureDates({ admin, publicationIndex: index([entry(), entry("other")]) }))
      .toEqual(new Map([["canonical-other", capturedAt]]));
    expect(requests).toHaveLength(1);
  });

  it("isolates malformed JSON and aborted reads without losing another award's date", async () => {
    const { admin } = mockAdmin((url) => {
      const cohort = url.searchParams.get("cohort_key");
      if (cohort === "eq.malformed") return new Response("not JSON", { status: 200 });
      if (cohort === "eq.aborted") throw new DOMException("private transport diagnostic", "AbortError");
      return rowsResponse([row()]);
    });

    expect(await loadFirstPublishedCaptureDates({ admin, publicationIndex: index([entry("malformed"), entry("aborted"), entry()]) }))
      .toEqual(new Map([["canonical-example", capturedAt]]));
  });

  it("does not mutate publication entries or their source scopes", async () => {
    const publicationIndex = index();
    const before = structuredClone(publicationIndex);
    Object.freeze(publicationIndex.verifiedEntries[0].allowedSourceIds);
    Object.freeze(publicationIndex.verifiedEntries[0]);
    Object.freeze(publicationIndex.verifiedEntries);
    const { admin } = mockAdmin(() => rowsResponse([row()]));

    await loadFirstPublishedCaptureDates({ admin, publicationIndex });

    expect(publicationIndex).toEqual(before);
  });
});
