import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const awardRoute = read("src/app/api/shared-awards/[id]/track/route.ts");
const sourceRoute = read(
  "src/app/api/shared-awards/[id]/sources/[sourceId]/track/route.ts",
);
const trackingService = read("src/lib/shared-awards.ts");

test("tracking mutations reject cross-origin requests before setup or authentication", () => {
  for (const route of [awardRoute, sourceRoute]) {
    for (const handler of ["POST", "DELETE"]) {
      const body = handlerBody(route, handler);
      assert.ok(body.includes("isSameOriginMutationRequest(request)"));
      const setupIndex = Math.max(
        body.indexOf("hasSupabaseConfig()"),
        body.indexOf("validateSetup()"),
      );
      assert.ok(
        body.indexOf("isSameOriginMutationRequest(request)") <
          setupIndex,
      );
      assert.ok(
        body.indexOf("isSameOriginMutationRequest(request)") <
          body.indexOf("getCurrentUser()"),
      );
    }
  }
});

test("canonical Stage 1 mutations use exact member/release inputs in atomic RPCs", () => {
  for (const route of [awardRoute, sourceRoute]) {
    assert.ok(
      occurrences(
        route,
        '.in("shared_award_id", publication.memberAwardIds)',
      ) >= 1,
    );
    assert.ok(
      route.includes(
        "expectedMemberSharedAwardIds: publication.memberAwardIds",
      ),
    );
    assert.ok(
      route.includes(
        "expectedReleaseEpoch: publication.registry.release_epoch",
      ),
    );
    assert.ok(route.includes("createSupabaseServerClient()"));
  }

  assert.ok(trackingService.includes('"track_office_shared_award_atomic"'));
  assert.ok(trackingService.includes('"untrack_office_shared_award_atomic"'));
  assert.ok(
    trackingService.includes(
      '"untrack_office_shared_award_source_atomic"',
    ),
  );

  for (const route of [awardRoute, sourceRoute]) {
    const deleteBody = handlerBody(route, "DELETE");
    assert.equal(deleteBody.includes(".delete()"), false);
    assert.equal(deleteBody.includes('.from("monitors")'), false);
    assert.equal(deleteBody.includes('.from("awards")'), false);
    assert.equal(deleteBody.includes('.from("award_sources")'), false);
  }
});

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

function handlerBody(source, name) {
  const start = source.indexOf(`export async function ${name}`);
  assert.notEqual(start, -1, `${name} handler is missing`);
  const next = source.indexOf("export async function ", start + 1);
  return source.slice(start, next === -1 ? source.length : next);
}

function occurrences(value, needle) {
  return value.split(needle).length - 1;
}
