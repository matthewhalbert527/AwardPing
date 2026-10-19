import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { load } from "cheerio";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

import AdminSourceIntakePage from "@/app/dashboard/admin/source-intake/page";

const REQUEST_ID = "47c6afb9-bed0-4b07-9a06-cdd5ef2eda4a";
const events: string[] = [];
type QueryResult = { data: unknown[] | null; error: { message: string } | null };
function query(table: string, result: QueryResult) {
  const builder = {
    select: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
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
let requestsQuery: ReturnType<typeof query>;
let awardsQuery: ReturnType<typeof query>;
let from: ReturnType<typeof vi.fn>;

async function render(request?: unknown) {
  const searchParams = Promise.resolve(request === undefined ? {} : { request }) as Promise<{ request?: string | string[] }>;
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
  requestsQuery = query("requests", requestResult);
  awardsQuery = query("awards", awardResult);
  from = vi.fn((table: string) => {
    events.push(`from:${table}`);
    if (table === "source_page_requests") return requestsQuery;
    if (table === "shared_awards") return awardsQuery;
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
    expect(awardsQuery.order).toHaveBeenCalledExactlyOnceWith("name", { ascending: true });
    expect(awardsQuery.limit).toHaveBeenCalledExactlyOnceWith(750);
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
    expect(awardsQuery.limit).toHaveBeenCalledExactlyOnceWith(750);
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
