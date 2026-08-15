import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  hasPublicUpdateDeliveryConfig: vi.fn(),
  renderPublicUpdateConfirmationEmail: vi.fn(),
  sendFrozenPublicUpdateConfirmationEmail: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({
  appConfig: {
    cronSecret: "test-public-update-secret",
    url: "https://awardping.test",
  },
  hasSupabaseAdminConfig: () => true,
  hasPublicUpdateDeliveryConfig: mocks.hasPublicUpdateDeliveryConfig,
}));
vi.mock("@/lib/email", () => ({
  PublicDigestDeliveryError: class PublicDigestDeliveryError extends Error {},
  renderPublicUpdateConfirmationEmail:
    mocks.renderPublicUpdateConfirmationEmail,
  renderPublicDailyDigestEmail: vi.fn(),
  sendFrozenPublicUpdateConfirmationEmail:
    mocks.sendFrozenPublicUpdateConfirmationEmail,
  sendFrozenPublicDailyDigestEmail: vi.fn(),
}));
vi.mock("@/lib/personal-data", () => ({
  encryptPersonalData: (value: string) => `ap:v2:test:${value}`,
  encryptedEmailFields: (email: string) => ({
    email_hash: "a".repeat(64),
    email_encrypted: `ap:v2:test:${email}`,
  }),
  personalDataLookupHash: () => "a".repeat(64),
  readPersonalData: (value: string | null) =>
    value?.startsWith("ap:v2:test:")
      ? { status: "available", value: value.slice("ap:v2:test:".length) }
      : { status: "unavailable", value: null },
}));
vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdminClient: () => ({ rpc: mocks.rpc }),
}));
vi.mock("@/lib/stage1-publication", () => ({
  loadStage1PublicationIndex: vi.fn(),
}));
vi.mock("@/lib/public-change-events", () => ({
  loadEligiblePublicChangeEvents: vi.fn(),
}));

import {
  confirmPublicUpdateSubscription,
  createOrRefreshPublicUpdateSubscription,
  drainPublicUpdateConfirmationOutbox,
} from "@/lib/public-updates";
import { hashToken } from "@/lib/public-updates-core";

const outboxId = "89e2ec55-b95e-4e2f-97c3-c67daef39ffc";
const leaseToken = "ac757a70-0e5b-4dcb-9e76-cdc61e535fd9";
const confirmationToken = "confirmation-token";
const frozenPayload = {
  from: "AwardPing <alerts@awardping.test>",
  to: "reader@example.org",
  subject: "Frozen confirmation subject",
  html:
    '<a href="https://awardping.test/api/public-updates/confirm?token=confirmation-token">Confirm</a>',
  text:
    "https://awardping.test/api/public-updates/confirm?token=confirmation-token",
};
const serializedFrozenPayload = JSON.stringify(frozenPayload);
const frozenPayloadHash = hashToken(serializedFrozenPayload);

