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
    expect(normalizeHttpUrl("http://[::ffff:127.0.0.1]").ok).toBe(false);
    expect(isPrivateIp("10.1.2.3")).toBe(true);
    expect(isPrivateIp("172.20.1.1")).toBe(true);
    expect(isPrivateIp("8.8.8.8")).toBe(false);
  });

  it("rejects link-local and reserved address ranges", () => {
    expect(isPrivateIp("100.64.0.1")).toBe(true);
    expect(isPrivateIp("169.254.169.254")).toBe(true);
    expect(isPrivateIp("192.0.2.10")).toBe(true);
    expect(isPrivateIp("198.51.100.10")).toBe(true);
    expect(isPrivateIp("203.0.113.10")).toBe(true);
    expect(isPrivateIp("192.88.99.10")).toBe(true);
    expect(isPrivateIp("192.88.98.10")).toBe(false);
    expect(isPrivateIp("198.51.99.10")).toBe(false);
    expect(isPrivateIp("203.0.114.10")).toBe(false);
    expect(isPrivateIp("224.0.0.1")).toBe(true);
    expect(isPrivateIp("::")).toBe(true);
    expect(isPrivateIp("::ffff:127.0.0.1")).toBe(true);
    expect(isPrivateIp("2001:db8::1")).toBe(true);
    expect(isPrivateIp("ff02::1")).toBe(true);
  });

  it("rejects non-global and transition IPv6 ranges without blocking public NAT64", () => {
    expect(isPrivateIp("2001::1")).toBe(true); // Teredo 2001::/32
    expect(isPrivateIp("2001:2::1")).toBe(true); // benchmarking 2001:2::/48
    expect(isPrivateIp("2002::1")).toBe(true); // 6to4 2002::/16
    expect(isPrivateIp("3fff::1")).toBe(true); // documentation 3fff::/20
    expect(isPrivateIp("3fff:fff::1")).toBe(true);

    expect(isPrivateIp("2001:3::1")).toBe(false);
    expect(isPrivateIp("2003::1")).toBe(false);
    expect(isPrivateIp("3fff:1000::1")).toBe(false);
    expect(isPrivateIp("64:ff9b::808:808")).toBe(false); // public 8.8.8.8
    expect(isPrivateIp("64:ff9b::c0a8:101")).toBe(true); // private 192.168.1.1
  });

  it("applies special IPv6 range checks to normalized URL literals", () => {
    expect(normalizeHttpUrl("https://[2001:0000::1]/").ok).toBe(false);
    expect(normalizeHttpUrl("https://[2001:0002:0000::1]/").ok).toBe(false);
    expect(normalizeHttpUrl("https://[2002::1]/").ok).toBe(false);
    expect(normalizeHttpUrl("https://[3fff:0fff::1]/").ok).toBe(false);
    expect(normalizeHttpUrl("https://[64:ff9b::808:808]/").ok).toBe(true);
    expect(normalizeHttpUrl("https://[64:ff9b::192.168.1.1]/").ok).toBe(false);
  });
});
