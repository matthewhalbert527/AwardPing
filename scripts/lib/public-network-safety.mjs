import dns from "node:dns/promises";
import http from "node:http";
import net from "node:net";
import { Transform } from "node:stream";
import { Agent, fetch as undiciFetch } from "undici";

// Keep this policy aligned with src/lib/url-safety.ts. The visual worker cannot
// import the TypeScript/Next.js module directly, so its Node-only fetch and
// browser-proxy paths share this script-local implementation instead.
const unsafeHostPattern =
  /(?:^|\.)localhost$|(?:^|\.)local$|(?:^|\.)internal$|(?:^|\.)invalid$|(?:^|\.)test$|(?:^|\.)example$/i;
const redirectStatuses = new Set([301, 302, 303, 307, 308]);
const hopByHopHeaders = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export function normalizePublicHttpUrl(input) {
  let url;
  try {
    url = new URL(String(input || "").trim());
  } catch {
    throw new Error("Enter a valid public URL.");
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error("Only public http and https URLs can be fetched.");
  }
  if (url.username || url.password) {
    throw new Error("URLs containing credentials cannot be fetched.");
  }
  const hostname = normalizedHostname(url.hostname);
  if (!hostname || unsafeHostPattern.test(hostname)) {
    throw new Error("Local, internal, and reserved hosts cannot be fetched.");
  }
  if (isPrivateOrReservedIp(hostname)) {
    throw new Error("Private, local, and reserved network addresses cannot be fetched.");
  }
  url.hash = "";
  return url;
}

