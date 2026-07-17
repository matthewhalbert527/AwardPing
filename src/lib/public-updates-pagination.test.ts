import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({
  appConfig: { cronSecret: "test-secret", url: "https://awardping.org" },
  hasSupabaseAdminConfig: () => true,
}));
vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdminClient: vi.fn(),
}));
vi.mock("@/lib/stage1-publication", () => ({
  loadStage1PublicationIndex: vi.fn(),
}));
vi.mock("@/lib/public-change-events", () => ({
  loadEligiblePublicChangeEvents: vi.fn(),
}));

import {
  loadAllActivePublicDigestSubscribers,
  loadReservedPublicDigestEvents,
} from "@/lib/public-updates";

type TestRow = Record<string, unknown> & { id: string };
type QueryCall = {
  table: string;
  cursor: string | null;
  limit: number;
  inFilters: Map<string, string[]>;
};

describe("public digest keyset reads", () => {
  it("loads subscribers beyond the PostgREST response cap without gaps", async () => {
    const rows = Array.from({ length: 1_001 }, (_, index) => subscriber(index + 1));
    const fake = pagedSupabase({ public_update_subscribers: rows });

    const result = await loadAllActivePublicDigestSubscribers(fake.client as never);

    expect(result.map((row) => row.id)).toEqual(rows.map((row) => row.id));
    expect(fake.calls).toHaveLength(3);
    expect(fake.calls.map((call) => call.limit)).toEqual([500, 500, 500]);
    expect(fake.calls.map((call) => call.cursor)).toEqual([
      null,
      rows[499].id,
      rows[999].id,
    ]);
  });

  it("performs an empty probe after an exact multiple of the page size", async () => {
    const rows = Array.from({ length: 1_000 }, (_, index) => subscriber(index + 1));
    const fake = pagedSupabase({ public_update_subscribers: rows });

    await expect(
      loadAllActivePublicDigestSubscribers(fake.client as never),
    ).resolves.toHaveLength(1_000);
    expect(fake.calls).toHaveLength(3);
    expect(fake.calls.at(-1)?.cursor).toBe(rows.at(-1)?.id);
  });

  it("loads every receipt in a bounded 25-by-75 filter chunk", async () => {
    const subscriberIds = Array.from({ length: 16 }, (_, index) => uuid(index + 1, 1));
    const eventIds = Array.from({ length: 75 }, (_, index) => uuid(index + 1, 2));
    const rows = subscriberIds.flatMap((subscriberId) =>
      eventIds.map((eventId) => ({
        id: uuid(0, 3),
        subscriber_id: subscriberId,
        change_event_id: eventId,
      })),
    ).map((row, index) => ({ ...row, id: uuid(index + 1, 3) }));
    const fake = pagedSupabase({ public_digest_event_receipts: rows });

    const result = await loadReservedPublicDigestEvents(
      fake.client as never,
      subscriberIds,
      eventIds,
    );

    expect([...result.values()].reduce((total, ids) => total + ids.size, 0)).toBe(1_200);
    expect(fake.calls).toHaveLength(3);
    expect(fake.calls.map((call) => call.limit)).toEqual([500, 500, 500]);
    for (const call of fake.calls) {
      expect(call.inFilters.get("subscriber_id")?.length).toBeLessThanOrEqual(25);
      expect(call.inFilters.get("change_event_id")?.length).toBeLessThanOrEqual(75);
    }
  });

  it("fails closed when a full page does not advance the cursor", async () => {
    const rows = Array.from({ length: 500 }, (_, index) => subscriber(index + 1));
    const fake = pagedSupabase(
      { public_update_subscribers: rows },
      { ignoreCursor: true },
    );

    await expect(
      loadAllActivePublicDigestSubscribers(fake.client as never),
    ).rejects.toThrow("pagination did not advance");
  });
});

function pagedSupabase(
  tables: Record<string, TestRow[]>,
  options: { ignoreCursor?: boolean } = {},
) {
  const calls: QueryCall[] = [];
  const client = {
    from(table: string) {
      let cursor: string | null = null;
      let pageLimit = 1_000;
      const equals = new Map<string, unknown>();
      const inFilters = new Map<string, string[]>();
      const builder = {
        select() {
          return builder;
        },
        eq(column: string, value: unknown) {
          equals.set(column, value);
          return builder;
        },
        in(column: string, values: string[]) {
          inFilters.set(column, values);
          return builder;
        },
        order() {
          return builder;
        },
        limit(value: number) {
          pageLimit = value;
          return builder;
        },
        gt(_column: string, value: string) {
          cursor = value;
          return builder;
        },
        then<TResult1 = unknown, TResult2 = never>(
          resolve?: ((value: unknown) => TResult1 | PromiseLike<TResult1>) | null,
          reject?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
        ) {
          calls.push({
            table,
            cursor,
            limit: pageLimit,
            inFilters: new Map(inFilters),
          });
          const data = (tables[table] || [])
            .filter((row) =>
              [...equals].every(([column, value]) => row[column] === value) &&
              [...inFilters].every(([column, values]) =>
                values.includes(String(row[column])),
              ) &&
              (options.ignoreCursor || cursor === null || row.id > cursor),
            )
            .sort((left, right) => left.id.localeCompare(right.id))
            .slice(0, Math.min(pageLimit, 1_000));
          return Promise.resolve({ data, error: null }).then(resolve, reject);
        },
      };
      return builder;
    },
  };
  return { client, calls };
}

function subscriber(index: number) {
  const timestamp = "2026-07-01T00:00:00.000Z";
  return {
    id: uuid(index, 1),
    status: "active",
    email: null,
    email_hash: "a".repeat(64),
    email_encrypted: "encrypted",
    confirmation_token_hash: null,
    unsubscribe_token_hash: "b".repeat(64),
    confirmation_sent_at: timestamp,
    confirmed_at: timestamp,
    unsubscribed_at: null,
    last_digest_sent_at: null,
    digest_started_at: timestamp,
    created_at: timestamp,
    updated_at: timestamp,
  };
}

function uuid(index: number, namespace: number) {
  return `${namespace.toString(16).padStart(8, "0")}-0000-4000-8000-${index
    .toString(16)
    .padStart(12, "0")}`;
}
