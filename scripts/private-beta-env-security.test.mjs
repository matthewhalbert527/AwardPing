import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const launchCheck = readFileSync(
  new URL("./check-private-beta.mjs", import.meta.url),
  "utf8",
);

describe("private beta environment security gate", () => {
  it("requires a strong, independent personal-data encryption key", () => {
    expect(launchCheck).toContain(
      '["APP_DATA_ENCRYPTION_KEY", "personal-data encryption"]',
    );
    expect(launchCheck).toContain("encryptionKey.length < 32");
    expect(launchCheck).toContain(
      'encryptionKey === env.CRON_SECRET.trim()',
    );
    expect(launchCheck).toContain(
      "APP_DATA_ENCRYPTION_KEY must be independent from CRON_SECRET.",
    );
    expect(launchCheck).toContain(
      '["APP_DATA_ENCRYPTION_KEY_ID", "personal-data encryption key identity"]',
    );
    expect(launchCheck).toContain(
      '["APP_DATA_LOOKUP_HMAC_KEY", "stable personal-data lookup HMAC"]',
    );
    expect(launchCheck).toContain(
      "APP_DATA_LOOKUP_HMAC_KEY must be independent from encryption and cron secrets.",
    );
    expect(launchCheck).toContain(
      "No legacy v1 key is claimed; affected profiles remain honestly marked for re-entry.",
    );
  });

  it("blocks legacy Supabase API keys in production but permits an explicit development migration", () => {
    expect(launchCheck).toContain("checkSupabaseApiKeyMigration();");
    expect(launchCheck).toContain(
      "legacy service_role JWTs are launch blockers",
    );
    expect(launchCheck).toContain(
      "development migration is allowed, but production requires sb_secret",
    );
    expect(launchCheck).toContain(
      "production requires sb_publishable",
    );
    expect(launchCheck).toContain(
      "contains an sb_secret key; it would be exposed to browsers",
    );
  });

  it("requires a Resend-shaped key and non-placeholder sender", () => {
    const badKey = runLaunchCheck({ RESEND_API_KEY: "not-resend" });
    expect(badKey.status).toBe(1);
    expect(badKey.stdout).toContain(
      "RESEND_API_KEY does not have the expected Resend key shape.",
    );

    const placeholderSender = runLaunchCheck({
      ALERT_FROM_EMAIL: "AwardPing <alerts@example.com>",
    });
    expect(placeholderSender.status).toBe(1);
    expect(placeholderSender.stdout).toContain(
      "ALERT_FROM_EMAIL must be a valid non-placeholder Resend sender.",
    );
  });

  it.each([
    {
      key: "CRON_SECRET",
      value: "awardping-local-public-update-token",
      expected: "CRON_SECRET must be a long production-only random value.",
    },
    {
      key: "APP_DATA_ENCRYPTION_KEY",
      value: "awardping-local-development-personal-data-encryption-key",
      expected:
        "APP_DATA_ENCRYPTION_KEY must be a production-only random value with at least 32 characters.",
    },
    {
      key: "APP_DATA_LOOKUP_HMAC_KEY",
      value: "awardping-local-development-personal-data-lookup-key",
      expected:
        "APP_DATA_LOOKUP_HMAC_KEY must be a production-only random value with at least 32 characters.",
    },
  ])("rejects the source-known $key development fallback", ({ key, value, expected }) => {
    const result = runLaunchCheck({ [key]: value });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(`FAIL   ${expected}`);
  });

  it("accepts the exact short legacy v1 key without weakening active-key checks", () => {
    const result = runLaunchCheck({
      APP_DATA_LEGACY_V1_ENCRYPTION_KEY: "old-v1-key",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "OK     An explicit recovered legacy v1 key is configured for controlled recovery.",
    );
  });

  it.each([
    {
      label: "placeholder",
      overrides: {
        APP_DATA_LEGACY_V1_ENCRYPTION_KEY: "replace-with-recovered-key",
      },
      expected:
        "APP_DATA_LEGACY_V1_ENCRYPTION_KEY is invalid; omit it unless the exact recovered legacy key is available.",
    },
    {
      label: "active-key reuse",
      overrides: {
        APP_DATA_LEGACY_V1_ENCRYPTION_KEY:
          "v2-encryption-material-0123456789abcdef",
      },
      expected:
        "The recovered legacy v1 key must not be reused by the active encryption, lookup, or cron purpose.",
    },
  ])("rejects a $label legacy v1 value", ({ overrides, expected }) => {
    const result = runLaunchCheck(overrides);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain(`FAIL   ${expected}`);
  });
});

function runLaunchCheck(overrides = {}) {
  const directory = mkdtempSync(join(tmpdir(), "awardping-launch-check-"));
  const envPath = join(directory, ".env.production.local");
  const values = {
    NEXT_PUBLIC_APP_URL: "https://awardping.test",
    NEXT_PUBLIC_SUPABASE_URL: "https://awardping.supabase.co",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "sb_publishable_test-only-value",
    SUPABASE_SERVICE_ROLE_KEY: "sb_secret_test-only-value",
    CRON_SECRET: "cron-material-0123456789abcdefghijklmnop",
    APP_DATA_ENCRYPTION_KEY: "v2-encryption-material-0123456789abcdef",
    APP_DATA_ENCRYPTION_KEY_ID: "prod-2026-07",
    APP_DATA_LOOKUP_HMAC_KEY: "lookup-material-0123456789abcdefghijkl",
    RESEND_API_KEY: "re_test-only-value",
    ALERT_FROM_EMAIL: "AwardPing <alerts@awardping.com>",
    CONTACT_TO_EMAIL: "support@awardping.test",
    ...overrides,
  };

  try {
    writeFileSync(
      envPath,
      `${Object.entries(values)
        .map(([key, value]) => `${key}=${value}`)
        .join("\n")}\n`,
      "utf8",
    );
    const result = spawnSync(
      process.execPath,
      [
        resolve(import.meta.dirname, "check-private-beta.mjs"),
        "--env",
        envPath,
        "--production",
      ],
      {
        cwd: resolve(import.meta.dirname, ".."),
        encoding: "utf8",
        timeout: 30_000,
        windowsHide: true,
      },
    );
    if (result.error) throw result.error;
    return {
      status: result.status,
      stdout: result.stdout || "",
      stderr: result.stderr || "",
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
