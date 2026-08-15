import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createSupabaseAdminClient: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({
  appConfig: {
    cronSecret: "test-public-update-secret",
    url: "https://awardping.test",
  },
  hasSupabaseAdminConfig: () => true,
}));
vi.mock("@/lib/personal-data", () => ({
  encryptedEmailFields: (email: string) => ({
    email_hash: "a".repeat(64),
    email_encrypted: `encrypted:${email}`,
  }),
  personalDataLookupHash: () => "a".repeat(64),
  readPersonalData: (value: string | null) =>
    value?.startsWith("encrypted:")
      ? { status: "available", value: value.slice("encrypted:".length) }
      : { status: "missing", value: null },
}));
vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdminClient: mocks.createSupabaseAdminClient,
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
  markPublicUpdateConfirmationSent,
  publicUpdateConfirmationDeliveryIsCurrent,
} from "@/lib/public-updates";
import { hashToken } from "@/lib/public-updates-core";

const subscriberId = "7d669bcb-7e7b-43b1-a20d-76ec977db7bf";
const emailHash = "a".repeat(64);

describe("public-update confirmation persistence", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-16T03:00:00.000Z"));
    vi.clearAllMocks();
  });

  it("suppresses resend while the persisted pending link is fresh", async () => {
    const fake = statefulSubscriberStore([
      subscriber({
        status: "pending",
        confirmation_sent_at: "2026-08-16T02:00:00.000Z",
        updated_at: "2026-08-16T02:00:00.000Z",
      }),
    ]);
    mocks.createSupabaseAdminClient.mockReturnValue(fake.client);

    await expect(
      createOrRefreshPublicUpdateSubscription("reader@example.org"),
    ).resolves.toMatchObject({
      subscriberId,
      confirmationToken: null,
      shouldSendConfirmation: false,
    });
    expect(fake.rows[0].confirmation_sent_at).toBe(
      "2026-08-16T02:00:00.000Z",
    );
  });

  it("makes concurrent expired-link retries converge on one token and key", async () => {
    const fake = statefulSubscriberStore([
      subscriber({
        status: "pending",
        confirmation_sent_at: "2026-08-15T01:00:00.000Z",
        updated_at: "2026-08-15T01:00:05.000Z",
      }),
    ]);
    mocks.createSupabaseAdminClient.mockReturnValue(fake.client);

    const [first, second] = await Promise.all([
      createOrRefreshPublicUpdateSubscription("reader@example.org"),
      createOrRefreshPublicUpdateSubscription("reader@example.org"),
    ]);

    expect(first.confirmationToken).toBe(second.confirmationToken);
    expect(first.confirmationIdempotencyKey).toBe(
      second.confirmationIdempotencyKey,
    );
    expect(first.shouldSendConfirmation).toBe(true);
    expect(second.shouldSendConfirmation).toBe(true);
    expect(fake.rows).toHaveLength(1);
    expect(fake.rows[0]).toMatchObject({
      status: "pending",
      confirmation_sent_at: null,
      updated_at: "2026-08-16T01:00:00.000Z",
      confirmation_token_hash: hashToken(first.confirmationToken!),
    });
  });

  it("converges concurrent first-time inserts through the email-hash constraint", async () => {
    const fake = statefulSubscriberStore([]);
    mocks.createSupabaseAdminClient.mockReturnValue(fake.client);

    const [first, second] = await Promise.all([
      createOrRefreshPublicUpdateSubscription("reader@example.org"),
      createOrRefreshPublicUpdateSubscription("reader@example.org"),
    ]);

    expect(fake.rows).toHaveLength(1);
    expect(first.subscriberId).toBe(second.subscriberId);
    expect(first.confirmationToken).toBe(second.confirmationToken);
    expect(first.confirmationIdempotencyKey).toBe(
      second.confirmationIdempotencyKey,
    );
  });

  it("makes concurrent resubscriptions converge on the unsubscribe transition", async () => {
    const fake = statefulSubscriberStore([
      subscriber({
        status: "unsubscribed",
        confirmation_sent_at: "2026-07-01T00:00:00.000Z",
        unsubscribed_at: "2026-08-15T08:30:00.000Z",
        updated_at: "2026-08-15T08:30:00.000Z",
      }),
    ]);
    mocks.createSupabaseAdminClient.mockReturnValue(fake.client);

    const [first, second] = await Promise.all([
      createOrRefreshPublicUpdateSubscription("reader@example.org"),
      createOrRefreshPublicUpdateSubscription("reader@example.org"),
    ]);

    expect(first.confirmationToken).toBe(second.confirmationToken);
    expect(first.confirmationIdempotencyKey).toBe(
      second.confirmationIdempotencyKey,
    );
    expect(fake.rows[0]).toMatchObject({
      status: "pending",
      confirmation_sent_at: null,
      unsubscribed_at: null,
      updated_at: "2026-08-15T08:30:00.000Z",
    });
  });

  it("keeps a failed background attempt retryable with the same sealed key", async () => {
    const fake = statefulSubscriberStore([
      subscriber({
        status: "pending",
        confirmation_sent_at: null,
        updated_at: "2026-08-16T01:00:00.000Z",
      }),
    ]);
    mocks.createSupabaseAdminClient.mockReturnValue(fake.client);

    const first = await createOrRefreshPublicUpdateSubscription(
      "reader@example.org",
    );
    vi.setSystemTime(new Date("2026-08-16T05:00:00.000Z"));
    const retry = await createOrRefreshPublicUpdateSubscription(
      "reader@example.org",
    );

    expect(retry.confirmationToken).toBe(first.confirmationToken);
    expect(retry.confirmationIdempotencyKey).toBe(
      first.confirmationIdempotencyKey,
    );
    expect(retry.shouldSendConfirmation).toBe(true);

    vi.setSystemTime(new Date("2026-08-17T02:00:00.000Z"));
    const nextWindow = await createOrRefreshPublicUpdateSubscription(
      "reader@example.org",
    );
    expect(nextWindow.confirmationToken).not.toBe(first.confirmationToken);
    expect(nextWindow.confirmationIdempotencyKey).not.toBe(
      first.confirmationIdempotencyKey,
    );
    expect(nextWindow.confirmationAttemptSeal).toBe(
      "2026-08-17T01:00:00.000Z",
    );
  });

  it("records provider acceptance once without extending the TTL on duplicates", async () => {
    const token = "confirmation-token";
    const fake = statefulSubscriberStore([
      subscriber({
        status: "pending",
        confirmation_token_hash: hashToken(token),
        confirmation_sent_at: null,
        updated_at: "2026-08-16T02:00:00.000Z",
      }),
    ]);
    mocks.createSupabaseAdminClient.mockReturnValue(fake.client);

    const first = await markPublicUpdateConfirmationSent({
      subscriberId,
      confirmationToken: token,
      confirmationAttemptSeal: "2026-08-16T02:00:00.000Z",
    });
    vi.setSystemTime(new Date("2026-08-16T04:00:00.000Z"));
    const duplicate = await markPublicUpdateConfirmationSent({
      subscriberId,
      confirmationToken: token,
      confirmationAttemptSeal: "2026-08-16T02:00:00.000Z",
    });

    expect(first).toEqual({
      sentAt: "2026-08-16T02:00:00.000Z",
      acceptedAt: "2026-08-16T03:00:00.000Z",
      alreadyRecorded: false,
    });
    expect(duplicate).toEqual({
      sentAt: "2026-08-16T02:00:00.000Z",
      acceptedAt: null,
      alreadyRecorded: true,
    });
    expect(fake.rows[0].confirmation_sent_at).toBe(
      "2026-08-16T02:00:00.000Z",
    );
    vi.setSystemTime(new Date("2026-08-17T02:00:00.000Z"));
    await expect(confirmPublicUpdateSubscription(token)).resolves.toBe(false);
  });

  it("authorizes deferred delivery only while its unsent seal is current", async () => {
    const token = "confirmation-token";
    const attemptSeal = "2026-08-16T02:00:00.000Z";
    const fake = statefulSubscriberStore([
      subscriber({
        status: "pending",
        confirmation_token_hash: hashToken(token),
        confirmation_sent_at: null,
        updated_at: attemptSeal,
      }),
    ]);
    mocks.createSupabaseAdminClient.mockReturnValue(fake.client);

    await expect(
      publicUpdateConfirmationDeliveryIsCurrent({
        subscriberId,
        confirmationToken: token,
        confirmationAttemptSeal: attemptSeal,
      }),
    ).resolves.toBe(true);

    fake.rows[0].confirmation_token_hash = "d".repeat(64);
    await expect(
      publicUpdateConfirmationDeliveryIsCurrent({
        subscriberId,
        confirmationToken: token,
        confirmationAttemptSeal: attemptSeal,
      }),
    ).resolves.toBe(false);
  });

  it.each([
    ["absent", null],
    ["unsent", { confirmation_sent_at: null }],
    ["expired", { confirmation_sent_at: "2026-08-15T01:00:00.000Z" }],
  ])("rejects %s confirmation tokens without mutation", async (label, override) => {
    const token = "confirmation-token";
    const fake = statefulSubscriberStore(
      override
        ? [
            subscriber({
              status: "pending",
              confirmation_token_hash: hashToken(token),
              ...override,
            }),
          ]
        : [],
    );
    mocks.createSupabaseAdminClient.mockReturnValue(fake.client);

    await expect(confirmPublicUpdateSubscription(token)).resolves.toBe(false);
    if (label === "absent") expect(fake.rows).toHaveLength(0);
    else expect(fake.rows[0]?.status).toBe("pending");
  });

  it("activates only a sent, unexpired token through a fenced update", async () => {
    const token = "confirmation-token";
    const fake = statefulSubscriberStore([
      subscriber({
        status: "pending",
        confirmation_token_hash: hashToken(token),
        confirmation_sent_at: "2026-08-16T02:00:00.000Z",
      }),
    ]);
    mocks.createSupabaseAdminClient.mockReturnValue(fake.client);

    await expect(confirmPublicUpdateSubscription(token)).resolves.toBe(true);
    expect(fake.rows[0]).toMatchObject({
      status: "active",
      confirmation_token_hash: null,
      confirmed_at: "2026-08-16T03:00:00.000Z",
      digest_started_at: "2026-08-16T03:00:00.000Z",
    });
  });
});

