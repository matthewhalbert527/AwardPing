#!/usr/bin/env node
const args = process.argv.slice(2);
const baseUrl = normalizeBaseUrl(
  readArg("--url") || process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000",
);
const cronSecret = readArg("--cron-secret") || process.env.CRON_SECRET || "";
const runCron = args.includes("--run-cron");

const checks = [];

await checkStatus("home page", "/", [200]);
await checkStatus("signup page", "/signup", [200]);
await checkStatus("login page", "/login", [200]);
await checkRedirect("pricing redirect", "/pricing", "/contact");
await checkRedirect("dashboard consolidation redirect", "/dashboard", "/updates");
await checkStatus("find awards page", "/award-directory", [200]);
await checkStatus("send-digests cron rejects anonymous calls", "/api/cron/send-digests", [401]);
await checkStatus(
  "public digest outbox drain rejects anonymous calls",
  "/api/cron/drain-public-digest-outbox",
  [401],
);

if (runCron) {
  if (!cronSecret) {
    record("FAIL", "Authorized cron smoke requested, but CRON_SECRET is not set.");
  } else {
    await checkStatus("authorized send-digests cron", "/api/cron/send-digests", [200], {
      headers: { authorization: `Bearer ${cronSecret}` },
      timeoutMs: 70000,
    });
  }
}

for (const check of checks) {
  console.log(`${check.status.padEnd(6)} ${check.message}`);
}

const failures = checks.filter((check) => check.status === "FAIL");
console.log("");
console.log(
  `Private beta smoke test against ${baseUrl}: ${failures.length} failure${
    failures.length === 1 ? "" : "s"
  }.`,
);

process.exitCode = failures.length ? 1 : 0;

function readArg(name) {
  const index = args.indexOf(name);
  if (index === -1) return null;
  return args[index + 1] || null;
}

function normalizeBaseUrl(value) {
  try {
    const url = new URL(value);
    return url.toString().replace(/\/$/, "");
  } catch {
    console.error(`Invalid --url value: ${value}`);
    process.exit(1);
  }
}

async function checkStatus(name, path, expectedStatuses, options = {}) {
  const response = await request(path, options);
  if (!response) return;

  if (expectedStatuses.includes(response.status)) {
    record("OK", `${name} returned ${response.status}.`);
  } else {
    record(
      "FAIL",
      `${name} returned ${response.status}; expected ${expectedStatuses.join(" or ")}.`,
    );
  }
}

async function checkRedirect(name, path, expectedLocationPart) {
  const response = await request(path);
  if (!response) return;

  const location = response.headers.get("location") || "";
  if ([301, 302, 303, 307, 308].includes(response.status) && location.includes(expectedLocationPart)) {
    record("OK", `${name} points to ${location}.`);
  } else {
    record(
      "FAIL",
      `${name} returned ${response.status} with location "${location}"; expected ${expectedLocationPart}.`,
    );
  }
}

async function request(path, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 15000);

  try {
    return await fetch(`${baseUrl}${path}`, {
      method: "GET",
      redirect: "manual",
      headers: options.headers || {},
      signal: controller.signal,
    });
  } catch (error) {
    record("FAIL", `${path} request failed: ${error instanceof Error ? error.message : "unknown error"}.`);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function record(status, message) {
  checks.push({ status, message });
}