export function isPrivateOrReservedIp(value) {
  const address = normalizedHostname(value).split("%")[0];
  const version = net.isIP(address);
  if (!version) return false;

  if (version === 4) {
    const [a, b, c, d] = address.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      // Azure exposes this platform virtual IP as a host-local endpoint.
      (a === 168 && b === 63 && c === 129 && d === 16) ||
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
  if (
    words[0] === 0x0064 &&
    words[1] === 0xff9b &&
    words.slice(2, 6).every((word) => word === 0)
  ) {
    return isPrivateOrReservedIp(ipv4FromIpv6Words(words));
  }
  // RFC 8215 reserves 64:ff9b:1::/48 for local-use translation. Its embedded
  // IPv4 position depends on the operator's prefix length, so it cannot be
  // decoded safely here; reject the entire local-use prefix.
  const isLocalUseTranslation =
    words[0] === 0x0064 && words[1] === 0xff9b && words[2] === 0x0001;

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
    isLocalUseTranslation ||
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

export async function resolvePublicAddresses(
  input,
  { lookupImpl = dns.lookup, timeoutMs = 15_000 } = {},
) {
  const url = input instanceof URL ? input : normalizePublicHttpUrl(input);
  const hostname = normalizedHostname(url.hostname);
  const literalFamily = net.isIP(hostname);
  const resolved = literalFamily
    ? [{ address: hostname, family: literalFamily }]
    : await promiseWithTimeout(
        lookupImpl(hostname, { all: true, verbatim: true }),
        timeoutMs,
        "Public hostname resolution timed out.",
      );
  const addresses = (Array.isArray(resolved) ? resolved : [resolved])
    .map((entry) => ({
      address: String(entry?.address || "").trim(),
      family: Number(entry?.family) || net.isIP(String(entry?.address || "")),
    }))
    .filter((entry) => entry.address && (entry.family === 4 || entry.family === 6));
  if (!addresses.length) {
    throw new Error("The source hostname did not resolve to a usable public address.");
  }
  if (addresses.some((entry) => isPrivateOrReservedIp(entry.address))) {
    throw new Error("The source hostname resolves to a private, local, or reserved address.");
  }
  return addresses;
}

export function createPinnedDispatcher(urlValue, addresses) {
  const url = urlValue instanceof URL ? urlValue : normalizePublicHttpUrl(urlValue);
  const expectedHostname = normalizedHostname(url.hostname);
  let cursor = 0;
  return new Agent({
    connect: {
      lookup(hostname, options, callback) {
        if (normalizedHostname(hostname) !== expectedHostname) {
          callback(new Error("Pinned dispatcher rejected a hostname change."), "", 0);
          return;
        }
        const family = Number(options?.family) || 0;
        const eligible = family === 4 || family === 6
          ? addresses.filter((entry) => entry.family === family)
          : addresses;
        if (!eligible.length) {
          callback(new Error("Pinned dispatcher has no address for this family."), "", 0);
          return;
        }
        if (options?.all) {
          callback(null, eligible.map((entry) => ({ ...entry })));
          return;
        }
        const selected = eligible[cursor % eligible.length];
        cursor += 1;
        callback(null, selected.address, selected.family);
      },
    },
  });
}

export async function fetchPinnedPublicHttpHop(
  input,
  init = {},
  {
    fetchImpl = undiciFetch,
    lookupImpl = dns.lookup,
    lookupTimeoutMs = 15_000,
    dispatcherFactory = createPinnedDispatcher,
  } = {},
) {
  const url = normalizePublicHttpUrl(input instanceof URL ? input.toString() : input);
  const addresses = await resolvePublicAddresses(url, {
    lookupImpl,
    timeoutMs: lookupTimeoutMs,
  });
  const dispatcher = dispatcherFactory(url, addresses);
  let response;
  try {
    response = await fetchImpl(url, {
      ...init,
      redirect: "manual",
      dispatcher,
    });
  } catch (error) {
    await closeDispatcher(dispatcher);
    throw error;
  }

  if (
    response.redirected ||
    (response.url && !sameRequestUrl(response.url, url))
  ) {
    await response.body?.cancel().catch(() => undefined);
    await closeDispatcher(dispatcher);
    throw new Error("Fetch followed an unvalidated redirect.");
  }

  let closed = false;
  return {
    response,
    url,
    addresses,
    close: async () => {
      if (closed) return;
      closed = true;
      await closeDispatcher(dispatcher);
    },
  };
}

export async function fetchPublicHttpResponse(
  input,
  init = {},
  {
    maxRedirects = 5,
    fetchImpl = undiciFetch,
    lookupImpl = dns.lookup,
    lookupTimeoutMs = 15_000,
    dispatcherFactory = createPinnedDispatcher,
  } = {},
) {
  let currentUrl = normalizePublicHttpUrl(input instanceof URL ? input.toString() : input);
  let currentInit = { ...init };

  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
    const fetched = await fetchPinnedPublicHttpHop(currentUrl, currentInit, {
      fetchImpl,
      lookupImpl,
      lookupTimeoutMs,
      dispatcherFactory,
    });
    const location = fetched.response.headers.get("location");
    if (redirectStatuses.has(fetched.response.status) && location) {
      await fetched.response.body?.cancel().catch(() => undefined);
      await fetched.close();
      if (redirectCount >= maxRedirects) {
        throw new Error(`Fetch exceeded ${maxRedirects} redirects.`);
      }
      const nextUrl = normalizePublicHttpUrl(new URL(location, fetched.url).toString());
      currentInit = redirectedRequestInit(currentInit, fetched.response.status, currentUrl, nextUrl);
      currentUrl = nextUrl;
      continue;
    }
    return { ...fetched, redirectCount };
  }

  throw new Error("Redirect processing did not terminate.");
}

export async function fetchPublicHttpBuffer(
  input,
  {
    maxBytes,
    timeoutMs,
    maxRedirects = 5,
    label = "Source response",
    init = {},
    ...dependencies
  } = {},
) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error("A positive response byte limit is required.");
  }
  const timeout = timeoutSignal(timeoutMs, init.signal);
  let fetched = null;
  try {
    fetched = await fetchPublicHttpResponse(
      input,
      { ...init, signal: timeout.signal },
      {
        maxRedirects,
        lookupTimeoutMs: Math.min(Number(timeoutMs) || 15_000, 15_000),
        ...dependencies,
      },
    );
    const contentLength = Number(fetched.response.headers.get("content-length") || 0);
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      throw new Error(`${label} is too large (${contentLength} bytes; limit ${maxBytes} bytes).`);
    }
    const buffer = await readResponseBodyBounded(fetched.response, maxBytes, label);
    return {
      buffer,
      finalUrl: fetched.url.toString(),
      status: fetched.response.status,
      statusText: fetched.response.statusText,
      contentType: fetched.response.headers.get("content-type") || null,
      redirectCount: fetched.redirectCount,
    };
  } catch (error) {
    if (timeout.signal.aborted && timeout.timedOut()) {
      throw new Error(`${label} timed out after ${timeoutMs}ms.`);
    }
    throw error;
  } finally {
    await fetched?.response.body?.cancel().catch(() => undefined);
    await fetched?.close().catch(() => undefined);
    timeout.cleanup();
  }
}

