import { readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(resolve(root, path), "utf8");
const installer = read("installer/windows/Install-AwardPingWorker.ps1");
const launchCheck = read("scripts/check-private-beta.mjs");
const releaseProducer = read("scripts/record-stage1-signed-release-evidence.mjs");

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
});

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}
