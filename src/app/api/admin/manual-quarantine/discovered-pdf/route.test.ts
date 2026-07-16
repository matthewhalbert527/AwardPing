import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  assignmentResult: null as unknown,
  createSupabaseAdminClient: vi.fn(),
  from: vi.fn(),
  getCurrentUser: vi.fn(),
  hasSupabaseAdminConfig: vi.fn(),
  hasSupabaseConfig: vi.fn(),
  isSiteAdminEmail: vi.fn(),
  quarantineResult: null as unknown,
  rpc: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  getCurrentUser: mocks.getCurrentUser,
  isSiteAdminEmail: mocks.isSiteAdminEmail,
}));
vi.mock("@/lib/config", () => ({
  hasSupabaseAdminConfig: mocks.hasSupabaseAdminConfig,
  hasSupabaseConfig: mocks.hasSupabaseConfig,
}));
vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdminClient: mocks.createSupabaseAdminClient,
}));

import { POST } from "@/app/api/admin/manual-quarantine/discovered-pdf/route";

const actorId = "10000000-0000-4000-8000-000000000001";
const caseId = "20000000-0000-4000-8000-000000000002";
const sourceId = "30000000-0000-4000-8000-000000000003";
const requestId = "40000000-0000-4000-8000-000000000004";

describe("discovered-PDF quarantine resolution route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.hasSupabaseConfig.mockReturnValue(true);
    mocks.hasSupabaseAdminConfig.mockReturnValue(true);
    mocks.getCurrentUser.mockResolvedValue({ id: actorId, email: "Admin@AwardPing.test" });
    mocks.isSiteAdminEmail.mockReturnValue(true);
    mocks.quarantineResult = {
      data: {
        id: caseId,
        quarantine_key: `discovered-pdf-notification:${sourceId}:hash`,
        category: "initial_document",
        status: "in_review",
        evidence_hash: "a".repeat(64),
        shared_award_source_id: sourceId,
        evidence: {
          discovered_link: {
            parent_shared_award_source_id: sourceId,
            normalized_url: "https://example.org/2027-rules.pdf",
          },
        },
      },
      error: null,
    };
    mocks.assignmentResult = {
      data: {
        assigned_to_user_id: actorId,
        assigned_to_email: "admin@awardping.test",
      },
      error: null,
    };
    mocks.from.mockImplementation((table: string) =>
      query(table === "manual_quarantine_registry" ? mocks.quarantineResult : mocks.assignmentResult),
    );
    mocks.rpc.mockResolvedValue({
      data: [{
        bound_source_page_request_id: requestId,
        created: true,
        resolved: true,
      }],
      error: null,
    });
    mocks.createSupabaseAdminClient.mockReturnValue({ from: mocks.from, rpc: mocks.rpc });
  });

  it.each([null, "https://attacker.test"])("rejects a %s Origin before authentication", async (origin) => {
    const response = await POST(routeRequest(validBody(), origin));
    expect(response.status).toBe(403);
    expect(mocks.getCurrentUser).not.toHaveBeenCalled();
  });

  it("queues exactly one explicitly approved live review with an honest charge receipt", async () => {
    const response = await POST(routeRequest(validBody()));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      requestId,
      createsApiChargeNow: false,
      reviewMayCharge: true,
    });
    expect(mocks.rpc).toHaveBeenCalledWith(
      "resolve_shared_award_discovered_link_quarantine",
      {
        p_parent_source_id: sourceId,
        p_normalized_url: "https://example.org/2027-rules.pdf",
        p_action: "approve_new_live_review",
        p_actor: "Admin@AwardPing.test",
        p_actor_user_id: actorId,
        p_expected_evidence_hash: "a".repeat(64),
        p_source_page_request_id: null,
      },
    );
  });

  it("requires exact evidence, in-review state, and ownership by the current operator", async () => {
    mocks.quarantineResult = { data: null, error: null };
    const stale = await POST(routeRequest(validBody()));

    mocks.quarantineResult = {
      data: {
        ...(validQuarantine() as Record<string, unknown>),
        status: "quarantined",
      },
      error: null,
    };
    const notStarted = await POST(routeRequest(validBody()));

    mocks.quarantineResult = { data: validQuarantine(), error: null };
    mocks.assignmentResult = { data: null, error: null };
    const unowned = await POST(routeRequest(validBody()));

    expect(stale.status).toBe(409);
    expect(notStarted.status).toBe(409);
    expect(unowned.status).toBe(409);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("fails closed for incomplete preserved provenance and unsafe RPC receipts", async () => {
    mocks.quarantineResult = {
      data: {
        ...validQuarantine(),
        evidence: { discovered_link: { normalized_url: "javascript:alert(1)" } },
      },
      error: null,
    };
    const invalidEvidence = await POST(routeRequest(validBody()));

    mocks.quarantineResult = { data: validQuarantine(), error: null };
    mocks.rpc.mockResolvedValueOnce({ data: [], error: null });
    const invalidReceipt = await POST(routeRequest(validBody()));

    expect(invalidEvidence.status).toBe(409);
    expect(invalidReceipt.status).toBe(500);
  });
});

function validQuarantine() {
  return {
    id: caseId,
    quarantine_key: `discovered-pdf-notification:${sourceId}:hash`,
    category: "initial_document",
    status: "in_review",
    evidence_hash: "a".repeat(64),
    shared_award_source_id: sourceId,
    evidence: {
      discovered_link: {
        parent_shared_award_source_id: sourceId,
        normalized_url: "https://example.org/2027-rules.pdf",
      },
    },
  };
}

function validBody() {
  return {
    action: "approve_new_live_review",
    caseId,
    evidenceHash: "a".repeat(64),
  };
}

function routeRequest(body: unknown, origin: string | null = "https://awardping.test") {
  const headers = new Headers({ "content-type": "application/json" });
  if (origin !== null) headers.set("origin", origin);
  return new Request("https://awardping.test/api/admin/manual-quarantine/discovered-pdf", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

function query(result: unknown) {
  const chain = {
    select: vi.fn(),
    eq: vi.fn(),
    maybeSingle: vi.fn(),
  };
  chain.select.mockReturnValue(chain);
  chain.eq.mockReturnValue(chain);
  chain.maybeSingle.mockImplementation(() => Promise.resolve(result));
  return chain;
}