export async function readResponseBodyBounded(response, byteLimit, label = "Response") {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value || []);
      total += chunk.length;
      if (total > byteLimit) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`${label} is too large (more than ${byteLimit} bytes).`);
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

export async function connectPublicTcp(
  hostname,
  port,
  {
    lookupImpl = dns.lookup,
    connectImpl = net.connect,
    timeoutMs = 15_000,
    state = null,
  } = {},
) {
  const url = normalizePublicHttpUrl(`https://${formatAuthority(hostname, port)}`);
  const addresses = await resolvePublicAddresses(url, { lookupImpl, timeoutMs });
  let lastError = null;
  for (const address of addresses) {
    try {
      return await connectPinnedAddress(address, port, {
        connectImpl,
        timeoutMs,
        state,
      });
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("The public source connection failed.");
}

export async function startPublicNetworkProxy({
  lookupImpl = dns.lookup,
  connectImpl = net.connect,
  requestImpl = http.request,
  timeoutMs = 30_000,
  maxResponseBytes = 100 * 1024 * 1024,
} = {}) {
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1) {
    throw new Error("The public proxy requires a positive response byte limit.");
  }
  const state = {
    closing: false,
    clientSockets: new Set(),
    upstreamResources: new Set(),
    activePolicyEvaluations: new Set(),
    policyEvaluationGeneration: 0,
    responseByteCounter: { total: 0 },
    maxResponseBytes,
    policyViolationGeneration: 0,
    latestPolicyViolation: null,
    policyViolations: [],
  };
  const server = http.createServer((request, response) => {
    trackPolicyEvaluation(state, proxyHttpRequest(request, response, {
      lookupImpl,
      requestImpl,
      timeoutMs,
      state,
    }));
  });
  server.on("connection", (socket) => trackClosable(state.clientSockets, socket));
  server.on("connect", (request, clientSocket, head) => {
    trackPolicyEvaluation(state, proxyConnectRequest(request, clientSocket, head, {
      lookupImpl,
      connectImpl,
      timeoutMs,
      state,
    }));
  });
  server.on("upgrade", (request, socket) => {
    if (!state.closing) {
      recordPolicyViolation(state, {
        kind: "websocket_upgrade_refusal",
        reason: "unsupported_browser_transport",
        ...safeHttpTarget(request.url),
      });
    }
    writeProxyError(socket, 403, "WebSocket upgrades are not required for capture.");
  });

  await new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    state.closing = true;
    await closeServer(server, state);
    throw new Error("The capture network proxy did not bind a TCP port.");
  }
  let closed = false;
  return {
    host: "127.0.0.1",
    port: address.port,
    url: `http://127.0.0.1:${address.port}`,
    policyCheckpoint: () => state.policyViolationGeneration,
    policyViolationSince: (checkpoint) => {
      const generation = Number(checkpoint);
      const violation = state.latestPolicyViolation;
      if (
        !Number.isSafeInteger(generation) || generation < 0 ||
        !violation || violation.generation <= generation
      ) return null;
      return { ...violation };
    },
    policyViolationsSince: (checkpoint) => {
      const generation = Number(checkpoint);
      if (!Number.isSafeInteger(generation) || generation < 0) return [];
      return state.policyViolations
        .filter((violation) => violation.generation > generation)
        .map((violation) => ({ ...violation }));
    },
    recordBrowserPolicyViolation: ({ kind, reason, url }) => {
      if (state.closing) return null;
      recordPolicyViolation(state, {
        kind: String(kind || "browser_policy_refusal").slice(0, 80),
        reason: String(reason || "browser_policy_refusal").slice(0, 80),
        ...safeHttpTarget(url),
      });
      return { ...state.latestPolicyViolation };
    },
    settlePolicyEvaluations: (options = {}) => settlePolicyEvaluations(state, options),
    close: async () => {
      if (closed) return;
      closed = true;
      state.closing = true;
      await closeServer(server, state);
      // Allow buffered transform/error callbacks from destroyed response and
      // tunnel streams to update the final immutable violation snapshot.
      await delayMilliseconds(25);
    },
  };
}

