import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  effects: [] as Array<Record<string, unknown>>,
  getCurrentUser: vi.fn(async () => ({
    id: "victim-user-id",
    email: "victim@awardping.test",
  })),
  rpcError: null as string | null,
  rpcErrorCode: null as string | null,
  rpcThrows: false,
  markerTampered: false,
  privacyRead: null as null | { status: string; details: unknown },
  privacyReadError: false,
  authDeleteError: null as string | null,
  authDeleteThrows: false,
  authLookup: "present" as "present" | "deleted" | "unknown",
}));

function appErasureMarker(tampered = false) {
  const marker = {
    schema_version: "privacy-app-data-erasure-v1",
    state: "completed",
    privacy_request_id: "privacy-request-id",
    user_id: "victim-user-id",
    email_hash: "a".repeat(64),
    completed_at: "2026-07-17T16:30:00.000000Z",
  };
  const basis = [
    marker.schema_version,
    marker.state,
    marker.privacy_request_id,
    marker.user_id,
    marker.email_hash,
    marker.completed_at,
  ].join("|");
  return {
    ...marker,
    evidence_hash: tampered
      ? "0".repeat(64)
      : createHash("sha256").update(basis, "utf8").digest("hex"),
  };
}

vi.mock("@/lib/auth", () => ({
  getCurrentUser: state.getCurrentUser,
}));

vi.mock("@/lib/personal-data", () => ({
  personalDataLookupHash: vi.fn(() => "a".repeat(64)),
}));

