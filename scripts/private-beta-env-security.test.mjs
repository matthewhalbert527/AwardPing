import { readFileSync } from "node:fs";
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
});
