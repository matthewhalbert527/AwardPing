import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { load } from "cheerio";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SourceIntakeRequestView } from "@/components/admin-source-intake-panel";

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  isSiteAdminEmail: vi.fn(),
  hasSupabaseConfig: vi.fn(),
  hasSupabaseAdminConfig: vi.fn(),
  createAdminClient: vi.fn(),
  panel: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ requireUser: mocks.requireUser, isSiteAdminEmail: mocks.isSiteAdminEmail }));
vi.mock("@/lib/config", () => ({
  appConfig: { adminEmails: ["admin@example.org"] },
  hasSupabaseConfig: mocks.hasSupabaseConfig,
  hasSupabaseAdminConfig: mocks.hasSupabaseAdminConfig,
}));
vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdminClient: mocks.createAdminClient }));
vi.mock("@/components/setup-notice", () => ({ SetupNotice: () => "Setup required" }));
vi.mock("@/components/admin-source-intake-panel", () => ({ AdminSourceIntakePanel: mocks.panel }));
vi.mock("next/link", () => ({
  default: ({ children, ...props }: ComponentProps<"a">) =>
    createElement("a", { ...props, "data-client-navigation": "true" }, children),
}));

import AdminSourceIntakePage from "@/app/dashboard/admin/source-intake/page";

const REQUEST_ID = "47c6afb9-bed0-4b07-9a06-cdd5ef2eda4a";
const events: string[] = [];
type QueryResult = { data: unknown[] | null; error: { message: string } | null };
function query(table: string, result: QueryResult) {
  const builder = {
    select: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    ilike: vi.fn().mockReturnThis(),
    in: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    then(resolve: (value: QueryResult) => unknown, reject: (reason: unknown) => unknown) {
      events.push(`await:${table}`);
      return Promise.resolve(result).then(resolve, reject);
    },
  };
  return builder;
}

let requestResult: QueryResult;
let awardResult: QueryResult;
let matchedAwardResult: QueryResult;
let requestsQuery: ReturnType<typeof query>;
let awardsQuery: ReturnType<typeof query>;
let matchedAwardsQuery: ReturnType<typeof query>;
let from: ReturnType<typeof vi.fn>;

async function render(request?: unknown, award?: unknown) {
  const params = { ...(request === undefined ? {} : { request }), ...(award === undefined ? {} : { award }) };
  const searchParams = Promise.resolve(params) as Promise<{ request?: string | string[]; award?: string | string[] }>;
  return renderToStaticMarkup(await AdminSourceIntakePage({ searchParams }));
}

beforeEach(() => {
  vi.resetAllMocks();
  events.length = 0;
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("unexpected_network_call"); }));
  mocks.hasSupabaseConfig.mockImplementation(() => { events.push("config"); return true; });
  mocks.requireUser.mockImplementation(async () => { events.push("requireUser"); return { email: "admin@example.org" }; });
  mocks.isSiteAdminEmail.mockImplementation(() => { events.push("adminEmail"); return true; });
  mocks.hasSupabaseAdminConfig.mockImplementation(() => { events.push("adminConfig"); return true; });
  mocks.panel.mockImplementation(({ initialRequests }: { initialRequests: { id: string }[] }) =>
    createElement("section", { "data-testid": "existing-intake-panel" }, initialRequests.map(row => row.id).join(" ")));
  requestResult = { data: [{ id: REQUEST_ID }], error: null };
  awardResult = { data: [{ id: "award-1", name: "Example award", slug: "example-award" }], error: null };
  matchedAwardResult = { data: [], error: null };
  requestsQuery = query("requests", requestResult);
  awardsQuery = query("awards", awardResult);
  matchedAwardsQuery = query("matchedAwards", matchedAwardResult);
  let awardReads = 0;
  from = vi.fn((table: string) => {
    events.push(`from:${table}`);
    if (table === "source_page_requests") return requestsQuery;
    if (table === "shared_awards") return awardReads++ === 0 ? awardsQuery : matchedAwardsQuery;
    throw new Error("unexpected_table");
  });
  mocks.createAdminClient.mockImplementation(() => { events.push("adminClient"); return { from }; });
});
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