async function proxyHttpRequest(request, response, options) {
  let url;
  try {
    url = normalizePublicHttpUrl(request.url);
    if (url.protocol !== "http:") {
      throw new Error("HTTPS browser requests must use a CONNECT tunnel.");
    }
    const addresses = await resolvePublicAddresses(url, options);
    assertProxyRequestOpen(request, response, options.state);
    const selected = addresses[0];
    const headers = sanitizeProxyHeaders(request.headers);
    headers.host = url.host;
    const upstream = trackClosable(options.state.upstreamResources, options.requestImpl({
      protocol: "http:",
      hostname: selected.address,
      family: selected.family,
      port: url.port ? Number(url.port) : 80,
      method: request.method,
      path: `${url.pathname}${url.search}`,
      headers,
      agent: false,
    }, (upstreamResponse) => {
      const responseLimiter = createByteLimitTransform(
        options.state.maxResponseBytes,
        "Public proxy response exceeded its byte limit.",
        { sharedCounter: options.state.responseByteCounter },
      );
      responseLimiter.once("error", (error) => {
        recordPolicyViolation(options.state, {
          kind: "http_response",
          reason: "byte_limit",
          target: url.hostname,
          port: url.port ? Number(url.port) : 80,
          observedBytes: error?.observed_bytes,
          limitBytes: options.state.maxResponseBytes,
        });
        upstreamResponse.destroy();
        upstream.destroy();
        response.destroy();
      });
      response.writeHead(
        upstreamResponse.statusCode || 502,
        sanitizeProxyHeaders(upstreamResponse.headers),
      );
      upstreamResponse.pipe(responseLimiter).pipe(response);
    }));
    upstream.setTimeout(options.timeoutMs, () => {
      upstream.destroy(new Error("Public proxy request timed out."));
    });
    upstream.on("error", () => {
      if (!response.headersSent) response.writeHead(502);
      response.end("Public source request failed.");
    });
    request.once("aborted", () => upstream.destroy());
    response.once("close", () => {
      if (!response.writableEnded) upstream.destroy();
    });
    request.pipe(upstream);
  } catch (error) {
    const policyRefusal = isPublicNetworkPolicyRefusal(error);
    if (!options.state.closing && policyRefusal) {
      recordPolicyViolation(options.state, {
        kind: "http_policy_refusal",
        reason: "public_network_policy_refusal",
        ...safeHttpTarget(request.url),
      });
    }
    if (!response.headersSent) response.writeHead(policyRefusal ? 403 : 502);
    response.end(policyRefusal
      ? "Public network policy refused this request."
      : "Public source request failed.");
  }
}

async function proxyConnectRequest(request, clientSocket, head, options) {
  try {
    const { hostname, port } = parseConnectAuthority(request.url);
    const upstream = await connectPublicTcp(hostname, port, options);
    if (options.state.closing || clientSocket.destroyed) {
      upstream.destroy();
      throw new Error("The public proxy closed before the tunnel was established.");
    }
    trackClosable(options.state.upstreamResources, upstream);
    const responseLimiter = createByteLimitTransform(
      options.state.maxResponseBytes,
      "Public proxy tunnel exceeded its byte limit.",
      { sharedCounter: options.state.responseByteCounter },
    );
    responseLimiter.once("error", (error) => {
      recordPolicyViolation(options.state, {
        kind: "https_tunnel",
        reason: "byte_limit",
        target: hostname,
        port,
        observedBytes: error?.observed_bytes,
        limitBytes: options.state.maxResponseBytes,
      });
      upstream.destroy();
      clientSocket.destroy();
    });
    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head?.length) upstream.write(head);
    upstream.on("error", () => clientSocket.destroy());
    clientSocket.on("error", () => upstream.destroy());
    upstream.once("close", () => clientSocket.destroy());
    clientSocket.once("close", () => upstream.destroy());
    upstream.pipe(responseLimiter).pipe(clientSocket);
    clientSocket.pipe(upstream);
  } catch (error) {
    const policyRefusal = isPublicNetworkPolicyRefusal(error);
    if (!options.state.closing && policyRefusal) {
      recordPolicyViolation(options.state, {
        kind: "https_tunnel_refusal",
        reason: "public_network_policy_refusal",
        ...safeConnectTarget(request.url),
      });
    }
    writeProxyError(
      clientSocket,
      policyRefusal ? 403 : 502,
      policyRefusal
        ? "Public network policy refused this tunnel."
        : "Public source connection failed.",
    );
  }
}

