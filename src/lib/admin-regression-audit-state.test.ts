import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { loadAdminRegressionAuditFailures } from "@/lib/admin-regression-audit-state";

describe("admin regression audit retry-state loader", () => {
  it("loads more than one exact page and chunks corresponding award identities", async () => {
    const rows = [stateRow(1), stateRow(2), stateRow(3)];
    const initialRevision = chainResult(exactResult(
      [{ shared_award_id: rows[2].shared_award_id, updated_at: rows[2].updated_at }],
      3,
    ));
    const firstPage = chainResult(exactResult(rows.slice(0, 2), 3));
    const secondPage = chainResult(exactResult(rows.slice(2), 3));
    const finalRevision = chainResult(exactResult(
      [{ shared_award_id: rows[2].shared_award_id, updated_at: rows[2].updated_at }],
      3,
    ));
    const firstAwards = chainResult(exactResult(rows.slice(0, 2).map(awardRow), 2));
    const secondAwards = chainResult(exactResult(rows.slice(2).map(awardRow), 1));
    const admin = sequencedAdmin({
      state: [initialRevision, firstPage, secondPage, finalRevision],
      awards: [firstAwards, secondAwards],
    });

    const result = await loadAdminRegressionAuditFailures(admin.client, {
      statePageSize: 2,
      awardChunkSize: 2,
    });

    expect(result.loadErrors).toEqual([]);
    expect(result.failures).toHaveLength(3);
    expect(result.failures[0]).toEqual(expect.objectContaining({
      failureKind: "operational",
      awardId: rows[0].shared_award_id,
      awardName: "Award 1",
      operationalError: rows[0].last_operational_error,
      lastAuditId: rows[0].last_audit_id,
      lastObservationKey: rows[0].last_observation_key,
    }));
    expect(firstPage.order).toHaveBeenNthCalledWith(
      1,
      "last_attempted_at",
      { ascending: true, nullsFirst: true },
    );
    expect(firstPage.order).toHaveBeenNthCalledWith(
      2,
      "shared_award_id",
      { ascending: true },
    );
    expect(firstPage.range).toHaveBeenCalledWith(0, 1);
    expect(secondPage.range).toHaveBeenCalledWith(2, 2);
    expect(firstAwards.in).toHaveBeenCalledWith(
      "id",
      rows.slice(0, 2).map((row) => row.shared_award_id),
    );
    expect(secondAwards.in).toHaveBeenCalledWith(
      "id",
      [rows[2].shared_award_id],
    );
    expect(initialRevision.or).toHaveBeenCalledWith(
      "last_operational_error.not.is.null,last_audit_error.not.is.null",
    );
    expect(firstPage.or).toHaveBeenCalledWith(
      "last_operational_error.not.is.null,last_audit_error.not.is.null",
    );
  });

  it("loads a durable blocking audit outcome even when no operational retry failure exists", async () => {
    const row = stateRow(1, {
      consecutive_failures: 0,
      last_operational_error: null,
      last_audit_error: "regression_page_audit_blocked:failed:error:deadline_conflict",
    });
    const revision = [{ shared_award_id: row.shared_award_id, updated_at: row.updated_at }];
    const admin = sequencedAdmin({
      state: [
        chainResult(exactResult(revision, 1)),
        chainResult(exactResult([row], 1)),
        chainResult(exactResult(revision, 1)),
      ],
      awards: [chainResult(exactResult([awardRow(row)], 1))],
    });

    const result = await loadAdminRegressionAuditFailures(admin.client);

    expect(result.loadErrors).toEqual([]);
    expect(result.failures).toEqual([
      expect.objectContaining({
        failureKind: "blocking_audit",
        consecutiveFailures: 0,
        operationalError: null,
        lastAuditError: "regression_page_audit_blocked:failed:error:deadline_conflict",
      }),
    ]);
  });

  it("preserves both the retained blocking outcome and a later operational failure", async () => {
    const row = stateRow(1, {
      last_audit_error: "regression_page_audit_blocked:failed:critical:sibling_source",
    });
    const revision = [{ shared_award_id: row.shared_award_id, updated_at: row.updated_at }];
    const admin = sequencedAdmin({
      state: [
        chainResult(exactResult(revision, 1)),
        chainResult(exactResult([row], 1)),
        chainResult(exactResult(revision, 1)),
      ],
      awards: [chainResult(exactResult([awardRow(row)], 1))],
    });

    const result = await loadAdminRegressionAuditFailures(admin.client);

    expect(result.loadErrors).toEqual([]);
    expect(result.failures[0]).toEqual(expect.objectContaining({
      failureKind: "operational_and_blocking",
      operationalError: "Audit 1 failed",
      lastAuditError: "regression_page_audit_blocked:failed:critical:sibling_source",
    }));
  });

  it("fails closed when the service-only retry registry cannot be read", async () => {
    const admin = sequencedAdmin({
      state: [chainResult({ data: null, error: { message: "relation is unavailable" }, count: null })],
      awards: [],
    });

    const result = await loadAdminRegressionAuditFailures(admin.client);

    expect(result.failures).toEqual([]);
    expect(result.loadErrors).toEqual([
      "Regression audit retry state: relation is unavailable",
    ]);
    expect(admin.from).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the exact count drifts between state pages", async () => {
    const rows = [stateRow(1), stateRow(2), stateRow(3)];
    const admin = sequencedAdmin({
      state: [
        chainResult(exactResult(
          [{ shared_award_id: rows[2].shared_award_id, updated_at: rows[2].updated_at }],
          3,
        )),
        chainResult(exactResult(rows.slice(0, 2), 3)),
        chainResult(exactResult(rows.slice(2), 4)),
      ],
      awards: [],
    });

    const result = await loadAdminRegressionAuditFailures(admin.client, {
      statePageSize: 2,
    });

    expect(result.failures).toEqual([]);
    expect(result.loadErrors).toEqual([
      "Regression audit retry state: Regression audit retry rows changed during paginated loading.",
    ]);
  });

  it("fails closed when the state revision changes without a count change", async () => {
    const row = stateRow(1);
    const admin = sequencedAdmin({
      state: [
        chainResult(exactResult(
          [{ shared_award_id: row.shared_award_id, updated_at: row.updated_at }],
          1,
        )),
        chainResult(exactResult([row], 1)),
        chainResult(exactResult(
          [{ shared_award_id: row.shared_award_id, updated_at: "2026-07-17T18:30:00.000Z" }],
          1,
        )),
      ],
      awards: [],
    });

    const result = await loadAdminRegressionAuditFailures(admin.client);

    expect(result.failures).toEqual([]);
    expect(result.loadErrors[0]).toContain("changed during paginated loading");
  });

  it("rejects duplicate state rows even when the exact count and revision stay stable", async () => {
    const row = stateRow(1);
    const revision = [{ shared_award_id: row.shared_award_id, updated_at: row.updated_at }];
    const admin = sequencedAdmin({
      state: [
        chainResult(exactResult(revision, 2)),
        chainResult(exactResult([row, row], 2)),
        chainResult(exactResult(revision, 2)),
      ],
      awards: [],
    });

    const result = await loadAdminRegressionAuditFailures(admin.client);

    expect(result.failures).toEqual([]);
    expect(result.loadErrors).toEqual([
      "Regression audit retry state: Regression audit pagination did not return every unresolved award exactly once.",
    ]);
  });

  it("fails closed when a chunk of award identities cannot be read", async () => {
    const row = stateRow(1);
    const revision = [{ shared_award_id: row.shared_award_id, updated_at: row.updated_at }];
    const admin = sequencedAdmin({
      state: [
        chainResult(exactResult(revision, 1)),
        chainResult(exactResult([row], 1)),
        chainResult(exactResult(revision, 1)),
      ],
      awards: [chainResult({ data: null, error: { message: "award identity query failed" }, count: null })],
    });

    const result = await loadAdminRegressionAuditFailures(admin.client);

    expect(result.failures).toEqual([]);
    expect(result.loadErrors).toEqual([
      "Regression audit award identities: award identity query failed",
    ]);
  });

  it("reports a missing award identity instead of publishing partial inbox data", async () => {
    const row = stateRow(1);
    const revision = [{ shared_award_id: row.shared_award_id, updated_at: row.updated_at }];
    const admin = sequencedAdmin({
      state: [
        chainResult(exactResult(revision, 1)),
        chainResult(exactResult([row], 1)),
        chainResult(exactResult(revision, 1)),
      ],
      awards: [chainResult(exactResult([], 0))],
    });

    const result = await loadAdminRegressionAuditFailures(admin.client);

    expect(result.failures).toEqual([]);
    expect(result.loadErrors).toEqual([
      "Regression audit award identities: One or more corresponding award identities could not be loaded.",
    ]);
  });
});