vi.mock("@/lib/supabase/admin", () => {
  function tableBuilder(table: string) {
    let inserting = false;
    let updating = false;
    const builder = {
      insert(payload: unknown) {
        inserting = true;
        state.effects.push({ type: "insert", table, payload });
        return builder;
      },
      delete() {
        state.effects.push({ type: "delete", table });
        return builder;
      },
      update(payload: unknown) {
        updating = true;
        state.effects.push({ type: "update", table, payload });
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
      async single() {
        return {
          data: table === "privacy_requests" ? { id: "privacy-request-id" } : null,
          error: null,
        };
      },
      async maybeSingle() {
        if (table === "privacy_requests" && !updating && !inserting) {
          return state.privacyReadError
            ? { data: null, error: { message: "privacy read unavailable" } }
            : { data: state.privacyRead, error: null };
        }
        return { data: { id: "privacy-request-id" }, error: null };
      },
      then<TResult1 = unknown, TResult2 = never>(
        onfulfilled?:
          | ((value: { data: null; error: null }) => TResult1 | PromiseLike<TResult1>)
          | null,
        onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
      ) {
        return Promise.resolve({ data: null, error: null }).then(
          onfulfilled,
          onrejected,
        );
      },
    };
    return builder;
  }

  const admin = {
    from(table: string) {
      return tableBuilder(table);
    },
    rpc: vi.fn(async (name: string, args: unknown) => {
      state.effects.push({ type: "rpc", name, args });
      if (state.rpcThrows) throw new Error("fetch failed after request dispatch");
      return {
        data: state.rpcError ? null : {
          app_data_erasure_marker: appErasureMarker(state.markerTampered),
        },
        error: state.rpcError
          ? { message: state.rpcError, code: state.rpcErrorCode || undefined }
          : null,
      };
    }),
    auth: {
      admin: {
        deleteUser: vi.fn(async (userId: string) => {
          state.effects.push({ type: "delete_user", userId });
          if (state.authDeleteThrows) throw new Error("Auth fetch failed");
          return {
            data: null,
            error: state.authDeleteError
              ? { message: state.authDeleteError }
              : null,
          };
        }),
        getUserById: vi.fn(async (userId: string) => {
          state.effects.push({ type: "get_user", userId });
          if (state.authLookup === "unknown") {
            return { data: { user: null }, error: { message: "Auth lookup failed" } };
          }
          if (state.authLookup === "deleted") {
            return {
              data: { user: null },
              error: { message: "User not found", status: 404, code: "user_not_found" },
            };
          }
          return { data: { user: { id: userId } }, error: null };
        }),
      },
    },
  };

  return {
    createSupabaseAdminClient: vi.fn(() => admin),
  };
});

import { POST } from "./route";

describe("privacy deletion mutation boundary", () => {
  beforeEach(() => {
    state.effects.length = 0;
    state.getCurrentUser.mockClear();
    state.rpcError = null;
    state.rpcErrorCode = null;
    state.rpcThrows = false;
    state.markerTampered = false;
    state.privacyRead = null;
    state.privacyReadError = false;
    state.authDeleteError = null;
    state.authDeleteThrows = false;
    state.authLookup = "present";
  });

  it("rejects a cross-origin request before authentication or side effects", async () => {
    const response = await POST(
      new Request("https://awardping.com/api/privacy/delete", {
        method: "POST",
        headers: {
          "content-type": "text/plain",
          origin: "https://evil.awardping.com",
        },
        body: '{"confirm":"DELETE"}',
      }),
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "This request is not allowed." });
    expect(state.getCurrentUser).not.toHaveBeenCalled();
    expect(state.effects).toEqual([]);
  });

  it("preserves a same-origin confirmed deletion", async () => {
    const response = await POST(
      new Request("https://awardping.com/api/privacy/delete", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://awardping.com",
        },
        body: '{"confirm":"DELETE"}',
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(state.effects).toContainEqual({
      type: "rpc",
      name: "erase_personal_data_for_privacy_request",
      args: {
        p_user_id: "victim-user-id",
        p_email_hash: "a".repeat(64),
        p_legacy_email: "victim@awardping.test",
        p_privacy_request_id: "privacy-request-id",
      },
    });
    expect(state.effects).toContainEqual({
      type: "delete_user",
      userId: "victim-user-id",
    });
  });

  it("does not delete Auth while legacy contact attribution is unresolved", async () => {
    state.rpcError =
      "legacy_contact_identity_unavailable: retained legacy contact evidence cannot be safely attributed.";
    state.rpcErrorCode = "55000";

    const response = await POST(
      new Request("https://awardping.com/api/privacy/delete", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://awardping.com",
        },
        body: '{"confirm":"DELETE"}',
      }),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error:
        "Account deletion is temporarily blocked while retained privacy evidence or an active delivery is reconciled.",
      code: "privacy_erasure_conflict",
    });
    const rpcIndex = state.effects.findIndex((effect) => effect.type === "rpc");
    expect(rpcIndex).toBeGreaterThan(-1);
    expect(
      state.effects.slice(0, rpcIndex).filter((effect) =>
        [
          "source_page_requests",
          "discovery_requests",
          "alert_deliveries",
          "shared_awards",
          "shared_award_sources",
        ].includes(String(effect.table || ""))
      ),
    ).toEqual([]);
    expect(state.effects).not.toContainEqual(
      expect.objectContaining({ type: "delete", table: "source_page_requests" }),
    );
    expect(state.effects).not.toContainEqual(
      expect.objectContaining({ type: "delete", table: "discovery_requests" }),
    );
    expect(state.effects).not.toContainEqual(
      expect.objectContaining({ type: "delete", table: "alert_deliveries" }),
    );
    expect(state.effects).not.toContainEqual(
      expect.objectContaining({ type: "update", table: "shared_awards" }),
    );
    expect(state.effects).not.toContainEqual(
      expect.objectContaining({ type: "update", table: "shared_award_sources" }),
    );
    expect(state.effects).not.toContainEqual(
      expect.objectContaining({ type: "delete_user" }),
    );
    expect(state.effects).toContainEqual(
      expect.objectContaining({
        type: "update",
        table: "privacy_requests",
        payload: expect.objectContaining({ status: "failed" }),
      }),
    );
  });

  it("returns a transaction conflict without prior route-side app-data mutation", async () => {
    state.rpcError =
      "Privacy erasure must retry after the active public digest send lease.";
    state.rpcErrorCode = "40001";

    const response = await POST(
      new Request("https://awardping.com/api/privacy/delete", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://awardping.com",
        },
        body: '{"confirm":"DELETE"}',
      }),
    );

    expect(response.status).toBe(409);
    expect(state.effects).toContainEqual(
      expect.objectContaining({
        type: "rpc",
        name: "erase_personal_data_for_privacy_request",
      }),
    );
    expect(state.effects).not.toContainEqual(
      expect.objectContaining({ type: "delete_user" }),
    );
    for (const table of [
      "source_page_requests",
      "discovery_requests",
      "alert_deliveries",
      "shared_awards",
      "shared_award_sources",
    ]) {
      expect(state.effects).not.toContainEqual(
        expect.objectContaining({ table }),
      );
    }
  });

  it("rejects a tampered completion marker and records the destructive outcome as unknown", async () => {
    state.markerTampered = true;
    state.privacyRead = {
      status: "pending",
      details: { app_data_erasure: appErasureMarker(true) },
    };

    const response = await POST(
      new Request("https://awardping.com/api/privacy/delete", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://awardping.com",
        },
        body: '{"confirm":"DELETE"}',
      }),
    );

    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({
      deletionStatus: "reconciliation_required",
      auditStatus: "failure_recorded",
    });
    expect(state.effects).not.toContainEqual(
      expect.objectContaining({ type: "delete_user" }),
    );
    expect(state.effects).toContainEqual(
      expect.objectContaining({
        type: "update",
        table: "privacy_requests",
        payload: expect.objectContaining({
          details: expect.objectContaining({
            failure_code: "app_data_erasure_outcome_unknown",
            audit_reconciliation_required: true,
          }),
        }),
      }),
    );
  });

  it("continues after an ambiguous RPC response when the exact marker persisted", async () => {
    state.rpcThrows = true;
    state.privacyRead = {
      status: "pending",
      details: { app_data_erasure: appErasureMarker(false) },
    };

    const response = await POST(
      new Request("https://awardping.com/api/privacy/delete", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://awardping.com",
        },
        body: '{"confirm":"DELETE"}',
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(state.effects).toContainEqual({
      type: "delete_user",
      userId: "victim-user-id",
    });
  });

  it("continues when Auth deletion errored but reconciliation proves the user is gone", async () => {
    state.authDeleteThrows = true;
    state.authLookup = "deleted";

    const response = await POST(
      new Request("https://awardping.com/api/privacy/delete", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://awardping.com",
        },
        body: '{"confirm":"DELETE"}',
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(state.effects).toContainEqual({
      type: "get_user",
      userId: "victim-user-id",
    });
  });

  it("reports an unknown Auth deletion outcome without claiming success", async () => {
    state.authDeleteError = "Auth provider response unavailable";
    state.authLookup = "unknown";

    const response = await POST(
      new Request("https://awardping.com/api/privacy/delete", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://awardping.com",
        },
        body: '{"confirm":"DELETE"}',
      }),
    );

    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({
      ok: false,
      deletionStatus: "reconciliation_required",
      auditStatus: "failure_recorded",
    });
    expect(state.effects).toContainEqual(
      expect.objectContaining({
        type: "update",
        table: "privacy_requests",
        payload: expect.objectContaining({
          details: expect.objectContaining({
            app_data_erasure: appErasureMarker(false),
            app_data_erasure_state: "completed",
            auth_deletion_state: "unknown",
            audit_reconciliation_required: true,
          }),
        }),
      }),
    );
  });

  it("records a definite Auth failure only after reconciliation proves the user remains", async () => {
    state.authDeleteError = "internal Auth storage detail";
    state.authLookup = "present";

    const response = await POST(
      new Request("https://awardping.com/api/privacy/delete", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://awardping.com",
        },
        body: '{"confirm":"DELETE"}',
      }),
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: "Application data was erased, but the account could not be deleted.",
    });
    expect(state.effects).toContainEqual(
      expect.objectContaining({
        type: "update",
        table: "privacy_requests",
        payload: expect.objectContaining({
          details: expect.objectContaining({
            failure_code: "auth_deletion_failed_user_present",
            auth_deletion_state: "present",
            audit_reconciliation_required: false,
          }),
        }),
      }),
    );
  });
});
