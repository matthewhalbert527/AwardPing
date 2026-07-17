import dns from "node:dns/promises";
import net, { type LookupFunction } from "node:net";
import { Agent, fetch as undiciFetch } from "undici";

const unsafeHostPattern =
  /(?:^|\.)localhost$|(?:^|\.)local$|(?:^|\.)internal$|(?:^|\.)invalid$|(?:^|\.)test$|(?:^|\.)example$/i;
const redirectStatuses = new Set([301, 302, 303, 307, 308]);

type PublicAddress = {
  address: string;
  family: 4 | 6;
};

export type PublicHttpResponse = {
  response: Awaited<ReturnType<typeof undiciFetch>>;
  url: URL;
  close: () => Promise<void>;
};

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

  const hostname = normalizedHostname(url.hostname);
  if (!hostname || unsafeHostPattern.test(hostname)) {
    return { ok: false, reason: "This host cannot be monitored." };
  }

  if (isPrivateIp(hostname)) {
    return { ok: false, reason: "Private network URLs cannot be monitored." };
  }

  return { ok: true, url };
}

export async function assertPublicHttpUrl(input: string) {
  const normalized = normalizeHttpUrl(input);
  if (!normalized.ok) {
    throw new Error(normalized.reason);
  }

  await resolvePublicAddresses(normalized.url);
  return normalized.url;
}

export async function fetchPublicHttpResponse(
  input: string | URL,
  init: RequestInit = {},
  maxRedirects = 5,
): Promise<PublicHttpResponse> {
  let currentUrl = input.toString();

  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
    const normalized = normalizeHttpUrl(currentUrl);
    if (!normalized.ok) {
      throw new Error(normalized.reason);
    }

    const addresses = await resolvePublicAddresses(normalized.url);
    const dispatcher = createPinnedDispatcher(normalized.url, addresses);
    let response: Awaited<ReturnType<typeof undiciFetch>>;

    try {
      response = await undiciFetch(normalized.url, {
        ...init,
        redirect: "manual",
        dispatcher,
      } as Parameters<typeof undiciFetch>[1]);
    } catch (error) {
      await dispatcher.close().catch(() => undefined);
      throw error;
    }

    if (
      response.redirected ||
      (response.url && !sameRequestUrl(response.url, normalized.url))
    ) {
      await response.body?.cancel().catch(() => undefined);
      await dispatcher.close().catch(() => undefined);
      throw new Error("Fetch followed an unvalidated redirect.");
    }

    const location = response.headers.get("location");
    if (redirectStatuses.has(response.status) && location) {
      await response.body?.cancel().catch(() => undefined);
      await dispatcher.close().catch(() => undefined);
      if (redirectCount >= maxRedirects) {
        throw new Error(`Fetch exceeded ${maxRedirects} redirects.`);
      }
      currentUrl = new URL(location, normalized.url).toString();
      continue;
    }

    let closed = false;
    return {
      response,
      url: normalized.url,
      close: async () => {
        if (closed) return;
        closed = true;
        await dispatcher.close();
      },
    };
  }

  throw new Error("Redirect processing did not terminate.");
}

export function isPrivateIp(value: string) {
  const address = normalizedHostname(value).split("%")[0];
  const version = net.isIP(address);
  if (!version) {
    return false;
  }

  if (version === 4) {
    const [a, b, c] = address.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0 && (c === 0 || c === 2)) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 88 && c === 99) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113) ||
      a >= 224
    );
  }

  const words = parseIpv6Words(address);
  if (!words) return true;

  // The well-known NAT64 prefix is globally reachable, but its final 32 bits
  // still need the IPv4 policy so a synthesized private address cannot bypass it.
  if (
    words[0] === 0x0064 &&
    words[1] === 0xff9b &&
    words.slice(2, 6).every((word) => word === 0)
  ) {
    return isPrivateIp(ipv4FromIpv6Words(words));
  }

  const isUnspecified = words.every((word) => word === 0);
  const isLoopback = words.slice(0, 7).every((word) => word === 0) && words[7] === 1;
  const isIpv4Mapped =
    words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff;
  const isUniqueLocal = (words[0] & 0xfe00) === 0xfc00;
  const isLinkLocal = (words[0] & 0xffc0) === 0xfe80;
  const isMulticast = (words[0] & 0xff00) === 0xff00;
  const isTeredo = words[0] === 0x2001 && words[1] === 0;
  const isBenchmark =
    words[0] === 0x2001 && words[1] === 0x0002 && words[2] === 0;
  const isDocumentation2001 = words[0] === 0x2001 && words[1] === 0x0db8;
  const isSixToFour = words[0] === 0x2002;
  const isDocumentation3fff =
    words[0] === 0x3fff && (words[1] & 0xf000) === 0;
  const isGlobalUnicast = (words[0] & 0xe000) === 0x2000;

  return (
    isUnspecified ||
    isLoopback ||
    isIpv4Mapped ||
    isUniqueLocal ||
    isLinkLocal ||
    isMulticast ||
    isTeredo ||
    isBenchmark ||
    isDocumentation2001 ||
    isSixToFour ||
    isDocumentation3fff ||
    !isGlobalUnicast
  );
}

