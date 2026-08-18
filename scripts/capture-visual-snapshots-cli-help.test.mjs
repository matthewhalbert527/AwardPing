import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const script = resolve(root, "scripts", "capture-visual-snapshots.mjs");

describe("visual snapshot worker CLI help", () => {
  it.each(["--help", "--h"])(
    "exits safely for %s without requiring runtime credentials",
    (flag) => {
      const env = { ...process.env };
      delete env.NEXT_PUBLIC_SUPABASE_URL;
      delete env.SUPABASE_SERVICE_ROLE_KEY;
      delete env.R2_ACCOUNT_ID;
      delete env.R2_ACCESS_KEY_ID;
      delete env.R2_SECRET_ACCESS_KEY;

      const result = spawnSync(process.execPath, [script, flag], {
        cwd: root,
        env,
        encoding: "utf8",
        timeout: 20_000,
      });

      expect(result.status).toBe(0);
      expect(result.signal).toBeNull();
      expect(result.stdout).toContain("AwardPing visual snapshot worker");
      expect(result.stdout).toContain("This command performs work unless --help is supplied.");
      expect(result.stderr).not.toContain("NEXT_PUBLIC_SUPABASE_URL");
      expect(result.stderr).not.toContain("Required R2 configuration is missing");
    },
    30_000,
  );
});
