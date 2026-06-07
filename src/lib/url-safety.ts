import dns from "node:dns/promises";
import net from "node:net";

const blockedHosts = new Set(["localhost", "0.0.0.0", "::1"]);

export type SafeUrlResult =
  | { ok: true; url: URL }
  | { ok: false; reason: string };

export function normalizeHttpUrl(input: string): SafeUrlResult {
  let url: URL;

  try {
    url = new URL(input.trim());
  } catch {
    return { ok: false, reason: "Enter a valid URL." };
  }

  if (!["http:", "https:"].includes(url.protocol)) {
    return { ok: false, reason: "Only http and https URLs can be monitored." };
  }

  if (!url.hostname || blockedHosts.has(url.hostname.toLowerCase())) {
    return { ok: false, reason: "This host cannot be monitored." };
  }

  if (isPrivateIp(url.hostname)) {
    return { ok: false, reason: "Private network URLs cannot be monitored." };
  }

  return { ok: true, url };
}

export async function assertPublicHttpUrl(input: string) {
  const normalized = normalizeHttpUrl(input);
  if (!normalized.ok) {
    throw new Error(normalized.reason);
  }

  const addresses = await dns.lookup(normalized.url.hostname, {
    all: true,
    verbatim: true,
  });

  if (addresses.some((address) => isPrivateIp(address.address))) {
    throw new Error("This URL resolves to a private network address.");
  }

  return normalized.url;
}

export function isPrivateIp(value: string) {
  const version = net.isIP(value);
  if (!version) {
    return false;
  }

  if (version === 4) {
    const parts = value.split(".").map(Number);
    const [a, b] = parts;
    return (
      a === 10 ||
      a === 127 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      a === 0
    );
  }

  const lower = value.toLowerCase();
  return (
    lower === "::1" ||
    lower.startsWith("fc") ||
    lower.startsWith("fd") ||
    lower.startsWith("fe80:")
  );
}
