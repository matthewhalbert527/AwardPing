import { describe, expect, it } from "vitest";
import {
  hashFreeCheckValue,
  resolveFreeCheckClientIp,
  resolveFreeCheckHourlyLimit,
} from "./free-check-rate-limit";

describe("free check rate-limit helpers", () => {
  it("uses a bounded ten-per-hour default", () => {
    expect(resolveFreeCheckHourlyLimit(undefined)).toBe(10);
    expect(resolveFreeCheckHourlyLimit("")).toBe(10);
    expect(resolveFreeCheckHourlyLimit("7")).toBe(7);
    expect(resolveFreeCheckHourlyLimit("999")).toBe(10);
  });

  it("fails safely when an explicit limit is invalid", () => {
    expect(resolveFreeCheckHourlyLimit("0")).toBe(1);
    expect(resolveFreeCheckHourlyLimit("-1")).toBe(1);
    expect(resolveFreeCheckHourlyLimit("not-a-number")).toBe(1);
    expect(resolveFreeCheckHourlyLimit("9007199254740992")).toBe(1);
  });

  it("uses only a canonical deployment-controlled client IP", () => {
    const headers = new Headers({
      "x-vercel-forwarded-for": "203.0.113.8, 10.0.0.1",
      "x-forwarded-for": "198.51.100.2",
    });
    expect(resolveFreeCheckClientIp(headers, true)).toBe("203.0.113.8");
    expect(
      resolveFreeCheckClientIp(
        new Headers({ "x-vercel-forwarded-for": "2001:0db8:0:0:0:0:0:1" }),
        true,
      ),
    ).toBe("2001:db8::1");
    expect(resolveFreeCheckClientIp(new Headers(), true)).toBe("unknown");
  });

  it("fails closed outside Vercel instead of trusting spoofable fallbacks", () => {
    const headers = new Headers({
      "x-vercel-forwarded-for": "203.0.113.8",
      "cf-connecting-ip": "198.51.100.1",
      "x-forwarded-for": "198.51.100.2",
      "x-real-ip": "198.51.100.3",
    });
    expect(resolveFreeCheckClientIp(headers, false)).toBe("unknown");
    expect(
      resolveFreeCheckClientIp(
        new Headers({ "x-vercel-forwarded-for": "not-an-ip" }),
        true,
      ),
    ).toBe("unknown");
  });

  it("creates stable non-plaintext audit keys", () => {
    expect(hashFreeCheckValue("203.0.113.8")).toMatch(/^[0-9a-f]{64}$/);
    expect(hashFreeCheckValue("203.0.113.8")).toBe(
      hashFreeCheckValue("203.0.113.8"),
    );
    expect(hashFreeCheckValue("203.0.113.8")).not.toContain("203.0.113.8");
  });
});