function connectPinnedAddress(address, port, { connectImpl, timeoutMs, state = null }) {
  return new Promise((resolve, reject) => {
    const socket = trackClosable(state?.upstreamResources || new Set(), connectImpl({
      host: address.address,
      family: address.family,
      port,
    }));
    let settled = false;
    if (state?.closing) {
      socket.destroy();
      reject(new Error("The public proxy closed before connecting upstream."));
      return;
    }
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new Error("Public source connection timed out."));
    }, timeoutMs);
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.off("connect", onConnect);
      socket.off("error", onError);
      socket.off("close", onClose);
      callback(value);
    };
    const onConnect = () => finish(resolve, socket);
    const onError = (error) => finish(reject, error);
    const onClose = () => finish(reject, new Error("The public source connection closed before connecting."));
    socket.once("connect", onConnect);
    socket.once("error", onError);
    socket.once("close", onClose);
  });
}

function redirectedRequestInit(init, status, previousUrl, nextUrl) {
  const next = { ...init, headers: { ...headersObject(init.headers) } };
  const method = String(init.method || "GET").toUpperCase();
  if ((status === 303 && method !== "HEAD") || ((status === 301 || status === 302) && method === "POST")) {
    next.method = "GET";
    delete next.body;
    deleteHeader(next.headers, "content-length");
    deleteHeader(next.headers, "content-type");
  }
  if (previousUrl.origin !== nextUrl.origin) {
    deleteHeader(next.headers, "authorization");
    deleteHeader(next.headers, "cookie");
    deleteHeader(next.headers, "proxy-authorization");
  }
  return next;
}

function timeoutSignal(timeoutMs, parentSignal) {
  const controller = new AbortController();
  let didTimeout = false;
  const numericTimeout = Number(timeoutMs);
  const timer = Number.isFinite(numericTimeout) && numericTimeout > 0
    ? setTimeout(() => {
      didTimeout = true;
      controller.abort(new Error("Public network request timed out."));
    }, numericTimeout)
    : null;
  const onParentAbort = () => controller.abort(parentSignal.reason);
  if (parentSignal?.aborted) onParentAbort();
  else parentSignal?.addEventListener("abort", onParentAbort, { once: true });
  return {
    signal: controller.signal,
    timedOut: () => didTimeout,
    cleanup: () => {
      if (timer) clearTimeout(timer);
      parentSignal?.removeEventListener("abort", onParentAbort);
    },
  };
}

function parseConnectAuthority(value) {
  const authority = String(value || "").trim();
  if (!authority) throw new Error("CONNECT authority is missing.");
  const parsed = new URL(`https://${authority}`);
  if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error("CONNECT authority is invalid.");
  }
  const port = parsed.port ? Number(parsed.port) : 443;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("CONNECT port is invalid.");
  }
  return { hostname: normalizedHostname(parsed.hostname), port };
}

function formatAuthority(hostname, port) {
  const normalized = normalizedHostname(hostname);
  return `${net.isIP(normalized) === 6 ? `[${normalized}]` : normalized}:${port}`;
}

function sanitizeProxyHeaders(headers) {
  const result = {};
  for (const [name, value] of Object.entries(headers || {})) {
    if (value === undefined || hopByHopHeaders.has(name.toLowerCase())) continue;
    result[name] = value;
  }
  return result;
}

function headersObject(headers) {
  if (!headers) return {};
  if (headers instanceof Headers) return Object.fromEntries(headers.entries());
  if (Array.isArray(headers)) return Object.fromEntries(headers);
  return { ...headers };
}

