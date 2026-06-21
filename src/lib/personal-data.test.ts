import { describe, expect, it } from "vitest";
import {
  decryptPersonalData,
  encryptPersonalData,
  encryptedEmailFields,
  personalDataLookupHash,
} from "@/lib/personal-data";

describe("personal data encryption", () => {
  it("encrypts values without storing plaintext", () => {
    const encrypted = encryptPersonalData("advisor@example.edu");

    expect(encrypted).toMatch(/^ap:v1:/);
    expect(encrypted).not.toContain("advisor@example.edu");
    expect(decryptPersonalData(encrypted)).toBe("advisor@example.edu");
  });

  it("uses stable keyed hashes for normalized email lookup", () => {
    const first = encryptedEmailFields("Advisor@Example.edu ");
    const second = personalDataLookupHash("advisor@example.edu");

    expect(first.email).toBe("advisor@example.edu");
    expect(first.email_hash).toBe(second);
    expect(first.email_encrypted).not.toContain("advisor@example.edu");
  });
});
