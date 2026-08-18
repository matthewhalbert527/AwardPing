import { EventEmitter, once } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { describe, expect, it, vi } from "vitest";
import { chromium } from "playwright-core";
import {
  connectPublicTcp,
  createByteLimitTransform,
  fetchPinnedPublicHttpHop,
  fetchPublicHttpBuffer,
  fetchPublicHttpResponse,
  normalizePublicHttpUrl,
  resolvePublicAddresses,
  startPublicNetworkProxy,
} from "./lib/public-network-safety.mjs";

const workerSource = readFileSync(
  new URL("./capture-visual-snapshots.mjs", import.meta.url),
  "utf8",
);
const browserExecutable = [
  process.env.BROWSER_EXECUTABLE_PATH,
  process.env.CHROME_PATH,
  process.env.EDGE_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  chromium.executablePath(),
].find((value) => value && existsSync(value));
const captureBrowserArgs = [
  "--headless=new",
  "--disable-gpu",
  "--disable-extensions",
  "--disable-component-extensions-with-background-pages",
  "--disable-background-networking",
  "--disable-background-timer-throttling",
  "--disable-renderer-backgrounding",
  "--disable-quic",
  "--disable-features=Translate,AutofillServerCommunication,MediaRouter",
  "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
];

describe("visual worker public network safety", () => {
  it.each([
    "http://127.0.0.1/admin",
    "http://169.254.169.254/latest/meta-data",
    "http://168.63.129.16/metadata",
    "http://[::1]/",
    "http://[64:ff9b::c0a8:101]/",
    "http://[64:ff9b:1::808:808]/",
    "http://service.internal/",
    "file:///etc/passwd",
    "https://user:secret@awards.example.org/",
  ])("rejects a local, reserved, or credential-bearing URL: %s", (url) => {
    expect(() => normalizePublicHttpUrl(url)).toThrow();
  });

  it("rejects a mixed public/private DNS answer before transport", async () => {
    await expect(resolvePublicAddresses("https://awards.example.org/", {
      lookupImpl: async () => [
        { address: "8.8.8.8", family: 4 },
        { address: "127.0.0.1", family: 4 },
      ],
    })).rejects.toThrow(/private, local, or reserved/i);
  });

  it("rejects the RFC 8215 local-use translation prefix in DNS answers", async () => {
    await expect(resolvePublicAddresses("https://translated.awards.org/", {
      lookupImpl: async () => [{ address: "64:ff9b:1::808:808", family: 6 }],
    })).rejects.toThrow(/private, local, or reserved/i);
  });

  it("rejects Azure's host-local platform VIP in DNS answers", async () => {
    await expect(resolvePublicAddresses("https://azure-vip.awards.org/", {
      lookupImpl: async () => [{ address: "168.63.129.16", family: 4 }],
    })).rejects.toThrow(/private, local, or reserved/i);
  });

  it("bounds hostname resolution time before any connection is attempted", async () => {
    await expect(resolvePublicAddresses("https://slow-dns.awards.org/", {
      lookupImpl: async () => new Promise(() => undefined),
      timeoutMs: 20,
    })).rejects.toThrow(/resolution timed out/i);
  });

  it("does not call fetch when the initial hostname resolves privately", async () => {
    const fetchImpl = vi.fn();
    await expect(fetchPinnedPublicHttpHop(
      "https://private-dns.awards.org/page",
      {},
      {
        fetchImpl,
        lookupImpl: async () => [{ address: "10.20.30.40", family: 4 }],
        dispatcherFactory: fakeDispatcherFactory(),
      },
    )).rejects.toThrow(/private, local, or reserved/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("validates and pins every public redirect hop", async () => {
    const resolvedHosts = [];
    const pinned = [];
    const closed = [];
    const lookupImpl = vi.fn(async (hostname) => {
      resolvedHosts.push(hostname);
      return [{
        address: hostname === "first.awards.org" ? "8.8.8.8" : "1.1.1.1",
        family: 4,
      }];
    });
    const dispatcherFactory = vi.fn((url, addresses) => {
      pinned.push({ hostname: url.hostname, addresses });
      return { close: async () => closed.push(url.hostname) };
    });
    const fetchImpl = vi.fn(async (url, init) => {
      expect(init.redirect).toBe("manual");
      expect(init.dispatcher).toBeTruthy();
      if (url.hostname === "first.awards.org") {
        return new Response(null, {
          status: 302,
          headers: { location: "https://second.awards.org/final" },
        });
      }
      return new Response("official award", { status: 200 });
    });

    const fetched = await fetchPublicHttpResponse(
      "https://first.awards.org/start",
      {},
      { lookupImpl, dispatcherFactory, fetchImpl },
    );
    expect(fetched.url.toString()).toBe("https://second.awards.org/final");
    expect(resolvedHosts).toEqual(["first.awards.org", "second.awards.org"]);
    expect(pinned).toEqual([
      {
        hostname: "first.awards.org",
        addresses: [{ address: "8.8.8.8", family: 4 }],
      },
      {
        hostname: "second.awards.org",
        addresses: [{ address: "1.1.1.1", family: 4 }],
      },
    ]);
    expect(closed).toEqual(["first.awards.org"]);
    await fetched.response.body?.cancel();
    await fetched.close();
    expect(closed).toEqual(["first.awards.org", "second.awards.org"]);
  });

  it("refuses a public redirect whose next DNS answer is link-local", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, {
      status: 302,
      headers: { location: "http://metadata.awards.org/latest" },
    }));
    const lookupImpl = vi.fn(async (hostname) => [{
      address: hostname === "public.awards.org" ? "8.8.8.8" : "169.254.169.254",
      family: 4,
    }]);

    await expect(fetchPublicHttpResponse(
      "https://public.awards.org/start",
      {},
      {
        fetchImpl,
        lookupImpl,
        dispatcherFactory: fakeDispatcherFactory(),
      },
    )).rejects.toThrow(/private, local, or reserved/i);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(lookupImpl).toHaveBeenCalledTimes(2);
  });

  it("fails closed if a transport follows a redirect despite manual mode", async () => {
    const close = vi.fn(async () => undefined);
    await expect(fetchPinnedPublicHttpHop(
      "https://public.awards.org/start",
      {},
      {
        lookupImpl: publicLookup,
        dispatcherFactory: () => ({ close }),
        fetchImpl: async () => ({
          body: null,
          headers: new Headers(),
          redirected: true,
          status: 200,
          statusText: "OK",
          url: "https://private.awards.org/final",
        }),
      },
    )).rejects.toThrow(/unvalidated redirect/i);
    expect(close).toHaveBeenCalledOnce();
  });

  it("caps redirect chains", async () => {
    const fetchImpl = vi.fn(async (url) => new Response(null, {
      status: 302,
      headers: { location: `${url.origin}/next` },
    }));
    await expect(fetchPublicHttpResponse(
      "https://loop.awards.org/start",
      {},
      {
        maxRedirects: 2,
        fetchImpl,
        lookupImpl: publicLookup,
        dispatcherFactory: fakeDispatcherFactory(),
      },
    )).rejects.toThrow(/exceeded 2 redirects/i);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("pins a validated address and rejects a later DNS rebind before fetch", async () => {
    let lookupCount = 0;
    const pinned = [];
    const lookupImpl = vi.fn(async () => {
      lookupCount += 1;
      return [{
        address: lookupCount === 1 ? "8.8.4.4" : "127.0.0.1",
        family: 4,
      }];
    });
    const fetchImpl = vi.fn(async () => new Response("ok", { status: 200 }));
    const dispatcherFactory = vi.fn((_url, addresses) => {
      pinned.push(addresses.map((entry) => entry.address));
      return { close: vi.fn(async () => undefined) };
    });

    const first = await fetchPinnedPublicHttpHop(
      "https://rebind.awards.org/page",
      {},
      { lookupImpl, fetchImpl, dispatcherFactory },
    );
    await first.response.body?.cancel();
    await first.close();
    await expect(fetchPinnedPublicHttpHop(
      "https://rebind.awards.org/page",
      {},
      { lookupImpl, fetchImpl, dispatcherFactory },
    )).rejects.toThrow(/private, local, or reserved/i);

    expect(pinned).toEqual([["8.8.4.4"]]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("stops a chunked PDF as soon as decoded bytes exceed the cap", async () => {
    let cancelled = false;
    let pulls = 0;
    const body = new ReadableStream({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array([1, 2, 3]));
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetchImpl = vi.fn(async () => new Response(body, {
      status: 200,
      headers: { "content-type": "application/pdf" },
    }));

    await expect(fetchPublicHttpBuffer("https://pdf.awards.org/rules.pdf", {
      maxBytes: 5,
      timeoutMs: 1_000,
      label: "PDF",
      fetchImpl,
      lookupImpl: publicLookup,
      dispatcherFactory: fakeDispatcherFactory(),
    })).rejects.toThrow(/more than 5 bytes/i);
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThanOrEqual(3);
  });

  it("accepts a streamed response exactly at the byte cap", async () => {
    const result = await fetchPublicHttpBuffer("https://pdf.awards.org/rules.pdf", {
      maxBytes: 5,
      timeoutMs: 1_000,
      label: "PDF",
      fetchImpl: async () => new Response(new Uint8Array([1, 2, 3, 4, 5]), {
        status: 200,
        headers: { "content-type": "application/pdf" },
      }),
      lookupImpl: publicLookup,
      dispatcherFactory: fakeDispatcherFactory(),
    });
    expect(result.buffer).toEqual(Buffer.from([1, 2, 3, 4, 5]));
  });

  it("fails a browser proxy stream before forwarding bytes beyond its cap", async () => {
    const limiter = createByteLimitTransform(5, "browser response cap");
    const chunks = [];
    limiter.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    const failed = once(limiter, "error");
    limiter.write(Buffer.from([1, 2, 3]));
    limiter.write(Buffer.from([4, 5, 6]));
    const [error] = await failed;
    expect(error.message).toBe("browser response cap");
    expect(Buffer.concat(chunks)).toEqual(Buffer.from([1, 2, 3]));
    limiter.destroy();
  });

  it("enforces one aggregate response budget across parallel proxy streams", async () => {
    const sharedCounter = { total: 0 };
    const first = createByteLimitTransform(5, "aggregate cap", { sharedCounter });
    const second = createByteLimitTransform(5, "aggregate cap", { sharedCounter });
    first.resume();
    second.resume();
    first.end(Buffer.from([1, 2, 3]));
    await once(first, "end");
    const failed = once(second, "error");
    second.end(Buffer.from([4, 5, 6]));
    const [error] = await failed;
    expect(error).toMatchObject({
      code: "AWARDPING_PUBLIC_PROXY_BYTE_LIMIT",
      observed_bytes: 6,
      limit_bytes: 5,
    });
    expect(sharedCounter.total).toBe(6);
    second.destroy();
  });

  it("resets the aggregate response budget for each source-scoped proxy", async () => {
    const upstream = http.createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/octet-stream" });
      response.end(Buffer.alloc(6, 1));
    });
    await listen(upstream);
    const upstreamAddress = upstream.address();
    try {
      for (let captureIndex = 0; captureIndex < 2; captureIndex += 1) {
        const proxy = await startPublicNetworkProxy({
          lookupImpl: async () => [{ address: "8.8.8.8", family: 4 }],
          requestImpl: (options, callback) => http.request({
            ...options,
            hostname: "127.0.0.1",
            family: 4,
            port: upstreamAddress.port,
          }, callback),
          maxResponseBytes: 10,
        });
        const checkpoint = proxy.policyCheckpoint();
        try {
          expect(await requestThroughProxy(proxy, "http://same-host.awards.org/asset"))
            .toBe(200);
          await proxy.settlePolicyEvaluations({ timeoutMs: 1_000, quietPeriodMs: 5 });
          expect(proxy.policyViolationSince(checkpoint)).toBeNull();
        } finally {
          await proxy.close();
        }
      }
    } finally {
      await closeHttpServer(upstream);
    }
  });

  it("aborts a PDF request at the configured network timeout", async () => {
    const fetchImpl = vi.fn(async (_url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener("abort", () => {
        reject(init.signal.reason || new Error("aborted"));
      }, { once: true });
    }));

    await expect(fetchPublicHttpBuffer("https://slow.awards.org/rules.pdf", {
      maxBytes: 10,
      timeoutMs: 25,
      label: "PDF",
      fetchImpl,
      lookupImpl: publicLookup,
      dispatcherFactory: fakeDispatcherFactory(),
    })).rejects.toThrow(/PDF timed out after 25ms/);
  });

  it("connects only to the address captured by validation and fails a rebound", async () => {
    let lookupCount = 0;
    const connectedHosts = [];
    const connectImpl = vi.fn((options) => {
      connectedHosts.push(options.host);
      const socket = new EventEmitter();
      socket.destroy = vi.fn();
      queueMicrotask(() => socket.emit("connect"));
      return socket;
    });
    const lookupImpl = vi.fn(async () => {
      lookupCount += 1;
      return [{
        address: lookupCount === 1 ? "8.8.8.8" : "10.0.0.7",
        family: 4,
      }];
    });

    await connectPublicTcp("browser.awards.org", 443, {
      lookupImpl,
      connectImpl,
      timeoutMs: 100,
    });
    await expect(connectPublicTcp("browser.awards.org", 443, {
      lookupImpl,
      connectImpl,
      timeoutMs: 100,
    })).rejects.toThrow(/private, local, or reserved/i);
    expect(connectedHosts).toEqual(["8.8.8.8"]);
  });

  it("blocks private browser document and subresource requests at the proxy", async () => {
    const proxy = await startPublicNetworkProxy({
      lookupImpl: async () => [{ address: "127.0.0.1", family: 4 }],
      timeoutMs: 100,
    });
    try {
      const statuses = await Promise.all([
        requestThroughProxy(proxy, "http://document.awards.org/page"),
        requestThroughProxy(proxy, "http://assets.awards.org/private-script.js"),
      ]);
      expect(statuses).toEqual([403, 403]);
    } finally {
      await proxy.close();
    }
  });

  it("records browser transport-security refusals without retaining URL paths", async () => {
    const proxy = await startPublicNetworkProxy();
    const checkpoint = proxy.policyCheckpoint();
    try {
      proxy.recordBrowserPolicyViolation({
        kind: "browser_transport_security_refusal",
        reason: "browser_transport_security_refusal",
        url: "https://official-award.example.edu/private/path?token=secret",
      });
      expect(proxy.policyViolationSince(checkpoint)).toMatchObject({
        kind: "browser_transport_security_refusal",
        reason: "browser_transport_security_refusal",
        target: "official-award.example.edu",
        port: 443,
      });
      expect(JSON.stringify(proxy.policyViolationSince(checkpoint))).not.toContain("secret");
      expect(JSON.stringify(proxy.policyViolationSince(checkpoint))).not.toContain("private/path");
    } finally {
      await proxy.close();
    }
  });

  it("drains delayed DNS policy evaluation before returning a capture checkpoint", async () => {
    let releaseLookup;
    let markLookupStarted;
    const lookupStarted = new Promise((resolve) => {
      markLookupStarted = resolve;
    });
    const proxy = await startPublicNetworkProxy({
      lookupImpl: async () => {
        markLookupStarted();
        await new Promise((resolve) => {
          releaseLookup = resolve;
        });
        return [{ address: "10.0.0.7", family: 4 }];
      },
      timeoutMs: 1_000,
    });
    const checkpoint = proxy.policyCheckpoint();
    try {
      const responseStatus = requestThroughProxy(proxy, "http://slow-private.awards.org/image.png");
      await lookupStarted;
      let drainFinished = false;
      const drained = proxy.settlePolicyEvaluations({ timeoutMs: 1_000, quietPeriodMs: 5 })
        .then((value) => {
          drainFinished = true;
          return value;
        });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(drainFinished).toBe(false);
      releaseLookup();
      expect(await responseStatus).toBe(403);
      await expect(drained).resolves.toMatchObject({ settled: true });
      expect(proxy.policyViolationSince(checkpoint)).toMatchObject({
        kind: "http_policy_refusal",
        reason: "public_network_policy_refusal",
        target: "slow-private.awards.org",
      });
    } finally {
      releaseLookup?.();
      await proxy.close();
    }
  });

  it("closes active client sockets instead of hanging during proxy shutdown", async () => {
    const proxy = await startPublicNetworkProxy();
    const socket = net.connect(proxy.port, proxy.host);
    await once(socket, "connect");
    const socketClosed = once(socket, "close");
    await proxy.close();
    await socketClosed;
    expect(socket.destroyed).toBe(true);
  });

  it.skipIf(!browserExecutable)(
    "loads a real Chromium page through the pinned loopback proxy",
    async () => {
      const upstream = http.createServer((request, response) => {
        response.writeHead(200, { "content-type": "text/html" });
        response.end(`<main id="result">proxy ok ${request.url}</main>`);
      });
      await listen(upstream);
      const upstreamAddress = upstream.address();
      const observedConnections = [];
      const proxy = await startPublicNetworkProxy({
        lookupImpl: async () => [{ address: "8.8.8.8", family: 4 }],
        requestImpl: (options, callback) => {
          observedConnections.push({
            hostname: options.hostname,
            family: options.family,
            hostHeader: options.headers.host,
          });
          return http.request({
            ...options,
            hostname: "127.0.0.1",
            family: 4,
            port: upstreamAddress.port,
          }, callback);
        },
        timeoutMs: 5_000,
      });
      let browser = null;
      try {
        browser = await chromium.launch({
          executablePath: browserExecutable,
          headless: true,
          args: captureBrowserArgs,
        });
        const context = await browser.newContext({
          proxy: { server: proxy.url, bypass: "<-loopback>" },
          ignoreHTTPSErrors: false,
          serviceWorkers: "block",
        });
        const page = await context.newPage();
        const response = await page.goto("http://public-smoke.awards.org/smoke", {
          waitUntil: "domcontentloaded",
          timeout: 10_000,
        });
        expect(response?.status()).toBe(200);
        expect(await page.locator("#result").textContent()).toBe("proxy ok /smoke");
        expect(observedConnections.find((entry) => (
          entry.hostHeader === "public-smoke.awards.org"
        ))).toEqual({
          hostname: "8.8.8.8",
          family: 4,
          hostHeader: "public-smoke.awards.org",
        });
        await context.close();
      } finally {
        await browser?.close().catch(() => undefined);
        await proxy.close().catch(() => undefined);
        await closeHttpServer(upstream);
      }
    },
    20_000,
  );

  it.skipIf(!browserExecutable)(
    "records an oversized Chromium subresource so capture can fail closed",
    async () => {
      const upstream = http.createServer((request, response) => {
        if (request.url === "/oversized.bin") {
          response.writeHead(200, { "content-type": "application/octet-stream" });
          response.end(Buffer.alloc(256 * 1024, 1));
          return;
        }
        response.writeHead(200, { "content-type": "text/html" });
        response.end([
          '<main id="result">award page</main>',
          "<script>",
          "addEventListener('DOMContentLoaded', () => setTimeout(() => {",
          "const image = new Image(); image.src = '/oversized.bin'; document.body.append(image);",
          "}, 50));",
          "</script>",
        ].join(""));
      });
      await listen(upstream);
      const upstreamAddress = upstream.address();
      const proxy = await startPublicNetworkProxy({
        lookupImpl: async () => [{ address: "8.8.8.8", family: 4 }],
        requestImpl: (options, callback) => http.request({
          ...options,
          hostname: "127.0.0.1",
          family: 4,
          port: upstreamAddress.port,
        }, callback),
        timeoutMs: 5_000,
        maxResponseBytes: 64 * 1024,
      });
      const checkpoint = proxy.policyCheckpoint();
      let browser = null;
      try {
        browser = await chromium.launch({
          executablePath: browserExecutable,
          headless: true,
          args: captureBrowserArgs,
        });
        const context = await browser.newContext({
          proxy: { server: proxy.url, bypass: "<-loopback>" },
          serviceWorkers: "block",
        });
        const page = await context.newPage();
        const failedSubresource = new Promise((resolve) => {
          page.on("requestfailed", (request) => {
            if (request.url().endsWith("/oversized.bin")) resolve(request.failure());
          });
        });
        const response = await page.goto("http://byte-cap.awards.org/page", {
          waitUntil: "domcontentloaded",
          timeout: 10_000,
        });
        expect(response?.status()).toBe(200);
        await expect(Promise.race([
          failedSubresource,
          new Promise((_, reject) => setTimeout(
            () => reject(new Error("oversized subresource did not fail")),
            5_000,
          )),
        ])).resolves.toBeTruthy();
        const violation = proxy.policyViolationsSince(checkpoint).find((candidate) => (
          candidate.kind === "http_response" &&
          candidate.target === "byte-cap.awards.org" &&
          candidate.port === 80
        ));
        expect(violation).toMatchObject({
          kind: "http_response",
          reason: "byte_limit",
          target: "byte-cap.awards.org",
          port: 80,
          limit_bytes: 64 * 1024,
        });
        expect(violation.generation).toBeGreaterThan(checkpoint);
      } finally {
        await browser?.close().catch(() => undefined);
        await proxy.close().catch(() => undefined);
        await closeHttpServer(upstream);
      }
    },
    20_000,
  );

  it.skipIf(!browserExecutable)(
    "records private literal, private-DNS, and redirected subresources without connecting",
    async () => {
      let privateRequests = 0;
      const privateTarget = http.createServer((_request, response) => {
        privateRequests += 1;
        response.end("private content");
      });
      const publicPage = http.createServer((request, response) => {
        if (request.url === "/redirect-private") {
          response.writeHead(302, {
            location: `http://127.0.0.1:${privateTarget.address().port}/redirected-secret`,
          });
          response.end();
          return;
        }
        response.writeHead(200, { "content-type": "text/html" });
        response.end([
          "<main>award page</main>",
          `<img src="http://127.0.0.1:${privateTarget.address().port}/literal-secret">`,
          "<img src=\"http://private-dns.awards.org/dns-secret\">",
          "<img src=\"/redirect-private\">",
        ].join(""));
      });
      await listen(privateTarget);
      await listen(publicPage);
      const publicAddress = publicPage.address();
      const proxy = await startPublicNetworkProxy({
        lookupImpl: async (hostname) => [{
          address: hostname === "private-dns.awards.org" ? "10.0.0.7" : "8.8.8.8",
          family: 4,
        }],
        requestImpl: (options, callback) => http.request({
          ...options,
          hostname: "127.0.0.1",
          family: 4,
          port: publicAddress.port,
        }, callback),
        timeoutMs: 5_000,
      });
      const checkpoint = proxy.policyCheckpoint();
      let browser = null;
      try {
        browser = await chromium.launch({
          executablePath: browserExecutable,
          headless: true,
          args: captureBrowserArgs,
        });
        const context = await browser.newContext({
          proxy: { server: proxy.url, bypass: "<-loopback>" },
          serviceWorkers: "block",
        });
        const page = await context.newPage();
        const response = await page.goto("http://public-page.awards.org/page", {
          waitUntil: "networkidle",
          timeout: 10_000,
        });
        expect(response?.status()).toBe(200);
        const violations = proxy.policyViolationsSince(checkpoint).filter((candidate) => (
          candidate.reason === "public_network_policy_refusal"
        ));
        expect(violations).toEqual(expect.arrayContaining([
          expect.objectContaining({ kind: "http_policy_refusal", target: "127.0.0.1" }),
          expect.objectContaining({ kind: "http_policy_refusal", target: "private-dns.awards.org" }),
        ]));
        expect(violations.filter((candidate) => candidate.target === "127.0.0.1").length)
          .toBeGreaterThanOrEqual(2);
        expect(privateRequests).toBe(0);
      } finally {
        await browser?.close().catch(() => undefined);
        await proxy.close().catch(() => undefined);
        await closeHttpServer(publicPage);
        await closeHttpServer(privateTarget);
      }
    },
    20_000,
  );

  it.skipIf(!browserExecutable)(
    "does not fall back to a direct private connection when the proxy is unavailable",
    async () => {
      let privateRequests = 0;
      const privateTarget = http.createServer((_request, response) => {
        privateRequests += 1;
        response.end("private leak");
      });
      await listen(privateTarget);
      const privateAddress = privateTarget.address();
      const unavailableProxy = await startPublicNetworkProxy();
      const unavailableProxyUrl = unavailableProxy.url;
      await unavailableProxy.close();
      let browser = null;
      try {
        browser = await chromium.launch({
          executablePath: browserExecutable,
          headless: true,
          args: captureBrowserArgs,
        });
        const context = await browser.newContext({
          proxy: { server: unavailableProxyUrl, bypass: "<-loopback>" },
          serviceWorkers: "block",
        });
        const page = await context.newPage();
        await expect(page.goto(
          `http://127.0.0.1:${privateAddress.port}/secret`,
          { waitUntil: "domcontentloaded", timeout: 5_000 },
        )).rejects.toThrow(/ERR_PROXY_CONNECTION_FAILED/);
        expect(privateRequests).toBe(0);
      } finally {
        await browser?.close().catch(() => undefined);
        await closeHttpServer(privateTarget);
      }
    },
    15_000,
  );

  it("wires PDF, probe, main-frame, and subresource traffic to the safe boundary", () => {
    const pdfCapture = functionSource("capturePdfSource", "fetchPdfSource");
    const pdf = functionSource("fetchPdfSource", "extractPdfText");
    const pdfText = functionSource("extractPdfText", "captureSource");
    const probe = functionSource("fetchProbe", "numericHeader");
    const contextLifecycle = functionSource("restartCaptureContext", "restartBrowser");
    const launch = functionSource("launchBrowser", "createBrowserContext");
    const context = functionSource("createBrowserContext", "findInstalledBrowserExecutable");

    expect(pdf).toContain("fetchPublicHttpBuffer");
    expect(pdf).not.toContain('redirect: "follow"');
    expect(pdf).not.toContain("arrayBuffer(");
    expect(pdfCapture.indexOf("writeFileSync(pendingPdfPath, download.buffer);"))
      .toBeLessThan(pdfCapture.indexOf("extracted = await extractPdfText(download.buffer);"));
    expect(pdfCapture).toContain('status: "failed_not_baseline"');
    expect(pdfCapture).toContain("parser_cleanup_error: cleanupError || null");
    expect(pdfCapture).toContain("failure.retained_pdf_sha256 = fileHash;");
    expect(pdfCapture).toContain("pruneFailedPdfCaptureEvidence(sourceDir, { keep: 3 })");
    expect(pdfText).toContain("PDF text parsing failed:");
    expect(pdfText).toContain("if (!primaryError) throw cleanupError;");
    expect(pdfText).not.toContain('"PDF parser cleanup exceeded 5000ms.",\n      ).catch');
    expect(probe).toContain("fetchPublicHttpResponse");
    expect(probe).not.toContain('redirect: "follow"');
    expect(contextLifecycle).toContain("startPublicNetworkProxy");
    expect(contextLifecycle).toContain("maxResponseBytes: maxBrowserResponseBytes");
    expect(contextLifecycle).toContain("await closeCaptureContext(state)");
    expect(launch).not.toContain("--proxy-server");
    expect(launch).not.toContain("--host-resolver-rules");
    expect(context).toContain('proxy: networkProxy');
    expect(context).toContain('{ server: networkProxy.url, bypass: "<-loopback>" }');
    expect(context).toContain('serviceWorkers: "block"');
    expect(context).toContain("ignoreHTTPSErrors: false");
    expect(context).not.toContain("normalizePublicHttpUrl(rawUrl)");
    expect(context).toContain("private DNS answers, and unsafe redirect targets");
    expect(context).toContain('page.on("requestfailed"');
    expect(context).toContain("isBrowserTransportSecurityFailure(errorText)");
    expect(context).toContain("recordBrowserPolicyViolation");
    expect(workerSource).toContain("await finalizeCaptureNetworkBoundary({");
    expect(workerSource.indexOf("writeFileSync(pendingMetaPath"))
      .toBeLessThan(workerSource.indexOf("await finalizeCaptureNetworkBoundary({"));
    expect(workerSource.indexOf("await finalizeCaptureNetworkBoundary({"))
      .toBeLessThan(workerSource.indexOf("renameSync(pendingMetaPath, metaPath)"));
    expect(workerSource).toContain("const captureUrl = normalizePublicHttpUrl(source.url).toString();");
    expect(workerSource).toContain("response = await page.goto(captureUrl");
    expect(context).toContain("source-scoped pinned proxy");
    expect(workerSource).toContain('await restartCaptureContext(state, "source_boundary")');
    expect(workerSource.match(/\bawait fetch\(/g)).toHaveLength(1);
    expect(workerSource).toContain('parser.getText({ first: maxPdfPages })');
  });
});

function fakeDispatcherFactory() {
  return () => ({ close: vi.fn(async () => undefined) });
}

async function publicLookup() {
  return [{ address: "8.8.8.8", family: 4 }];
}

function functionSource(name, nextName) {
  const start = workerSource.indexOf(`function ${name}`);
  const end = workerSource.indexOf(`function ${nextName}`, start + 1);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return workerSource.slice(start, end);
}

function requestThroughProxy(proxy, targetUrl) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: proxy.host,
      port: proxy.port,
      method: "GET",
      path: targetUrl,
      headers: { host: new URL(targetUrl).host },
    }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode));
    });
    request.once("error", reject);
    request.end();
  });
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function closeHttpServer(server) {
  server.closeAllConnections?.();
  return new Promise((resolve) => server.close(() => resolve()));
}
