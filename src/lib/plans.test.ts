import { describe, expect, it } from "vitest";
import { canUseCadence, nextCheckDate, planLimits } from "@/lib/plans";

describe("plans", () => {
  it("keeps scheduled checks free", () => {
    expect(canUseCadence("free", "daily")).toBe(true);
    expect(canUseCadence("free", "hourly")).toBe(false);
    expect(canUseCadence("pro", "hourly")).toBe(false);
    expect(planLimits.free.monitors).toBe(Number.MAX_SAFE_INTEGER);
    expect(planLimits.pro.monitors).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("computes future check dates", () => {
    const from = new Date("2026-01-01T00:00:00.000Z");
    expect(nextCheckDate("hourly", from)).toBe("2026-01-01T01:00:00.000Z");
    expect(nextCheckDate("daily", from)).toBe("2026-01-02T00:00:00.000Z");
  });
});
