import { describe, expect, it } from "vitest";
import {
  AWARDPING_TIME_ZONE,
  centralDateKey,
  formatCentralDate,
  formatCentralDateTime,
} from "@/lib/time-zone";

describe("Central Time formatting", () => {
  it("uses the AwardPing Central timezone explicitly", () => {
    expect(AWARDPING_TIME_ZONE).toBe("America/Chicago");
  });

  it("formats summer timestamps in Central daylight time", () => {
    expect(
      formatCentralDateTime("2026-07-08T15:30:00.000Z", {
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
      }),
    ).toBe("Jul 8, 2026, 10:30 AM");
  });

  it("formats winter timestamps in Central standard time", () => {
    expect(
      formatCentralDateTime("2026-01-08T15:30:00.000Z", {
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
      }),
    ).toBe("Jan 8, 2026, 9:30 AM");
  });

  it("uses the Central calendar day for date-only output", () => {
    expect(formatCentralDate("2026-07-08T04:30:00.000Z")).toBe("Jul 7, 2026");
    expect(centralDateKey("2026-07-08T04:30:00.000Z")).toBe("2026-07-07");
  });
});