function deleteHeader(headers, target) {
  for (const name of Object.keys(headers || {})) {
    if (name.toLowerCase() === target) delete headers[name];
  }
}

function parseIpv6Words(address) {
  const halves = address.split("::");
  if (halves.length > 2) return null;
  const left = parseIpv6Side(halves[0]);
  const right = halves.length === 2 ? parseIpv6Side(halves[1]) : [];
  if (!left || !right) return null;
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) {
    return null;
  }
  return [...left, ...Array.from({ length: missing }, () => 0), ...right];
}

function parseIpv6Side(side) {
  if (!side) return [];
  const words = [];
  for (const segment of side.split(":")) {
    if (segment.includes(".")) {
      const bytes = segment.split(".").map(Number);
      if (
        bytes.length !== 4 ||
        bytes.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)
      ) return null;
      words.push((bytes[0] << 8) | bytes[1], (bytes[2] << 8) | bytes[3]);
      continue;
    }
    const word = Number.parseInt(segment, 16);
    if (!Number.isInteger(word) || word < 0 || word > 0xffff) return null;
    words.push(word);
  }
  return words;
}

function ipv4FromIpv6Words(words) {
  return [words[6] >> 8, words[6] & 0xff, words[7] >> 8, words[7] & 0xff].join(".");
}

function normalizedHostname(value) {
  return String(value || "").replace(/^\[|\]$/g, "").toLowerCase();
}

function sameRequestUrl(responseUrl, requestedUrl) {
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

function promiseWithTimeout(value, timeoutMs, message) {
  const milliseconds = Number(timeoutMs);
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return Promise.resolve(value);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(result);
    };
    const timer = setTimeout(
      () => finish(reject, new Error(message)),
      milliseconds,
    );
    Promise.resolve(value).then(
      (result) => finish(resolve, result),
      (error) => finish(reject, error),
    );
  });
}

function trackClosable(collection, resource) {
  if (!resource) return resource;
  collection.add(resource);
  resource.once?.("close", () => collection.delete(resource));
  return resource;
}

function trackPolicyEvaluation(state, operation) {
  state.policyEvaluationGeneration += 1;
  let tracked;
  tracked = Promise.resolve(operation).finally(() => {
    state.activePolicyEvaluations.delete(tracked);
  });
  state.activePolicyEvaluations.add(tracked);
  void tracked.catch(() => undefined);
  return tracked;
}

async function settlePolicyEvaluations(state, {
  timeoutMs = 5_000,
  quietPeriodMs = 25,
} = {}) {
  const timeout = Number(timeoutMs);
  const quietPeriod = Number(quietPeriodMs);
  if (!Number.isFinite(timeout) || timeout <= 0) {
    throw new TypeError("Proxy policy settlement requires a positive timeout.");
  }
  if (!Number.isFinite(quietPeriod) || quietPeriod < 0) {
    throw new TypeError("Proxy policy settlement requires a non-negative quiet period.");
  }
  const deadline = Date.now() + timeout;
  let quietGeneration = null;

  while (!state.closing && Date.now() < deadline) {
    const active = [...state.activePolicyEvaluations];
    if (active.length) {
      const completed = await allSettledWithin(active, Math.max(1, deadline - Date.now()));
      if (!completed) break;
      quietGeneration = null;
      continue;
    }

    const generation = state.policyEvaluationGeneration;
    if (quietGeneration === generation) {
      return {
        settled: true,
        policy_evaluation_generation: generation,
      };
    }
    quietGeneration = generation;
    await delayMilliseconds(Math.min(quietPeriod, Math.max(1, deadline - Date.now())));
  }

  const error = new Error(
    "capture_resource_limit: resource=browser_network_settle " +
      `observed=${state.activePolicyEvaluations.size}_in_flight limit=0 unit=policy_evaluations. ` +
      "Capture was rejected because browser network-policy evaluation did not settle.",
  );
  error.code = "AWARDPING_PROXY_SETTLE_TIMEOUT";
  error.failure_type = "capture_resource_limit";
  error.capture_resource_limit = true;
  error.capture_resource = "browser_network_settle";
  throw error;
}

function allSettledWithin(values, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    Promise.allSettled(values).then(() => finish(true));
  });
}