describe("durable public-update confirmation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.hasPublicUpdateDeliveryConfig.mockReturnValue(true);
    mocks.renderPublicUpdateConfirmationEmail.mockImplementation(
      ({ to, confirmUrl }: { to: string; confirmUrl: string }) => ({
        from: "AwardPing <alerts@awardping.test>",
        to,
        subject: "Current confirmation subject",
        html: `<a href="${confirmUrl}">Confirm</a>`,
        text: confirmUrl,
      }),
    );
    mocks.sendFrozenPublicUpdateConfirmationEmail.mockResolvedValue({
      data: { id: "provider-message-1" },
      error: null,
    });
  });

  it("atomically supplies encrypted delivery material to the enqueue RPC", async () => {
    mocks.rpc.mockResolvedValue({
      data: [{ outbox_id: outboxId, needs_delivery: true }],
      error: null,
    });

    await expect(
      createOrRefreshPublicUpdateSubscription(" Reader@Example.org "),
    ).resolves.toEqual({ outboxId, needsDelivery: true });

    const [name, input] = mocks.rpc.mock.calls[0];
    expect(name).toBe("enqueue_public_update_confirmation");
    expect(input).toMatchObject({
      p_legacy_email: "reader@example.org",
      p_recipient_hash: "a".repeat(64),
      p_recipient_encrypted: "ap:v2:test:reader@example.org",
      p_confirmation_token_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
      p_confirmation_token_encrypted: expect.stringMatching(/^ap:v2:test:/),
      p_rendered_payload_encrypted: expect.stringMatching(/^ap:v2:test:/),
      p_payload_schema_version: "public-confirmation-render-v1",
      p_payload_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
      p_unsubscribe_token_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(input.p_confirmation_token_encrypted).not.toBe(
      input.p_confirmation_token_hash,
    );
    const serializedPayload = input.p_rendered_payload_encrypted.slice(
      "ap:v2:test:".length,
    );
    expect(input.p_payload_hash).toBe(hashToken(serializedPayload));
  });

  it("delegates expiry and activation to one database-clock RPC", async () => {
    mocks.rpc.mockResolvedValue({ data: true, error: null });

    await expect(
      confirmPublicUpdateSubscription(confirmationToken),
    ).resolves.toBe(true);
    expect(mocks.rpc).toHaveBeenCalledWith(
      "confirm_public_update_subscription",
      { p_confirmation_token_hash: hashToken(confirmationToken) },
    );
  });

  it("claims, authorizes, sends with the sealed key, and records acceptance", async () => {
    mockSuccessfulDrain();

    const result = await drainPublicUpdateConfirmationOutbox({
      outboxId,
      workerId: "test-worker",
    });

    expect(result).toMatchObject({ claimed: 1, accepted: 1, ambiguous: 0 });
    expect(mocks.sendFrozenPublicUpdateConfirmationEmail).toHaveBeenCalledWith({
      ...frozenPayload,
      idempotencyKey: `awardping-public-confirmation:${frozenPayloadHash}`,
    });
    expect(mocks.rpc).toHaveBeenCalledWith(
      "complete_public_update_confirmation_send",
      {
        p_outbox_id: outboxId,
        p_lease_token: leaseToken,
        p_provider_message_id: "provider-message-1",
      },
    );
  });

  it("records an explicit provider rejection as a non-ambiguous retry", async () => {
    mockSuccessfulDrain({ completionStatus: null });
    mocks.sendFrozenPublicUpdateConfirmationEmail.mockResolvedValue({
      data: null,
      error: { message: "rate limited", name: "rate_limit_exceeded", statusCode: 429 },
    });
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === "claim_public_update_confirmations") {
        return { data: [claim()], error: null };
      }
      if (name === "authorize_public_update_confirmation_send") {
        return { data: true, error: null };
      }
      if (name === "fail_public_update_confirmation_send") {
        return { data: "retry", error: null };
      }
      throw new Error(`Unexpected RPC ${name}`);
    });

    const result = await drainPublicUpdateConfirmationOutbox();
    expect(result.retry).toBe(1);
    expect(mocks.rpc).toHaveBeenCalledWith(
      "fail_public_update_confirmation_send",
      expect.objectContaining({ p_ambiguous: false, p_retryable: true }),
    );
  });

  it("records a thrown provider outcome as ambiguous for same-key retry", async () => {
    mocks.sendFrozenPublicUpdateConfirmationEmail.mockRejectedValue(
      new Error("connection reset"),
    );
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === "claim_public_update_confirmations") {
        return { data: [claim()], error: null };
      }
      if (name === "authorize_public_update_confirmation_send") {
        return { data: true, error: null };
      }
      if (name === "fail_public_update_confirmation_send") {
        return { data: "ambiguous", error: null };
      }
      throw new Error(`Unexpected RPC ${name}`);
    });

    const result = await drainPublicUpdateConfirmationOutbox();
    expect(result.ambiguous).toBe(1);
    expect(mocks.rpc).toHaveBeenCalledWith(
      "fail_public_update_confirmation_send",
      expect.objectContaining({ p_ambiguous: true, p_retryable: true }),
    );
  });

  it("records an SDK application error without an HTTP status as ambiguous", async () => {
    mocks.sendFrozenPublicUpdateConfirmationEmail.mockResolvedValue({
      data: null,
      error: {
        message: "Unable to determine provider response",
        name: "application_error",
        statusCode: null,
      },
    });
    mockFailureDrain("ambiguous");

    const result = await drainPublicUpdateConfirmationOutbox();

    expect(result.ambiguous).toBe(1);
    expect(mocks.rpc).toHaveBeenCalledWith(
      "fail_public_update_confirmation_send",
      expect.objectContaining({ p_ambiguous: true, p_retryable: true }),
    );
  });

  it("records a concurrent same-key 409 response as ambiguous", async () => {
    mocks.sendFrozenPublicUpdateConfirmationEmail.mockResolvedValue({
      data: null,
      error: {
        message: "The original idempotent request is still in progress",
        name: "concurrent_idempotent_requests",
        statusCode: 409,
      },
    });
    mockFailureDrain("ambiguous");

    const result = await drainPublicUpdateConfirmationOutbox();

    expect(result.ambiguous).toBe(1);
    expect(mocks.rpc).toHaveBeenCalledWith(
      "fail_public_update_confirmation_send",
      expect.objectContaining({ p_ambiguous: true, p_retryable: true }),
    );
  });

  it.each([
    {
      label: "non-retryable 400",
      name: "validation_error",
      statusCode: 400,
      nextStatus: "terminal_failed",
      retryable: false,
    },
    {
      label: "invalid-idempotency 409",
      name: "invalid_idempotent_request",
      statusCode: 409,
      nextStatus: "terminal_failed",
      retryable: false,
    },
    {
      label: "retryable 500",
      name: "application_error",
      statusCode: 500,
      nextStatus: "retry",
      retryable: true,
    },
  ])(
    "records a definite $label HTTP rejection as non-ambiguous",
    async ({ name, statusCode, nextStatus, retryable }) => {
      mocks.sendFrozenPublicUpdateConfirmationEmail.mockResolvedValue({
        data: null,
        error: {
          message: "Definite HTTP rejection",
          name,
          statusCode,
        },
      });
      mockFailureDrain(nextStatus);

      await drainPublicUpdateConfirmationOutbox();

      expect(mocks.rpc).toHaveBeenCalledWith(
        "fail_public_update_confirmation_send",
        expect.objectContaining({ p_ambiguous: false, p_retryable: retryable }),
      );
    },
  );

  it("retries the byte-identical frozen provider payload after runtime rendering changes", async () => {
    mocks.sendFrozenPublicUpdateConfirmationEmail.mockRejectedValue(
      new Error("connection reset"),
    );
    mockFailureDrain("ambiguous");

    await drainPublicUpdateConfirmationOutbox();
    mocks.renderPublicUpdateConfirmationEmail.mockReturnValue({
      ...frozenPayload,
      from: "changed@example.org",
      subject: "Changed after deploy",
    });
    await drainPublicUpdateConfirmationOutbox();

    const exactSend = {
      ...frozenPayload,
      idempotencyKey: `awardping-public-confirmation:${frozenPayloadHash}`,
    };
    expect(mocks.sendFrozenPublicUpdateConfirmationEmail).toHaveBeenNthCalledWith(
      1,
      exactSend,
    );
    expect(mocks.sendFrozenPublicUpdateConfirmationEmail).toHaveBeenNthCalledWith(
      2,
      exactSend,
    );
    expect(mocks.renderPublicUpdateConfirmationEmail).not.toHaveBeenCalled();
  });

  it("fails closed before provider I/O when the frozen payload hash changes", async () => {
    const tamperedPayload = JSON.stringify({
      ...frozenPayload,
      subject: "Tampered confirmation subject",
    });
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === "claim_public_update_confirmations") {
        return {
          data: [
            claim({
              rendered_payload_encrypted: `ap:v2:test:${tamperedPayload}`,
            }),
          ],
          error: null,
        };
      }
      if (name === "authorize_public_update_confirmation_send") {
        return { data: true, error: null };
      }
      if (name === "fail_public_update_confirmation_send") {
        return { data: "terminal_failed", error: null };
      }
      throw new Error(`Unexpected RPC ${name}`);
    });

    const result = await drainPublicUpdateConfirmationOutbox();

    expect(result.terminalFailed).toBe(1);
    expect(mocks.sendFrozenPublicUpdateConfirmationEmail).not.toHaveBeenCalled();
    expect(mocks.rpc).toHaveBeenCalledWith(
      "fail_public_update_confirmation_send",
      expect.objectContaining({ p_ambiguous: false, p_retryable: false }),
    );
  });

  it("does not claim work without the complete private delivery configuration", async () => {
    mocks.hasPublicUpdateDeliveryConfig.mockReturnValue(false);

    await expect(drainPublicUpdateConfirmationOutbox()).resolves.toMatchObject({
      claimed: 0,
      skipped: true,
    });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});