describe("admin source-intake read-only single-request view", () => {
  it("preserves existing callers that omit optional Next page props", async () => {
    renderToStaticMarkup(await AdminSourceIntakePage());
    expect(requestsQuery.eq).not.toHaveBeenCalled();
    expect(requestsQuery.limit).toHaveBeenCalledExactlyOnceWith(100);
  });

  it("keeps the default 100 most recently updated requests when the filter is absent", async () => {
    const html = await render();
    expect(requestsQuery.select).toHaveBeenCalledExactlyOnceWith("*");
    expect(requestsQuery.order).toHaveBeenCalledExactlyOnceWith("updated_at", { ascending: false });
    expect(requestsQuery.eq).not.toHaveBeenCalled();
    expect(requestsQuery.limit).toHaveBeenCalledExactlyOnceWith(100);
    expect(awardsQuery.select).toHaveBeenCalledExactlyOnceWith("id,name,slug");
    expect(awardsQuery.eq).toHaveBeenCalledExactlyOnceWith("status", "active");
    expect(awardsQuery.order.mock.calls).toEqual([["name", { ascending: true }], ["id", { ascending: true }]]);
    expect(awardsQuery.limit).toHaveBeenCalledExactlyOnceWith(51);
    expect(awardsQuery.ilike).not.toHaveBeenCalled();
    expect(matchedAwardsQuery.in).not.toHaveBeenCalled();
    expect(html).toContain("Search by name to find any award");
    expect(html).not.toContain("Viewing one request");
    expect(mocks.panel.mock.calls[0][0]).toEqual({ initialRequests: requestResult.data, awardOptions: awardResult.data });
  });

  it("awaits Next searchParams and narrows only the request query to exact UUID with limit 1", async () => {
    let resolveParams!: (value: { request: string }) => void;
    const searchParams = new Promise<{ request: string }>(resolve => { resolveParams = resolve; });
    const pendingPage = AdminSourceIntakePage({ searchParams });
    await Promise.resolve();
    expect(mocks.createAdminClient).not.toHaveBeenCalled();
    resolveParams({ request: REQUEST_ID });
    const html = renderToStaticMarkup(await pendingPage), $ = load(html);
    expect(requestsQuery.eq).toHaveBeenCalledExactlyOnceWith("id", REQUEST_ID);
    expect(requestsQuery.limit).toHaveBeenCalledExactlyOnceWith(1);
    expect(awardsQuery.limit).toHaveBeenCalledExactlyOnceWith(51);
    expect($("[aria-label='Request filter']").text()).toContain("Viewing one request");
    expect($("[aria-label='Request filter']").text()).toContain(REQUEST_ID);
    expect($("a").filter((_, node) => $(node).text() === "All recent requests").attr("href"))
      .toBe("/dashboard/admin/source-intake");
    expect(mocks.panel.mock.calls[0][0]).toEqual({ initialRequests: requestResult.data, awardOptions: awardResult.data });
    expect(from.mock.calls.map(([table]) => table)).toEqual(["source_page_requests", "shared_awards"]);
    expect(events.slice(0, 5)).toEqual(["config", "requireUser", "adminEmail", "adminConfig", "adminClient"]);
  });

  it("canonicalizes uppercase UUIDs without changing query scope", async () => {
    await render(REQUEST_ID.toUpperCase());
    expect(requestsQuery.eq).toHaveBeenCalledExactlyOnceWith("id", REQUEST_ID);
    expect(requestsQuery.limit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it.each([
    ["empty", ""],
    ["non-UUID", "not-a-request"],
    ["oversized", REQUEST_ID.repeat(100)],
    ["whitespace", ` ${REQUEST_ID}`],
    ["malformed UUID", "47c6afb9-bed0-4b07-9a06-cdd5ef2edzzz"],
    ["duplicate", [REQUEST_ID, REQUEST_ID]],
    ["multiple different IDs", [REQUEST_ID, "02ecd423-411e-44ae-a4c5-7efbc56f42c4"]],
    ["single-element array", [REQUEST_ID]],
    ["empty array", []],
    ["null", null],
    ["number", 123],
    ["object", { id: REQUEST_ID }],
  ])("fails closed for %s instead of broadening to recent requests", async (_label, request) => {
    const html = await render(request), $ = load(html);
    expect($("[role='alert']").text()).toContain("Enter exactly one valid request ID (UUID)");
    expect($("[role='alert']").text()).toContain("No requests were loaded");
    expect(html).toContain("All recent requests");
    expect(mocks.createAdminClient).not.toHaveBeenCalled();
    expect(from).not.toHaveBeenCalled();
    expect(mocks.panel).not.toHaveBeenCalled();
    expect(events).toEqual(["config", "requireUser", "adminEmail", "adminConfig"]);
  });

  it("shows a missing exact request without retrying the broader list", async () => {
    requestResult.data = [];
    const html = await render(REQUEST_ID);
    expect(html).toContain("Viewing one request");
    expect(html).toContain("No request found for this ID");
    expect(requestsQuery.eq).toHaveBeenCalledExactlyOnceWith("id", REQUEST_ID);
    expect(requestsQuery.limit).toHaveBeenCalledExactlyOnceWith(1);
    expect(from).toHaveBeenCalledTimes(2);
    expect(mocks.panel.mock.calls[0][0].initialRequests).toEqual([]);
  });

  it("keeps query errors visible without falling back to an unfiltered request query", async () => {
    requestResult.data = null;
    requestResult.error = { message: "Request query unavailable" };
    const html = await render(REQUEST_ID);
    expect(html).toContain("Some source-intake data could not be loaded");
    expect(html).toContain("Request query unavailable");
    expect(html).not.toContain("No request found for this ID");
    expect(requestsQuery.eq).toHaveBeenCalledExactlyOnceWith("id", REQUEST_ID);
    expect(requestsQuery.limit).toHaveBeenCalledExactlyOnceWith(1);
    expect(from).toHaveBeenCalledTimes(2);
  });

  it("keeps setup ahead of sign-in and all admin database queries", async () => {
    mocks.hasSupabaseConfig.mockReturnValue(false);
    expect(await render(REQUEST_ID)).toContain("Setup required");
    expect(mocks.requireUser).not.toHaveBeenCalled();
    expect(mocks.createAdminClient).not.toHaveBeenCalled();
    expect(from).not.toHaveBeenCalled();
  });

  it("requires genuine sign-in before admin data access", async () => {
    const redirect = new Error("login_redirect");
    mocks.requireUser.mockRejectedValue(redirect);
    await expect(render(REQUEST_ID)).rejects.toBe(redirect);
    expect(mocks.isSiteAdminEmail).not.toHaveBeenCalled();
    expect(mocks.createAdminClient).not.toHaveBeenCalled();
    expect(from).not.toHaveBeenCalled();
  });

  it("keeps the admin-email check ahead of filter validation and database access", async () => {
    mocks.isSiteAdminEmail.mockReturnValue(false);
    const html = await render([REQUEST_ID, REQUEST_ID]);
    expect(html).toContain("limited to AwardPing site admins");
    expect(html).not.toContain("No requests were loaded");
    expect(mocks.hasSupabaseAdminConfig).not.toHaveBeenCalled();
    expect(mocks.createAdminClient).not.toHaveBeenCalled();
    expect(from).not.toHaveBeenCalled();
  });

  it("keeps service configuration ahead of filter validation and database access", async () => {
    mocks.hasSupabaseAdminConfig.mockReturnValue(false);
    const html = await render("invalid");
    expect(html).toContain("service-role access is not configured");
    expect(html).not.toContain("No requests were loaded");
    expect(mocks.requireUser).toHaveBeenCalledTimes(1);
    expect(mocks.isSiteAdminEmail).toHaveBeenCalledExactlyOnceWith("admin@example.org");
    expect(mocks.createAdminClient).not.toHaveBeenCalled();
    expect(from).not.toHaveBeenCalled();
  });
});

describe("admin source-intake bounded server award search", () => {
  const NSF_ID = "11111111-1111-4111-8111-111111111111";
  const CREATED_ID = "22222222-2222-4222-8222-222222222222";
  const nsf = { id: NSF_ID, name: "NSF Graduate Research Fellowship Program", slug: "nsf-grfp" };

  it("includes a stored NSF match outside the former alphabetical 750 and preserves its ID", async () => {
    const request: SourceIntakeRequestView = {
      id: REQUEST_ID, award_name: nsf.name, homepage_url: "https://example.org/nsf",
      normalized_url: "https://example.org/nsf", intake_type: "official_source",
      status: "needs_manual_review", status_reason: "missing_evidence_quotes",
      detected_award_name: null, detected_sponsor: null, matched_shared_award_id: NSF_ID,
      created_shared_award_id: null, created_source_ids: null, ai_review: {}, capture_metadata: {},
      acquisition_kind: "admin_intake", notification_mode: "baseline_only", onboarding_batch_id: null,
      deterministic_review: {}, error: null, created_at: "2026-10-19T00:00:00.000Z",
      updated_at: "2026-10-19T18:15:16.360Z", processed_at: null,
    };
    requestResult.data = [request];
    matchedAwardResult.data = [nsf];
    await render(REQUEST_ID);
    const props = mocks.panel.mock.calls[0][0];
    expect(props.initialRequests[0].matched_shared_award_id).toBe(NSF_ID);
    expect(props.awardOptions).toContainEqual(nsf);
    expect(matchedAwardsQuery.select).toHaveBeenCalledExactlyOnceWith("id,name,slug");
    expect(matchedAwardsQuery.in).toHaveBeenCalledExactlyOnceWith("id", [NSF_ID]);
    expect(matchedAwardsQuery.limit).toHaveBeenCalledExactlyOnceWith(1);
    expect(matchedAwardsQuery.eq).not.toHaveBeenCalled();
    expect(matchedAwardsQuery.ilike).not.toHaveBeenCalled();
    expect(matchedAwardsQuery.order.mock.calls).toEqual([["name", { ascending: true }], ["id", { ascending: true }]]);
    const { AdminSourceIntakePanel } = await vi.importActual<typeof import("@/components/admin-source-intake-panel")>("@/components/admin-source-intake-panel");
    const $ = load(renderToStaticMarkup(createElement(AdminSourceIntakePanel, props)));
    expect($("article select option[selected]").attr("value")).toBe(NSF_ID);
    expect($("article select option[selected]").text()).toBe(nsf.name);
  });

  it("searches all active awards by name so a Z award is reachable without an alphabetical offset", async () => {
    const z = { id: "z-award", name: "Zonta Fellowship", slug: "zonta-fellowship" };
    awardResult.data = [z];
    const html = await render(REQUEST_ID, "Zonta");
    expect(awardsQuery.ilike).toHaveBeenCalledExactlyOnceWith("name", "%Zonta%");
    expect(awardsQuery.eq).toHaveBeenCalledExactlyOnceWith("status", "active");
    expect(awardsQuery.limit).toHaveBeenCalledExactlyOnceWith(51);
    expect(mocks.panel.mock.calls[0][0].awardOptions).toEqual([z]);
    expect(html).toContain("Showing 1 matching award");
  });

  it("uses a native GET form and preserves the exact request filter on search and clear", async () => {
    const $ = load(await render(REQUEST_ID, "NSF")), form = $("form[aria-label='Search awards']");
    expect(form.attr("method")).toBe("get");
    expect(form.attr("action")).toBe("/dashboard/admin/source-intake");
    expect(form.find("input[type='hidden'][name='request']").attr("value")).toBe(REQUEST_ID);
    expect(form.find("input[name='award']").attr("value")).toBe("NSF");
    expect(form.find("input[name='award']").attr("maxlength")).toBe("80");
    expect(form.find("a").filter((_, node) => $(node).text() === "Clear search").attr("href"))
      .toBe(`/dashboard/admin/source-intake?request=${REQUEST_ID}`);
    expect(form.find("a").attr("data-client-navigation")).toBeUndefined();
    expect(form.find("button[type='submit']").text()).toBe("Search awards");
    // The Next Link mock marks client navigation, so this detects a future
    // native-anchor-to-Link regression that identical SSR <a> markup would miss.
    expect($("a[data-client-navigation='true']").text()).toBe("Admin workflows");
  });

  it.each([REQUEST_ID, "invalid-request"])("uses full navigation to reset recent requests for %s", async request => {
    const $ = load(await render(request, "NSF"));
    const recent = $("a").filter((_, node) => $(node).text() === "All recent requests");
    expect(recent).toHaveLength(1);
    expect(recent.attr("href")).toBe("/dashboard/admin/source-intake");
    expect(recent.attr("data-client-navigation")).toBeUndefined();
  });

  it("uses the empty default first 50 plus every visible matched/created award, deduped and sorted", async () => {
    awardResult.data = Array.from({ length: 51 }, (_, i) => ({ id: `a-${i}`, name: `Award ${String(i).padStart(2, "0")}`, slug: null }));
    requestResult.data = [{ id: REQUEST_ID, matched_shared_award_id: NSF_ID, created_shared_award_id: CREATED_ID }];
    matchedAwardResult.data = [nsf, { id: CREATED_ID, name: "Created award", slug: null }, awardResult.data[0]];
    const html = await render(undefined, "");
    expect(awardsQuery.ilike).not.toHaveBeenCalled();
    expect(matchedAwardsQuery.in).toHaveBeenCalledExactlyOnceWith("id", [NSF_ID, CREATED_ID]);
    expect(matchedAwardsQuery.limit).toHaveBeenCalledExactlyOnceWith(2);
    const options = mocks.panel.mock.calls[0][0].awardOptions;
    expect(options).toHaveLength(52);
    expect(options.filter((award: { id: string }) => award.id === "a-0")).toHaveLength(1);
    expect(options.some((award: { id: string }) => award.id === "a-50")).toBe(false);
    expect(options.slice(-2).map((award: { name: string }) => award.name)).toEqual(["Created award", nsf.name]);
    expect(html).toContain("Showing up to 50 active awards alphabetically");
  });

  it("retains existing associations even when the searched name does not match them", async () => {
    requestResult.data = [{ id: REQUEST_ID, matched_shared_award_id: NSF_ID, created_shared_award_id: null }];
    matchedAwardResult.data = [nsf];
    awardResult.data = [];
    const html = await render(REQUEST_ID, "Zonta");
    expect(html).toContain("No active awards match “Zonta”");
    expect(mocks.panel.mock.calls[0][0].awardOptions).toEqual([nsf]);
    expect(mocks.panel.mock.calls[0][0].initialRequests[0].matched_shared_award_id).toBe(NSF_ID);
  });

  it("fetches 51 but renders only 50 search results and explicitly asks for refinement", async () => {
    awardResult.data = Array.from({ length: 51 }, (_, i) => ({ id: `award-${i}`, name: `Fellowship ${i}`, slug: null }));
    const html = await render(undefined, "Fellowship");
    expect(awardsQuery.limit).toHaveBeenCalledExactlyOnceWith(51);
    expect(mocks.panel.mock.calls[0][0].awardOptions).toHaveLength(50);
    expect(html).toContain("More matches exist; refine your search");
  });

  it.each([
    ["20% award", "%20\\% award%"],
    ["under_score", "%under\\_score%"],
    ["path\\award", "%path\\\\award%"],
    ["%_\\", "%\\%\\_\\\\%"],
  ])("escapes literal LIKE metacharacters in %s", async (award, expectedPattern) => {
    await render(undefined, award);
    expect(awardsQuery.ilike).toHaveBeenCalledExactlyOnceWith("name", expectedPattern);
  });

  it("trims the query while retaining literal punctuation and stable tie-break ordering", async () => {
    await render(undefined, "  NSF (GRFP), 2027  ");
    expect(awardsQuery.ilike).toHaveBeenCalledExactlyOnceWith("name", "%NSF (GRFP), 2027%");
    expect(awardsQuery.order.mock.calls).toEqual([["name", { ascending: true }], ["id", { ascending: true }]]);
  });

  it.each([
    ["one character", "N"], ["oversized", "x".repeat(81)], ["duplicate", ["NSF", "NSF"]],
    ["single array", ["NSF"]], ["empty array", []], ["null", null], ["number", 5],
    ["object", { name: "NSF" }], ["control character", "NSF\naward"], ["NUL", "NSF\u0000award"],
    ["PostgREST wildcard alias", "**"], ["embedded wildcard alias", "NSF*"],
  ])("fails closed for %s before creating an admin client", async (_label, award) => {
    const $ = load(await render(REQUEST_ID, award));
    expect($("[role='alert']").text()).toContain("Enter one award name using 2–80 characters");
    expect($("input[name='request']").attr("value")).toBe(REQUEST_ID);
    expect(mocks.createAdminClient).not.toHaveBeenCalled();
    expect(from).not.toHaveBeenCalled();
    expect(mocks.panel).not.toHaveBeenCalled();
    expect(events).toEqual(["config", "requireUser", "adminEmail", "adminConfig"]);
  });

  it("still authenticates and authorizes before invalid award query validation", async () => {
    mocks.isSiteAdminEmail.mockReturnValue(false);
    expect(await render(undefined, ["NSF", "NSF"])).toContain("limited to AwardPing site admins");
    expect(mocks.hasSupabaseAdminConfig).not.toHaveBeenCalled();
    expect(mocks.createAdminClient).not.toHaveBeenCalled();
  });

  it("does not broaden any query if Next searchParams rejects", async () => {
    const error = new Error("invalid_search_params");
    await expect(AdminSourceIntakePage({ searchParams: Promise.reject(error) })).rejects.toBe(error);
    expect(mocks.createAdminClient).not.toHaveBeenCalled();
    expect(from).not.toHaveBeenCalled();
  });

  it("keeps award search errors visible without silently falling back to all awards", async () => {
    awardResult.data = null;
    awardResult.error = { message: "Award search unavailable" };
    const html = await render(REQUEST_ID, "NSF");
    expect(html).toContain("Award search unavailable");
    expect(awardsQuery.ilike).toHaveBeenCalledExactlyOnceWith("name", "%NSF%");
    expect(from).toHaveBeenCalledTimes(2);
    expect(mocks.panel.mock.calls[0][0].awardOptions).toEqual([]);
  });

  it.each([true, false])("does not show misleading matching controls when an existing award lookup is unavailable (error=%s)", async error => {
    requestResult.data = [{ id: REQUEST_ID, matched_shared_award_id: NSF_ID, created_shared_award_id: null }];
    matchedAwardResult.data = error ? null : [];
    matchedAwardResult.error = error ? { message: "Associated award unavailable" } : null;
    const html = await render(REQUEST_ID);
    expect(html).toContain("Existing award matches could not be loaded");
    expect(load(html)("form[aria-label='Search awards']")).toHaveLength(1);
    expect(mocks.panel).not.toHaveBeenCalled();
    expect(matchedAwardsQuery.in).toHaveBeenCalledExactlyOnceWith("id", [NSF_ID]);
    expect(from).toHaveBeenCalledTimes(3);
  });

  it("bounds association lookup to at most two IDs per visible request, with no extra requests", async () => {
    const id = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
    requestResult.data = Array.from({ length: 101 }, (_, i) => ({ id: `request-${i}`, matched_shared_award_id: id(i * 2), created_shared_award_id: id(i * 2 + 1) }));
    matchedAwardResult.data = Array.from({ length: 200 }, (_, i) => ({ id: id(i), name: `Award ${i}`, slug: null }));
    await render();
    expect(requestsQuery.limit).toHaveBeenCalledExactlyOnceWith(100);
    expect(matchedAwardsQuery.in.mock.calls[0][1]).toHaveLength(200);
    expect(matchedAwardsQuery.limit).toHaveBeenCalledExactlyOnceWith(200);
    expect(mocks.panel.mock.calls[0][0].initialRequests).toHaveLength(100);
    expect(from).toHaveBeenCalledTimes(3);
  });
});
