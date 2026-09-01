import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const workerSource = readFileSync(
  resolve(import.meta.dirname, "capture-visual-snapshots.mjs"),
  "utf8",
);

describe("scheduled visual source inventory worker wiring", () => {
  it("independently enumerates an exact active/open inventory before capture", () => {
    expect(workerSource).toContain("loadAuthoritativeScheduledSourceInventory()");
    expect(workerSource).toContain('{ count: "exact", head: true }');
    expect(workerSource).toContain('.eq("shared_awards.status", "active")');
    expect(workerSource).toContain('.eq("admin_review_status", "open")');
    expect(workerSource).toContain('.order("id", { ascending: true })');
    expect(workerSource).toContain('.gt("id", lastSourceId)');
    expect(workerSource).toContain(
      "authoritativeInventory.filter(sourceMatchesShard).slice(0, limit)",
    );

    const proofLoad = workerSource.indexOf("const authoritativeInventory = isScheduledNightlyVisualRun");
    const captureLoop = workerSource.indexOf("if (visualWebConcurrency > 1)");
    expect(proofLoad).toBeGreaterThan(0);
    expect(captureLoop).toBeGreaterThan(proofLoad);
  });

  it("persists and fails closed on the count/hash comparison", () => {
    expect(workerSource).toContain("buildVisualSourceInventoryProof({");
    expect(workerSource).toContain("source_inventory: report.source_inventory || null");
    expect(workerSource).toContain("if (!report.source_inventory.proof_complete)");
    expect(workerSource).toContain("Scheduled source inventory proof failed:");
  });

  it("routes every inventory count/enumeration error through describeSupabaseError", () => {
    for (const action of [
      '"count authoritative scheduled source inventory"',
      '"recount authoritative scheduled source inventory"',
      '"enumerate authoritative scheduled source inventory"',
    ]) {
      const actionIndex = workerSource.indexOf(action);
      expect(actionIndex).toBeGreaterThan(-1);
      const describeIndex = workerSource.lastIndexOf("describeSupabaseError(", actionIndex);
      expect(actionIndex - describeIndex).toBeLessThan(120);
    }
    expect(workerSource).not.toContain("error.message || String(error)");
    expect(workerSource).not.toContain("error?.message || String(error)");
    expect(workerSource).toContain('"record visual review candidate run observations"');
  });

  it("serializes message-less Supabase error objects instead of rendering [object Object]", () => {
    const describeSupabaseError = executableDescribeSupabaseError();

    const messageless = describeSupabaseError(
      { status: 502, statusText: "Bad Gateway" },
      "count authoritative scheduled source inventory",
    );
    expect(messageless).not.toContain("[object Object]");
    expect(messageless).toContain('"status":502');
    expect(messageless).toContain('"statusText":"Bad Gateway"');
    expect(messageless).toContain("while trying to count authoritative scheduled source inventory.");

    expect(describeSupabaseError({}, "count authoritative scheduled source inventory"))
      .toBe("Supabase returned an error object with no message. while trying to count authoritative scheduled source inventory.");

    expect(describeSupabaseError(
      {
        message: "canceling statement due to statement timeout",
        details: "query ran too long",
        hint: "narrow the filter",
        code: "57014",
      },
      "count authoritative scheduled source inventory",
    )).toBe(
      "canceling statement due to statement timeout query ran too long narrow the filter (57014) while trying to count authoritative scheduled source inventory.",
    );
  });
});

function executableDescribeSupabaseError() {
  const body = functionBody(workerSource, "supabaseErrorMessageText", "hashText");
  return Function(
    "supabaseUrl",
    `${body}\nreturn describeSupabaseError;`,
  )("https://example.supabase.co");
}

function functionBody(source, name, nextName) {
  const start = source.indexOf(`function ${name}`);
  const asyncStart = source.indexOf(`async function ${name}`);
  const resolvedStart = start === -1 ? asyncStart : asyncStart === -1 ? start : Math.min(start, asyncStart);
  if (resolvedStart === -1) throw new Error(`Missing function ${name}`);
  const nextFunction = source.indexOf(`function ${nextName}`, resolvedStart + 1);
  const nextAsyncFunction = source.indexOf(`async function ${nextName}`, resolvedStart + 1);
  const candidates = [nextFunction, nextAsyncFunction].filter((value) => value > resolvedStart);
  const end = candidates.length ? Math.min(...candidates) : source.length;
  return source.slice(resolvedStart, end);
}
