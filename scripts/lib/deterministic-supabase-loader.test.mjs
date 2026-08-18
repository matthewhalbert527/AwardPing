import { describe, expect, it } from "vitest";
import { loadDeterministicSupabaseRows } from "./deterministic-supabase-loader.mjs";

describe("deterministic Supabase loader", () => {
  it("loads two exact id-keyset passes and proves the full projection", async () => {
    const supabase = sequencedSupabase([
      result(3, [row("c", "2026-07-17T03:00:00.000Z")]),
      result(3, [row("a", "2026-07-17T01:00:00.000Z"), row("b", "2026-07-17T02:00:00.000Z")]),
      result(1, [row("c", "2026-07-17T03:00:00.000Z")]),
      result(3, [row("a", "2026-07-17T01:00:00.000Z"), row("b", "2026-07-17T02:00:00.000Z")]),
      result(1, [row("c", "2026-07-17T03:00:00.000Z")]),
      result(3, [row("c", "2026-07-17T03:00:00.000Z")]),
    ]);

    await expect(loadDeterministicSupabaseRows({
      supabase,
      table: "example_rows",
      select: "id,name,updated_at",
      pageSize: 2,
    })).resolves.toEqual([
      row("a", "2026-07-17T01:00:00.000Z"),
      row("b", "2026-07-17T02:00:00.000Z"),
      row("c", "2026-07-17T03:00:00.000Z"),
    ]);

    expect(supabase.calls[2].operations).toContainEqual(["gt", "id", "b"]);
    expect(supabase.remaining()).toBe(0);
  });

  it("fails closed when the exact remaining count drifts", async () => {
    const supabase = sequencedSupabase([
      result(3, [row("c", "2026-07-17T03:00:00.000Z")]),
      result(4, [row("a", "2026-07-17T01:00:00.000Z"), row("b", "2026-07-17T02:00:00.000Z")]),
    ]);

    await expect(load(supabase)).rejects.toThrow("row count changed during pagination");
  });

  it("fails closed when the revision changes after pagination", async () => {
    const supabase = sequencedSupabase([
      result(1, [row("a", "2026-07-17T01:00:00.000Z")]),
      result(1, [row("a", "2026-07-17T01:00:00.000Z")]),
      result(1, [row("a", "2026-07-17T01:00:00.000Z")]),
      result(1, [row("a", "2026-07-17T02:00:00.000Z")]),
    ]);

    await expect(load(supabase)).rejects.toThrow("row count or revision changed");
  });

  it("rejects non-increasing or duplicate ids instead of returning partial rows", async () => {
    const supabase = sequencedSupabase([
      result(2, [row("b", "2026-07-17T02:00:00.000Z")]),
      result(2, [row("b", "2026-07-17T02:00:00.000Z"), row("a", "2026-07-17T01:00:00.000Z")]),
    ]);

    await expect(load(supabase)).rejects.toThrow("non-increasing id order");
  });

  it("fails closed when a non-max row mutates but count and max revision stay fixed", async () => {
    const original = [
      row("a", "2026-07-17T01:00:00.000Z"),
      row("b", "2026-07-17T02:00:00.000Z"),
      row("c", "2026-07-17T03:00:00.000Z"),
    ];
    const mutated = original.map((value) =>
      value.id === "b" ? { ...value, name: "MUTATED" } : value,
    );
    const supabase = sequencedSupabase([
      result(3, [row("c", "2026-07-17T03:00:00.000Z")]),
      result(3, original),
      result(3, mutated),
      result(3, [row("c", "2026-07-17T03:00:00.000Z")]),
    ]);

    await expect(loadDeterministicSupabaseRows({
      supabase,
      table: "example_rows",
      select: "id,name,updated_at",
      pageSize: 3,
    })).rejects.toThrow("full row projection changed between deterministic passes");
    expect(supabase.remaining()).toBe(0);
  });

  it("canonicalizes object keys and reapplies filters to every query", async () => {
    const first = {
      id: "a",
      name: "A",
      metadata: { beta: 2, alpha: 1 },
      updated_at: "2026-07-17T01:00:00.000Z",
    };
    const second = {
      updated_at: "2026-07-17T01:00:00.000Z",
      metadata: { alpha: 1, beta: 2 },
      name: "A",
      id: "a",
    };
    const supabase = sequencedSupabase([
      result(1, [row("a", "2026-07-17T01:00:00.000Z")]),
      result(1, [first]),
      result(1, [second]),
      result(1, [row("a", "2026-07-17T01:00:00.000Z")]),
    ]);

    await expect(loadDeterministicSupabaseRows({
      supabase,
      table: "example_rows",
      select: "id,name,metadata,updated_at",
      filterQuery: (query) => query.not("name", "is", null),
    })).resolves.toEqual([first]);
    expect(supabase.calls).toHaveLength(4);
    for (const call of supabase.calls) {
      expect(call.operations).toContainEqual(["not", "name", "is", null]);
    }
  });

  it("propagates query errors and requires the revision fields in the projection", async () => {
    const failed = sequencedSupabase([{ data: null, count: null, error: { code: "42501", message: "denied" } }]);
    await expect(load(failed)).rejects.toThrow("denied");
    await expect(loadDeterministicSupabaseRows({
      supabase: sequencedSupabase([]),
      table: "example_rows",
      select: "id,name",
    })).rejects.toThrow("must include id and updated_at");
  });
});

function load(supabase) {
  return loadDeterministicSupabaseRows({
    supabase,
    table: "example_rows",
    select: "id,name,updated_at",
    pageSize: 2,
  });
}

function row(id, updatedAt) {
  return { id, name: id.toUpperCase(), updated_at: updatedAt };
}

function result(count, data) {
  return { data, count, error: null };
}

function sequencedSupabase(responses) {
  const queue = [...responses];
  const calls = [];
  return {
    calls,
    remaining: () => queue.length,
    from(table) {
      const call = { table, operations: [] };
      calls.push(call);
      const builder = {
        select(...args) { call.operations.push(["select", ...args]); return builder; },
        order(...args) { call.operations.push(["order", ...args]); return builder; },
        limit(...args) { call.operations.push(["limit", ...args]); return builder; },
        gt(...args) { call.operations.push(["gt", ...args]); return builder; },
        not(...args) { call.operations.push(["not", ...args]); return builder; },
        then(resolve, reject) {
          if (!queue.length) return Promise.reject(new Error("Unexpected Supabase query")).then(resolve, reject);
          return Promise.resolve(queue.shift()).then(resolve, reject);
        },
      };
      return builder;
    },
  };
}