function delayMilliseconds(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function assertProxyRequestOpen(request, response, state) {
  if (state?.closing || request.destroyed || response.destroyed) {
    throw new Error("The public proxy closed before the request was established.");
  }
}

function destroyClosable(resource) {
  try {
    resource?.destroy?.();
  } catch {
    // Shutdown is best effort after the listener has already been closed.
  }
}

export function createByteLimitTransform(
  byteLimit,
  message = "Response exceeded its byte limit.",
  { sharedCounter = null } = {},
) {
  if (!Number.isSafeInteger(byteLimit) || byteLimit < 1) {
    throw new Error("A positive stream byte limit is required.");
  }
  let total = 0;
  return new Transform({
    transform(chunk, encoding, callback) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
      total += buffer.length;
      if (sharedCounter) {
        const sharedTotal = Number(sharedCounter.total);
        sharedCounter.total = (Number.isSafeInteger(sharedTotal) && sharedTotal >= 0 ? sharedTotal : 0) +
          buffer.length;
      }
      const observedBytes = sharedCounter ? sharedCounter.total : total;
      if (observedBytes > byteLimit) {
        const error = new Error(message);
        error.code = "AWARDPING_PUBLIC_PROXY_BYTE_LIMIT";
        error.observed_bytes = observedBytes;
        error.limit_bytes = byteLimit;
        callback(error);
        return;
      }
      callback(null, buffer);
    },
  });
}

function recordPolicyViolation(state, {
  kind,
  reason,
  target,
  port,
  observedBytes,
  limitBytes = null,
}) {
  state.policyViolationGeneration += 1;
  const violation = Object.freeze({
    generation: state.policyViolationGeneration,
    kind,
    reason,
    target: normalizedHostname(target).slice(0, 253),
    port: Number(port) || null,
    observed_bytes: Number.isSafeInteger(observedBytes) ? observedBytes : null,
    limit_bytes: Number.isSafeInteger(limitBytes) ? limitBytes : null,
  });
  state.latestPolicyViolation = violation;
  state.policyViolations.push(violation);
  if (state.policyViolations.length > 100) state.policyViolations.shift();
}

function safeHttpTarget(value) {
  try {
    const parsed = new URL(String(value || ""));
    return {
      target: normalizedHostname(parsed.hostname) || "invalid_http_target",
      port: parsed.port ? Number(parsed.port) : parsed.protocol === "https:" ? 443 : 80,
    };
  } catch {
    return { target: "invalid_http_target", port: null };
  }
}

function safeConnectTarget(value) {
  try {
    const parsed = parseConnectAuthority(value);
    return { target: parsed.hostname, port: parsed.port };
  } catch {
    return { target: "invalid_connect_target", port: null };
  }
}

function isPublicNetworkPolicyRefusal(error) {
  const message = String(error?.message || error || "").toLowerCase();
  return [
    "valid public url",
    "only public http and https",
    "urls containing credentials",
    "local, internal, and reserved hosts",
    "private, local, and reserved network addresses",
    "resolves to a private, local, or reserved address",
    "https browser requests must use a connect tunnel",
    "connect authority is missing",
    "connect authority is invalid",
    "connect port is invalid",
  ].some((fragment) => message.includes(fragment));
}

async function closeDispatcher(dispatcher) {
  if (!dispatcher) return;
  if (typeof dispatcher.close === "function") {
    await dispatcher.close().catch(() => undefined);
  } else if (typeof dispatcher.destroy === "function") {
    dispatcher.destroy();
  }
}

function writeProxyError(socket, status, message) {
  if (!socket || socket.destroyed) return;
  const body = `${message}\n`;
  socket.end(
    `HTTP/1.1 ${status} Forbidden\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
  );
}

function closeServer(server, state = {}) {
  state.closing = true;
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(forceCloseTimer);
      resolve();
    };
    const forceCloseTimer = setTimeout(finish, 5_000);
    try {
      server.close(finish);
    } catch {
      finish();
      return;
    }
    server.closeIdleConnections?.();
    for (const resource of state.upstreamResources || []) destroyClosable(resource);
    for (const socket of state.clientSockets || []) destroyClosable(socket);
    server.closeAllConnections?.();
  });
}