type Subscriber = {
  id: string;
  email: string | null;
  email_hash: string | null;
  email_encrypted: string | null;
  status: "pending" | "active" | "unsubscribed";
  confirmation_token_hash: string | null;
  unsubscribe_token_hash: string;
  confirmation_sent_at: string | null;
  confirmed_at: string | null;
  unsubscribed_at: string | null;
  last_digest_sent_at: string | null;
  digest_started_at: string;
  created_at: string;
  updated_at: string;
};
type SubscriberPatch = Partial<Subscriber>;

function subscriber(overrides: SubscriberPatch = {}): Subscriber {
  const timestamp = "2026-08-15T01:00:00.000Z";
  return {
    id: subscriberId,
    email: null as string | null,
    email_hash: emailHash as string | null,
    email_encrypted: "encrypted:reader@example.org" as string | null,
    status: "pending" as "pending" | "active" | "unsubscribed",
    confirmation_token_hash: "b".repeat(64) as string | null,
    unsubscribe_token_hash: "c".repeat(64),
    confirmation_sent_at: null as string | null,
    confirmed_at: null as string | null,
    unsubscribed_at: null as string | null,
    last_digest_sent_at: null as string | null,
    digest_started_at: timestamp,
    created_at: timestamp,
    updated_at: timestamp,
    ...overrides,
  };
}

