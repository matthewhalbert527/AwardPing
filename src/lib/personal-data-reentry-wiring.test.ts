import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = new URL("../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");

describe("personal-data re-entry wiring", () => {
  it("returns a minimal profile mutation response and clears re-entry only with fresh v2 fields", () => {
    const route = read("src/app/api/profile/route.ts");
    const personalData = read("src/lib/personal-data.ts");

    expect(route).toContain('.select("id")');
    expect(route).not.toContain('.select("*")');
    expect(route).toContain('personalDataStatus: "available"');
    expect(route).toContain("so no profile data was saved");
    expect(personalData).toContain("personal_data_reentry_required: false");
    expect(personalData).toContain("personal_data_reentered_at: new Date().toISOString()");
    expect(personalData).toContain('const cipherPrefix = "ap:v2"');
  });

  it("forces marked profiles through an honest re-entry screen", () => {
    const auth = read("src/lib/auth.ts");
    const onboarding = read("src/lib/onboarding.ts");
    const form = read("src/components/office-forms.tsx");
    const layout = read("src/app/dashboard/layout.tsx");

    expect(auth).toContain("personal_data_reentry_required");
    expect(onboarding).toContain("profile?.personal_data_reentry_required");
    expect(form).toContain("Your previous profile values cannot be decrypted.");
    expect(form).toContain("does not overwrite the recovery archive");
    expect(layout).toContain("profile?.personal_data_reentry_required");
    expect(layout).toContain("/dashboard/office#profile-settings");
  });

  it("exports the limitation and exact archived bytes to only the authenticated owner", () => {
    const route = read("src/app/api/privacy/export/route.ts");

    expect(route).toContain('.eq("user_id", user.id)');
    expect(route).toContain("personal_data_legacy_ciphertext_archive");
    expect(route).toContain("archivedCiphertext");
    expect(route).toContain("cannot truthfully recover the affected plaintext");
    expect(route).toContain("legacy_archive_items");
  });

  it("atomically binds archive and contact deletion to the pending request before auth deletion", () => {
    const route = read("src/app/api/privacy/delete/route.ts");

    expect(route).toContain(
      'admin.rpc("erase_personal_data_for_privacy_request"',
    );
    expect(route).toContain("p_user_id: userId");
    expect(route).toContain("p_email_hash: emailHash");
    expect(route).toContain("p_legacy_email: email");
    expect(route).toContain("p_privacy_request_id: privacyRequestId");
    expect(route).not.toContain(
      'admin.rpc("erase_personal_data_legacy_archive_for_privacy_request"',
    );
    expect(route).not.toContain("Promise.allSettled");
    expect(route).toContain("parseAppErasureMarker");
    expect(route).toContain("app_data_erasure_marker");
    expect(route).toContain("recordPrivacyRequestFailure");
    expect(route).toContain("Privacy completion CAS did not update");
    expect(route).toContain("readPrivacyRequestState");
    expect(route).toContain("deleteAuthUserAndReconcile");
    expect(route).toContain("admin.auth.admin.getUserById(userId)");
    expect(route).toContain("completion_confirmed_after_ambiguous_response");
    expect(route).toContain("completion_failed_recorded");
    expect(route).toContain("completion_unrecorded");
    expect(route.indexOf("const appErasure = await deleteAppDataForUser")).toBeLessThan(
      route.indexOf("const authDeletion = await deleteAuthUserAndReconcile"),
    );
    expect(route.indexOf("const authDeletion = await deleteAuthUserAndReconcile")).toBeLessThan(
      route.indexOf('status: "completed"', route.indexOf("let completionError")),
    );
  });

  it("normalizes every personal-data key exactly like the backfill and launch gate", () => {
    const config = read("src/lib/config.ts");

    for (const key of [
      "APP_DATA_ENCRYPTION_KEY",
      "APP_DATA_ENCRYPTION_KEY_ID",
      "APP_DATA_DECRYPTION_KEYRING_JSON",
      "APP_DATA_LOOKUP_HMAC_KEY",
      "APP_DATA_LEGACY_V1_ENCRYPTION_KEY",
    ]) {
      expect(config).toContain(`textFromEnv("${key}")`);
      expect(config).not.toContain(`process.env.${key} || ""`);
    }
  });
});
