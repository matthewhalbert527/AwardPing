import { lstatSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, resolve } from "node:path";

/** Remove only a direct, non-linked temporary fixture with its expected prefix. */
export function removeTestDirectory(directory, prefix) {
  const target = resolve(directory);
  const parent = resolve(tmpdir());
  if (!prefix.startsWith("awardping-") || dirname(target) !== parent ||
      !basename(target).startsWith(prefix) || !lstatSync(target).isDirectory() ||
      lstatSync(target).isSymbolicLink() || realpathSync(target) !== target ||
      realpathSync(parent) !== parent) throw new Error("Unsafe test fixture cleanup target");
  rmSync(target, { recursive: true, force: true });
}
