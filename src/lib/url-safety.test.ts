import { describe, expect, it } from "vitest";
import { isPrivateIp, normalizeHttpUrl } from "@/lib/url-safety";

describe("url safety", () => {
  it("accepts public http URLs", () => {
    const result = normalizeHttpUrl("https://example.com/page");
    expect(result.ok).toBe(true);
  });

  it("rejects unsupported protocols", () => {
    const result = normalizeHttpUrl("file:///etc/passwd");
    expect(result.ok).toBe(false);
  });

  it("rejects local hosts and private IPs", () => {
    expect(normalizeHttpUrl("http://localhost:3000").ok).toBe(false);
    expect(normalizeHttpUrl("http://192.168.1.1").ok).toBe(false);
    expect(isPrivateIp("10.1.2.3")).toBe(true);
    expect(isPrivateIp("172.20.1.1")).toBe(true);
    expect(isPrivateIp("8.8.8.8")).toBe(false);
  });
});
