import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../supabase/migrations/20260716223500_public_digest_release_binding.sql",
    import.meta.url,
  ),
  "utf8",
);
const delivery = readFileSync(
  new URL("../src/lib/public-updates.ts", import.meta.url),
  "utf8",
);
const email = readFileSync(
  new URL("../src/lib/email.ts", import.meta.url),
  "utf8",
);
const outbox = readFileSync(
  new URL(
    "../supabase/migrations/20260717004447_public_digest_outbox.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("public digest Stage 1 release binding", () => {
  it("stores one complete release identity or a fully legacy-null tuple", () => {
    expect(migration).toContain("release_epoch uuid");
    expect(migration).toContain("release_policy_version text");
    expect(migration).toContain("release_identity_hash text");
    expect(migration).toContain("provider_idempotency_key text");
    expect(migration).toContain(
      "public_update_deliveries_release_identity_check",
    );
    expect(migration).toContain("release_identity_hash ~ '^[0-9a-f]{64}$'");
  });

  it("supersedes the transitional direct-send key with a payload-hash outbox key", () => {
    expect(migration).toContain(
      "public_update_deliveries_provider_idempotency_idx",
    );
    expect(outbox).toContain(
      "provider_idempotency_key = 'awardping-public-digest:' || payload_hash",
    );
    expect(delivery).toContain("authorize_public_digest_send");
    expect(delivery).not.toContain('.from("public_update_deliveries")');
    expect(email).toContain("{ idempotencyKey: input.idempotencyKey }");
  });
});