function parseIpv6Words(address: string): number[] | null {
  const halves = address.split("::");
  if (halves.length > 2) return null;

  const left = parseIpv6Side(halves[0]);
  const right = halves.length === 2 ? parseIpv6Side(halves[1]) : [];
  if (!left || !right) return null;

  const missing = 8 - left.length - right.length;
  if (
    (halves.length === 1 && missing !== 0) ||
    (halves.length === 2 && missing < 1)
  ) {
    return null;
  }

  return [...left, ...Array.from({ length: missing }, () => 0), ...right];
}

function parseIpv6Side(side: string): number[] | null {
  if (!side) return [];

  const words: number[] = [];
  for (const segment of side.split(":")) {
    if (segment.includes(".")) {
      const bytes = segment.split(".").map(Number);
      if (
        bytes.length !== 4 ||
        bytes.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)
      ) {
        return null;
      }
      words.push((bytes[0] << 8) | bytes[1], (bytes[2] << 8) | bytes[3]);
      continue;
    }

    const word = Number.parseInt(segment, 16);
    if (!Number.isInteger(word) || word < 0 || word > 0xffff) return null;
    words.push(word);
  }
  return words;
}

function ipv4FromIpv6Words(words: number[]) {
  return [words[6] >> 8, words[6] & 0xff, words[7] >> 8, words[7] & 0xff].join(
    ".",
  );
}

async function resolvePublicAddresses(url: URL): Promise<PublicAddress[]> {
  const hostname = normalizedHostname(url.hostname);
  const literalFamily = net.isIP(hostname);
  const resolved = literalFamily
    ? [{ address: hostname, family: literalFamily }]
    : await dns.lookup(hostname, { all: true, verbatim: true });
  const addresses = resolved
    .map((entry) => ({
      address: String(entry.address || "").trim(),
      family: Number(entry.family),
    }))
    .filter(
      (entry): entry is PublicAddress =>
        Boolean(entry.address) && (entry.family === 4 || entry.family === 6),
    );

  if (!addresses.length) {
    throw new Error("This URL did not resolve to a usable public address.");
  }
  if (addresses.some((entry) => isPrivateIp(entry.address))) {
    throw new Error("This URL resolves to a private network or reserved address.");
  }
  return addresses;
}

function createPinnedDispatcher(url: URL, addresses: PublicAddress[]) {
  const expectedHostname = normalizedHostname(url.hostname);
  let cursor = 0;
  const lookup: LookupFunction = (hostname, options, callback) => {
    if (normalizedHostname(hostname) !== expectedHostname) {
      callback(new Error("Fetch dispatcher rejected a hostname change."), "", 0);
      return;
    }

    const family = Number(options?.family) || 0;
    const eligible =
      family === 4 || family === 6
        ? addresses.filter((entry) => entry.family === family)
        : addresses;
    if (!eligible.length) {
      callback(new Error("Fetch dispatcher has no pinned address for this family."), "", 0);
      return;
    }

    if (options?.all) {
      callback(
        null,
        eligible.map((entry) => ({ ...entry })),
      );
      return;
    }

    const selected = eligible[cursor % eligible.length];
    cursor += 1;
    callback(null, selected.address, selected.family);
  };

  return new Agent({ connect: { lookup } });
}

function normalizedHostname(value: string) {
  return value.replace(/^\[|\]$/g, "").toLowerCase();
}

function sameRequestUrl(responseUrl: string, requestedUrl: URL) {
  try {
    const response = new URL(responseUrl);
    const requested = new URL(requestedUrl);
    response.hash = "";
    requested.hash = "";
    return response.toString() === requested.toString();
  } catch {
    return false;
  }
}
