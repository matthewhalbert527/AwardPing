import { readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(resolve(root, path), "utf8");
const installer = read("installer/windows/Install-AwardPingWorker.ps1");
const launchCheck = read("scripts/check-private-beta.mjs");
const releaseProducer = read("scripts/record-stage1-signed-release-evidence.mjs");
const maintenanceScripts = [
  "scripts/audit-shared-source-coverage.mjs",
  "scripts/backfill-low-coverage-award-sources.mjs",
  "scripts/post-crawl-cleanup-report.mjs",
  "scripts/report-broken-sources.mjs",
];

describe("Supabase new-key-only compatibility", () => {
  it("routes every privileged Node script through the secret-safe service client", () => {
    const directClientScripts = walk(resolve(root, "scripts"))
      .filter((path) => path.endsWith(".mjs") && !path.endsWith(".test.mjs"))
      .filter((path) => /import\s*\{\s*createClient\s*\}\s*from\s*["']@supabase\/supabase-js["']/.test(
        readFileSync(path, "utf8"),
      ))
      .map((path) => relative(resolve(root, "scripts"), path).replaceAll("\\", "/"));

    expect(directClientScripts).toEqual(["supabase-service-client.mjs"]);
    expect(read("src/lib/supabase/admin.ts")).toContain(
      "createSupabaseSecretKeyFetch(appConfig.supabaseServiceRoleKey)",
    );
    expect(read("scripts/repair-visual-snapshot-previous-object-keys.mjs")).toContain(
      "createSupabaseServiceClient(supabaseUrl, serviceRoleKey)",
    );
    expect(releaseProducer).toContain(
      "createSupabaseServiceClient(supabaseUrl, serviceRoleKey)",
    );
  });

  it("keeps sb_secret out of Authorization in the worker and release paths", () => {
    const headerFunction = installer.slice(
      installer.indexOf("function New-SupabaseKeyHeaders"),
      installer.indexOf("function Test-SupabaseSecretKeyAccess"),
    );
    expect(headerFunction).toContain('"apikey" = $Key');
    expect(headerFunction).not.toMatch(/Authorization|Bearer/i);
    expect(read("scripts/supabase-service-client.mjs")).toContain(
      'headers.delete("authorization")',
    );
    expect(read("scripts/lib/stage1-release-evidence-producers.mjs")).toContain(
      "authorization_header_sent: false",
    );
  });

  it("validates worker sb_secret keys without a browser-like PowerShell request", () => {
    const validationFunction = installer.slice(
      installer.indexOf("function Test-SupabaseSecretKeyAccess"),
      installer.indexOf("function Read-SupabaseSecretKey"),
    );

    expect(validationFunction).toContain("[System.Net.Http.HttpClient]::new()");
    expect(validationFunction).toContain("TryAddWithoutValidation($header.Key, $header.Value)");
    expect(validationFunction).not.toContain("Invoke-RestMethod");
    expect(validationFunction).not.toMatch(/Authorization|Bearer/i);
  });

  it("requires an sb_secret for fresh and update-only worker installs", () => {
    expect(installer).toContain("function Update-WorkerSupabaseSecretKeyForMigration");
    expect(installer).toContain(
      "Update-WorkerSupabaseSecretKeyForMigration `",
    );
    expect(installer).toContain(
      "the production worker requires an sb_secret key and cannot resume with a legacy JWT",
    );
    expect(installer).toContain(
      "Legacy Supabase JWT API keys are not accepted for the production worker",
    );
  });

  it("makes production launch and release evidence reject legacy key values", () => {
    expect(launchCheck).toContain(
      "legacy service_role JWTs are launch blockers",
    );
    expect(launchCheck).toContain("production requires sb_publishable");
    expect(releaseProducer).toContain(
      'requireKeyPrefix(serviceRoleKey, "sb_secret_", "SUPABASE_SERVICE_ROLE_KEY")',
    );
    expect(releaseProducer).toContain(
      'requireKeyPrefix(supabaseAnonKey, "sb_publishable_", "SUPABASE_ANON_KEY")',
    );
  });

  it("makes maintenance scripts fail closed instead of revealing legacy CLI keys", () => {
    for (const path of maintenanceScripts) {
      const script = read(path);
      expect(script).toContain("Automatic Supabase CLI key fallback is disabled");
      expect(script).toContain('startsWith("sb_secret_")');
      expect(script).not.toContain('key.name === "service_role"');
      expect(script).not.toContain('"projects", "api-keys"');
    }
  });

  it("binds destructive cleanup reporting to the project in the configured URL", () => {
    const cleanup = read("scripts/post-crawl-cleanup-report.mjs");
    expect(cleanup).toContain("projectRefFromSupabaseUrl(supabaseUrl)");
    expect(cleanup).toContain("requestedProjectRef !== projectRef");
    expect(cleanup).toContain("refusing to run against an ambiguous target");
    expect(cleanup).not.toContain("readLinkedProjectRef");
  });
});

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}
