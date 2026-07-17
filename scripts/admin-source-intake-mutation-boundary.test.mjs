import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

for (const [relativePath, handler] of [
  ["src/app/api/admin/source-intake/route.ts", "POST"],
  ["src/app/api/admin/source-intake/[id]/route.ts", "PATCH"],
]) {
  test(`${handler} ${relativePath} rejects cross-origin requests before setup or authentication`, () => {
    const body = handlerBody(read(relativePath), handler);
    const originIndex = body.indexOf("validateSameOriginAdminMutation(request)");

    assert.notEqual(originIndex, -1, "same-origin validation is missing");
    assert.ok(originIndex < body.indexOf("validateAdminRequest()"));
  });
}

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

function handlerBody(source, name) {
  const start = source.indexOf(`export async function ${name}`);
  assert.notEqual(start, -1, `${name} handler is missing`);
  const next = source.indexOf("export async function ", start + 1);
  return source.slice(start, next === -1 ? source.length : next);
}
