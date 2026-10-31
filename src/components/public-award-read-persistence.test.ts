import { describe, expect, it, vi } from "vitest";
import { postReadChangeIds } from "./public-award-workspace";
const ids = Array.from({ length: 72 }, (_, n) => `event-${n}`);

describe("expanded alert group read receipts", () => {
  it("persists every original ID in bounded batches instead of silently truncating after 50", async () => {
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const batch = JSON.parse(String(init?.body)).changeIds;
      return new Response(JSON.stringify({ ok: true, read: batch.length }), { status: 200 });
    });
    const result = await postReadChangeIds([...ids, ids[0]], fetcher as typeof fetch);
    expect(fetcher.mock.calls.map(call => JSON.parse(String(call[1]?.body)).changeIds.length)).toEqual([50, 22]);
    expect(result).toEqual({ confirmedIds: ids, complete: true });
    expect(fetcher.mock.calls.every(call => call[1]?.credentials === "same-origin")).toBe(true);
  });
  it("retains unconfirmed updates as unread when one batch fails, without retrying it", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, read: 50 })))
      .mockRejectedValueOnce(new Error("Unavailable"));
    expect(await postReadChangeIds(ids, fetcher)).toEqual({ confirmedIds: ids.slice(0, 50), complete: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("does not claim confirmation from an unauthorized, incomplete or malformed result", async () => {
    for (const response of [new Response("{}", { status: 401 }), new Response(JSON.stringify({ ok: true, read: 1 })), new Response("not JSON")]) {
      const fetcher = vi.fn().mockResolvedValue(response);
      expect(await postReadChangeIds(ids.slice(0, 2), fetcher)).toEqual({ confirmedIds: [], complete: false });
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });
  it("makes no request for an empty selection", async () => {
    const fetcher = vi.fn();
    expect(await postReadChangeIds([], fetcher)).toEqual({ confirmedIds: [], complete: true });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