function claim(overrides: Record<string, unknown> = {}) {
  return {
    id: outboxId,
    lease_token: leaseToken,
    recipient_hash: "a".repeat(64),
    recipient_encrypted: "ap:v2:test:reader@example.org",
    confirmation_token_hash: hashToken(confirmationToken),
    confirmation_token_encrypted: `ap:v2:test:${confirmationToken}`,
    rendered_payload_encrypted: `ap:v2:test:${serializedFrozenPayload}`,
    payload_schema_version: "public-confirmation-render-v1",
    payload_hash: frozenPayloadHash,
    provider_idempotency_key:
      `awardping-public-confirmation:${frozenPayloadHash}`,
    expires_at: "2026-08-16T12:00:00.000Z",
    send_attempt_count: 0,
    ...overrides,
  };
}

function mockSuccessfulDrain({
  completionStatus = "accepted",
}: { completionStatus?: string | null } = {}) {
  mocks.rpc.mockImplementation(async (name: string) => {
    if (name === "claim_public_update_confirmations") {
      return { data: [claim()], error: null };
    }
    if (name === "authorize_public_update_confirmation_send") {
      return { data: true, error: null };
    }
    if (name === "complete_public_update_confirmation_send") {
      return { data: completionStatus, error: null };
    }
    if (name === "fail_public_update_confirmation_send") {
      return { data: "ambiguous", error: null };
    }
    throw new Error(`Unexpected RPC ${name}`);
  });
}

function mockFailureDrain(nextStatus: string) {
  mocks.rpc.mockImplementation(async (name: string) => {
    if (name === "claim_public_update_confirmations") {
      return { data: [claim()], error: null };
    }
    if (name === "authorize_public_update_confirmation_send") {
      return { data: true, error: null };
    }
    if (name === "fail_public_update_confirmation_send") {
      return { data: nextStatus, error: null };
    }
    throw new Error(`Unexpected RPC ${name}`);
  });
}
