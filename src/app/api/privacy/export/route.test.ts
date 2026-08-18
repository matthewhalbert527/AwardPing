import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  effects: [] as Array<Record<string, unknown>>,
  legacyExport: {
    state: "incomplete",
    unattributable_retained_items: 1,
    items: [],
  } as Record<string, unknown>,
  auditInsertError: null as string | null,
  loadError: null as string | null,
}));

vi.mock("@/lib/auth", () => ({
  getCurrentUser: vi.fn(async () => ({
    id: "owner-id",
    email: "owner@awardping.test",
    created_at: "2026-01-01T00:00:00.000Z",
    last_sign_in_at: "2026-07-17T00:00:00.000Z",
  })),
}));

vi.mock("@/lib/personal-data", () => ({
  personalDataLookupHash: vi.fn(() => "a".repeat(64)),
  decryptProfileFields: vi.fn(() => ({
    id: "owner-id",
    personal_data_status: "available",
    personal_data_reentry_required: false,
    personal_data_unavailable_fields: [],
    personal_data_unavailable_reasons: [],
  })),
}));

vi.mock("@/lib/supabase/admin", () => {
  function tableBuilder(table: string) {
    let inserting = false;
    const builder = {
      insert(payload: unknown) {
        inserting = true;
        state.effects.push({ type: "insert", table, payload });
        return builder;
      },
      select(...args: unknown[]) {
        void args;
        return builder;
      },
      eq(column: string, value: unknown) {
        state.effects.push({ type: "eq", table, column, value });
        return builder;
      },
      order(...args: unknown[]) {
        void args;
        return builder;
      },
      async maybeSingle() {
        return {
          data: table === "profiles" ? { id: "owner-id" } : null,
          error: table === "profiles" && state.loadError
            ? { message: state.loadError }
            : null,
        };
      },
      then<TResult1 = unknown, TResult2 = never>(
        onfulfilled?:
          | ((value: { data: unknown[]; error: { message: string } | null }) => TResult1 | PromiseLike<TResult1>)
          | null,
        onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
      ) {
        if (table === "privacy_requests" && inserting) {
          return Promise.resolve({
            data: [],
            error: state.auditInsertError
              ? { message: state.auditInsertError }
              : null,
          }).then(onfulfilled, onrejected);
        }
        const data = table === "public_update_subscribers"
          ? [{ id: "legacy-subscriber-id", email_hash: "a".repeat(64) }]
          : [];
        return Promise.resolve({ data, error: null }).then(
          onfulfilled,
          onrejected,
        );
      },
    };
    return builder;
  }

  return {
    createSupabaseAdminClient: vi.fn(() => ({
      from: (table: string) => tableBuilder(table),
      rpc: vi.fn(async (name: string, args: unknown) => {
        state.effects.push({ type: "rpc", name, args });
        return { data: state.legacyExport, error: null };
      }),
    })),
  };
});

import { GET } from "./route";

describe("privacy export legacy identity boundary", () => {
  beforeEach(() => {
    state.effects.length = 0;
    state.legacyExport = {
      state: "incomplete",
      unattributable_retained_items: 1,
      items: [],
    };
    state.auditInsertError = null;
    state.loadError = null;
  });

  it("does not report a complete export when retained evidence is unattributable", async () => {
    const response = await GET();

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "legacy_contact_identity_unavailable",
      auditStatus: "failure_recorded",
    });
    expect(state.effects).toContainEqual(
      expect.objectContaining({
        type: "insert",
        table: "privacy_requests",
        payload: expect.objectContaining({
          request_type: "export",
          status: "failed",
        }),
      }),
    );
    expect(state.effects).not.toContainEqual(
      expect.objectContaining({
        type: "insert",
        table: "privacy_requests",
        payload: expect.objectContaining({ status: "completed" }),
      }),
    );
  });

  it("exports an exactly linked legacy artifact and preserves normal completion", async () => {
    const item = {
      id: "legacy-artifact-id",
      source_table: "public_update_subscribers",
      source_record_id: "legacy-subscriber-id",
      source_column: "email_encrypted",
      ciphertext_format: "ap:v1",
      lifecycle_status: "recovered_v2",
      resolution: "exact_key_recovered_subscriber_v2",
      observed_at: "2026-07-17T00:00:00.000Z",
      resolved_at: null,
    };
    state.legacyExport = {
      state: "complete",
      unattributable_retained_items: 0,
      items: [item],
    };

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.auditStatus).toBe("completion_recorded");
    expect(body.personalDataRecovery.legacyContactArtifacts).toEqual([item]);
    expect(body.publicUpdateSubscriptions).toContainEqual(
      expect.objectContaining({ id: "legacy-subscriber-id" }),
    );
    expect(state.effects).toContainEqual({
      type: "rpc",
      name: "get_personal_data_legacy_contact_export",
      args: {
        p_v2_email_hash: "a".repeat(64),
      },
    });
    expect(state.effects).toContainEqual(
      expect.objectContaining({
        type: "insert",
        table: "privacy_requests",
        payload: expect.objectContaining({ status: "completed" }),
      }),
    );
  });

  it("discloses an audit persistence failure on an incomplete export", async () => {
    state.auditInsertError = "privacy audit storage unavailable";

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body).toMatchObject({
      code: "legacy_contact_identity_unavailable",
      auditStatus: "recording_failed",
      warning: expect.stringContaining("requires operator reconciliation"),
    });
  });

  it("delivers a complete export but discloses a failed completion audit", async () => {
    state.legacyExport = {
      state: "complete",
      unattributable_retained_items: 0,
      items: [],
    };
    state.auditInsertError = "privacy audit storage unavailable";

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      auditStatus: "recording_failed",
      warning: expect.stringContaining("requires operator reconciliation"),
      account: { id: "owner-id" },
    });
    expect(state.effects).toContainEqual(
      expect.objectContaining({
        type: "insert",
        table: "privacy_requests",
        payload: expect.objectContaining({ status: "completed" }),
      }),
    );
  });

  it("does not expose a backend error in the export response", async () => {
    state.loadError = "relation private.internal_export_view does not exist";

    const response = await GET();

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: "Data export could not be created.",
    });
  });
});
