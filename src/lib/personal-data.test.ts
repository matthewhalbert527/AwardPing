import crypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import {
  decryptPersonalData,
  decryptProfileFields,
  encryptPersonalData,
  encryptedEmailFields,
  personalDataLookupHash,
  readPersonalData,
} from "@/lib/personal-data";
import { appConfig } from "@/lib/config";

describe("personal data encryption", () => {
  it("encrypts values without storing plaintext", () => {
    const encrypted = encryptPersonalData("advisor@example.edu");

    expect(encrypted).toMatch(/^ap:v2:local-dev:/);
    expect(encrypted).not.toContain("advisor@example.edu");
    expect(decryptPersonalData(encrypted)).toBe("advisor@example.edu");
  });

  it("uses stable keyed hashes for normalized email lookup", () => {
    const first = encryptedEmailFields("Advisor@Example.edu ");
    const second = personalDataLookupHash("advisor@example.edu");

    expect(first.email).toBe("advisor@example.edu");
    expect(first.email_hash).toBe(second);
    expect(first.email_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(first.email_encrypted).not.toContain("advisor@example.edu");
  });

  it("fails closed when the legacy key is unavailable", () => {
    const read = readPersonalData(
      `ap:v1:${Buffer.alloc(12).toString("base64url")}:${Buffer.alloc(16).toString("base64url")}:YQ`,
    );

    expect(read).toMatchObject({
      status: "unavailable",
      format: "ap:v1",
      reason: "legacy_key_unavailable",
      value: null,
    });
  });

  it("fails closed on an unknown v2 key ID", () => {
    const read = readPersonalData(
      `ap:v2:retired-key:${Buffer.alloc(12).toString("base64url")}:${Buffer.alloc(16).toString("base64url")}:YQ`,
    );

    expect(read).toMatchObject({
      status: "unavailable",
      format: "ap:v2",
      keyId: "retired-key",
      reason: "unknown_key_id",
      value: null,
    });
  });

  it("returns an honest re-entry DTO without returning ciphertext", () => {
    const legacy = `ap:v1:${Buffer.alloc(12).toString("base64url")}:${Buffer.alloc(16).toString("base64url")}:YQ`;
    const profile = decryptProfileFields({
      full_name: null,
      organization: null,
      full_name_encrypted: legacy,
      organization_encrypted: legacy,
      personal_data_reentry_required: true,
      personal_data_reentry_reason: "legacy_v1_key_unavailable",
    });

    expect(profile).toMatchObject({
      full_name: null,
      organization: null,
      personal_data_status: "reentry_required",
      personal_data_unavailable_fields: ["full_name", "organization"],
      personal_data_unavailable_reasons: ["legacy_key_unavailable"],
    });
    expect(profile).not.toHaveProperty("full_name_encrypted");
    expect(profile).not.toHaveProperty("organization_encrypted");
  });

  it("reports an exact recovered legacy value without treating it as migrated", () => {
    const legacyMaterial = "recovered-legacy-material-000000000000000000000";
    const previous = appConfig.dataLegacyV1EncryptionKey;
    appConfig.dataLegacyV1EncryptionKey = legacyMaterial;
    try {
      const profile = decryptProfileFields({
        full_name: null,
        organization: null,
        full_name_encrypted: encryptLegacyV1("Advisor Example", legacyMaterial),
        organization_encrypted: encryptLegacyV1(
          "Example University",
          legacyMaterial,
        ),
        personal_data_reentry_required: true,
        personal_data_reentry_reason: "legacy_v1_key_unavailable",
      });

      expect(profile).toMatchObject({
        full_name: "Advisor Example",
        organization: "Example University",
        personal_data_reentry_required: true,
        personal_data_status: "legacy_recovery_available",
        personal_data_legacy_recovery_available: true,
        personal_data_unavailable_fields: [],
      });
    } finally {
      appConfig.dataLegacyV1EncryptionKey = previous;
    }
  });

  it("recovers with the exact short legacy material used by the retired v1 writer", () => {
    const legacyMaterial = "old-v1-key";
    const previous = appConfig.dataLegacyV1EncryptionKey;
    appConfig.dataLegacyV1EncryptionKey = legacyMaterial;
    try {
      expect(
        readPersonalData(encryptLegacyV1("Recovered exactly", legacyMaterial)),
      ).toMatchObject({
        status: "available",
        value: "Recovered exactly",
        format: "ap:v1",
      });
    } finally {
      appConfig.dataLegacyV1EncryptionKey = previous;
    }
  });

});

function encryptLegacyV1(value: string, material: string) {
  const iv = crypto.randomBytes(12);
  const key = crypto.createHash("sha256").update(material).digest();
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final(),
  ]);
  return [
    "ap:v1",
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(":");
}
