import { describe, expect, it } from "vitest";
import { safeNextPath } from "@/lib/safe-next-path";

describe("safeNextPath", () => {
  it("preserves an ordinary local path, query, and fragment", () => {
    expect(safeNextPath("/join/A1B2C3?from=email#accept")).toBe(
      "/join/A1B2C3?from=email#accept",
    );
  });

  it.each([
    "https://attacker.example/phish",
    "//attacker.example/phish",
    "/\\attacker.example/phish",
    "/%5cattacker.example/phish",
    "/%2f%2fattacker.example/phish",
    "/%2e%2e//attacker.example/phish",
    "/.%2e//attacker.example/phish",
    "/safe%0aunsafe",
    "/safe%250aunsafe",
    "/safe\nunsafe",
  ])("rejects an unsafe redirect target: %s", (value) => {
    expect(safeNextPath(value)).toBe("");
  });
});
