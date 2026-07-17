import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  send: vi.fn(),
  calls: [] as string[],
}));

vi.mock("@/lib/config", () => ({
  appConfig: {
    cronSecret: "secret",
    url: "https://awardping.org",
  },
  hasSupabaseAdminConfig: () => true,
}));
vi.mock("@/lib/personal-data", () => ({
  decryptPersonalData: () => "reader@example.org",
  encryptedEmailFields: vi.fn(),
  personalDataLookupHash: () => "recipient-hash",
}));
vi.mock("@/lib/email", () => ({
  PublicDigestDeliveryError: class PublicDigestDeliveryError extends Error {
    constructor(
      message: string,
      readonly ambiguous: boolean,
      readonly retryable: boolean,
    ) {
      super(message);
    }
  },
  renderPublicDailyDigestEmail: vi.fn(),
  sendFrozenPublicDailyDigestEmail: (...args: unknown[]) => {
    mocks.calls.push("provider");
    return mocks.send(...args);
  },
}));
vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdminClient: () => ({
    rpc: (...args: unknown[]) => mocks.rpc(...args),
  }),
}));
vi.mock("@/lib/stage1-publication", () => ({
  loadStage1PublicationIndex: vi.fn(),
}));
vi.mock("@/lib/public-change-events", () => ({
  loadEligiblePublicChangeEvents: vi.fn(),
}));

import {
  drainPublicDigestOutbox,
  unsubscribePublicUpdateSubscriber,
} from "@/lib/public-updates";

const claim = {
  id: "10000000-0000-4000-8000-000000000001",
  lease_token: "20000000-0000-4000-8000-000000000001",
  recipient_hash: "recipient-hash",
  recipient_encrypted: "encrypted-recipient",
  rendered_payload: {
    schemaVersion: "public-digest-render-v1",
    from: "AwardPing <updates@example.org>",
    subject: "Frozen subject",
    html: "<p>Frozen HTML</p>",
    text: "Frozen text",
  },
  payload_hash: "a".repeat(64),
  provider_idempotency_key: `awardping-public-digest:${"a".repeat(64)}`,
  send_attempt_count: 0,
};

describe("public digest outbox drain", () => {
  beforeEach(() => {
    mocks.rpc.mockReset();
    mocks.send.mockReset();
    mocks.calls.length = 0;
  });

  it("authorizes in the database before sending frozen fields and completes by RPC", async () => {
    mocks.rpc.mockImplementation(async (name: string) => {
      mocks.calls.push(name);
      if (name === "claim_public_digest_outbox") return { data: [claim], error: null };
      if (name === "authorize_public_digest_send") return { data: true, error: null };
      if (name === "complete_public_digest_send") return { data: true, error: null };
      throw new Error(`Unexpected RPC ${name}`);
    });
    mocks.send.mockResolvedValue({ providerMessageId: "provider-1" });

    const result = await drainPublicDigestOutbox({
      workerId: "test-worker",
      limit: 1,
    });

    expect(mocks.calls).toEqual([
      "claim_public_digest_outbox",
      "authorize_public_digest_send",
      "provider",
      "complete_public_digest_send",
    ]);
    expect(mocks.send).toHaveBeenCalledWith({
      from: "AwardPing <updates@example.org>",
      subject: "Frozen subject",
      html: "<p>Frozen HTML</p>",
      text: "Frozen text",
      to: "reader@example.org",
      idempotencyKey: claim.provider_idempotency_key,
    });
    expect(result.sent).toBe(1);
  });

  it("never contacts the provider when the authoritative pre-send check fails", async () => {
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === "claim_public_digest_outbox") return { data: [claim], error: null };
      if (name === "authorize_public_digest_send") return { data: false, error: null };
      throw new Error(`Unexpected RPC ${name}`);
    });

    const result = await drainPublicDigestOutbox({ workerId: "test-worker" });

    expect(mocks.send).not.toHaveBeenCalled();
    expect(result.releaseBlocked).toBe(1);
    expect(result.sent).toBe(0);
  });

  it.each([
    "unsubscribed",
    "not_found",
    "retry_active_send",
  ] as const)("returns the database-owned unsubscribe outcome %s", async (outcome) => {
    mocks.rpc.mockResolvedValue({ data: outcome, error: null });

    await expect(unsubscribePublicUpdateSubscriber("public-token")).resolves.toBe(outcome);

    expect(mocks.rpc).toHaveBeenCalledWith(
      "unsubscribe_public_update_subscriber",
      { p_unsubscribe_token_hash: expect.stringMatching(/^[0-9a-f]{64}$/) },
    );
  });
});