function stateRow(
  index: number,
  overrides: Partial<{
    consecutive_failures: number;
    last_operational_error: string | null;
    last_audit_error: string | null;
  }> = {},
) {
  const suffix = String(index).padStart(12, "0");
  return {
    shared_award_id: `00000000-0000-4000-8000-${suffix}`,
    last_attempted_at: `2026-07-17T17:0${index}:00.000Z`,
    last_succeeded_at: "2026-07-16T17:00:00.000Z",
    consecutive_failures: index,
    next_retry_at: `2026-07-17T18:0${index}:00.000Z`,
    last_operational_error: `Audit ${index} failed`,
    last_audit_error: null,
    last_audit_id: `10000000-0000-4000-8000-${suffix}`,
    last_observation_key: `observation-${index}`,
    created_at: "2026-07-15T17:00:00.000Z",
    updated_at: `2026-07-17T17:0${index}:00.000Z`,
    ...overrides,
  };
}

function awardRow(row: ReturnType<typeof stateRow>) {
  const index = Number(row.shared_award_id.slice(-1));
  return {
    id: row.shared_award_id,
    name: `Award ${index}`,
    slug: `award-${index}`,
    official_homepage: `https://example.com/award-${index}`,
  };
}

function exactResult(data: unknown[], count: number) {
  return { data, error: null, count };
}

function sequencedAdmin({
  state,
  awards,
}: {
  state: ReturnType<typeof chainResult>[];
  awards: ReturnType<typeof chainResult>[];
}) {
  const stateQueries = [...state];
  const awardQueries = [...awards];
  const from = vi.fn((table: string) => {
    const query = table === "shared_award_regression_audit_state"
      ? stateQueries.shift()
      : awardQueries.shift();
    if (!query) throw new Error(`Unexpected ${table} query.`);
    return query;
  });
  return {
    from,
    client: { from } as unknown as Parameters<typeof loadAdminRegressionAuditFailures>[0],
  };
}

function chainResult(result: { data: unknown; error: unknown; count: number | null }) {
  const builder = {
    select: vi.fn(),
    or: vi.fn(),
    order: vi.fn(),
    range: vi.fn(),
    in: vi.fn(),
    then: (
      resolve: (value: { data: unknown; error: unknown; count: number | null }) => unknown,
      reject?: (reason: unknown) => unknown,
    ) => Promise.resolve(result).then(resolve, reject),
  };
  builder.select.mockReturnValue(builder);
  builder.or.mockReturnValue(builder);
  builder.order.mockReturnValue(builder);
  builder.range.mockReturnValue(builder);
  builder.in.mockReturnValue(builder);
  return builder;
}