function statefulSubscriberStore(initialRows: Subscriber[]) {
  const rows = initialRows.map((row) => ({ ...row }));
  const client = {
    from(table: string) {
      if (table !== "public_update_subscribers") {
        throw new Error(`Unexpected table: ${table}`);
      }
      let operation: "select" | "update" | "insert" = "select";
      let payload: SubscriberPatch | SubscriberPatch[] | null = null;
      const filters: Array<(row: Subscriber) => boolean> = [];
      let executed = false;

      const execute = async (single: boolean) => {
        if (executed) throw new Error("Query executed more than once.");
        executed = true;

        if (operation === "insert") {
          const inserts = Array.isArray(payload) ? payload : [payload || {}];
          if (
            inserts.some((candidate) =>
              rows.some(
                (row) =>
                  candidate.email_hash !== null &&
                  row.email_hash === candidate.email_hash,
              ),
            )
          ) {
            return { data: null, error: { code: "23505" } };
          }
          for (const candidate of inserts) {
            rows.push(subscriber(candidate));
          }
          return { data: null, error: null };
        }

        const matches = rows.filter((row) =>
          filters.every((filter) => filter(row)),
        );
        if (operation === "update") {
          for (const row of matches) Object.assign(row, payload);
        }
        const data = single
          ? matches[0]
            ? { ...matches[0] }
            : null
          : matches.map((row) => ({ ...row }));
        return { data, error: null };
      };

      const builder = {
        select() {
          return builder;
        },
        update(value: SubscriberPatch) {
          operation = "update";
          payload = value;
          return builder;
        },
        insert(value: SubscriberPatch | SubscriberPatch[]) {
          operation = "insert";
          payload = value;
          return builder;
        },
        eq(column: keyof Subscriber, value: unknown) {
          filters.push((row) => row[column] === value);
          return builder;
        },
        is(column: keyof Subscriber, value: unknown) {
          filters.push((row) => row[column] === value);
          return builder;
        },
        gt(column: keyof Subscriber, value: string) {
          filters.push((row) => String(row[column]) > value);
          return builder;
        },
        lte(column: keyof Subscriber, value: string) {
          filters.push((row) => String(row[column]) <= value);
          return builder;
        },
        maybeSingle() {
          return execute(true);
        },
        then<TResult1 = unknown, TResult2 = never>(
          resolve?: ((value: unknown) => TResult1 | PromiseLike<TResult1>) | null,
          reject?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
        ) {
          return execute(false).then(resolve, reject);
        },
      };
      return builder;
    },
  };
  return { client, rows };
}
