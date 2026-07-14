import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  atomicWriteJson,
  withVisualBaselineLock,
  withVisualBaselineLockAsync,
} from "./visual-baseline-lock.mjs";

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("visual baseline file locking", () => {
  it("holds one source lock through freshness re-read and atomic replacement", () => {
    const root = mkdtempSync(join(tmpdir(), "awardping-baseline-lock-"));
    roots.push(root);
    const baselinePath = join(root, "sources", "source-1", "baseline.json");
    let lockVisible = false;
    withVisualBaselineLock({
      archiveRoot: root,
      sourceId: "source-1",
      operation: ({ lockPath }) => {
        lockVisible = existsSync(lockPath);
        atomicWriteJson(baselinePath, { captured_at: "2026-07-14T20:00:00.000Z" });
      },
    });
    expect(lockVisible).toBe(true);
    expect(existsSync(join(root, "sources", "source-1", ".baseline.lock"))).toBe(false);
    expect(JSON.parse(readFileSync(baselinePath, "utf8"))).toMatchObject({
      captured_at: "2026-07-14T20:00:00.000Z",
    });
  });

  it("recovers a stale crashed owner without deleting the new owner's lock", () => {
    const root = mkdtempSync(join(tmpdir(), "awardping-baseline-lock-stale-"));
    roots.push(root);
    const lockPath = join(root, "sources", "source-1", ".baseline.lock");
    atomicWriteJson(lockPath, { token: "crashed", acquired_at_ms: 1 });
    let ownedToken = null;
    withVisualBaselineLock({
      archiveRoot: root,
      sourceId: "source-1",
      staleAfterMs: 10,
      now: () => 100,
      operation: ({ token }) => {
        ownedToken = token;
        expect(JSON.parse(readFileSync(lockPath, "utf8")).token).toBe(token);
      },
    });
    expect(ownedToken).toBeTruthy();
    expect(existsSync(lockPath)).toBe(false);
  });

  it("recovers an old empty lock left by a crash during exclusive creation", () => {
    const root = mkdtempSync(join(tmpdir(), "awardping-baseline-lock-empty-"));
    roots.push(root);
    const lockPath = join(root, "sources", "source-1", ".baseline.lock");
    mkdirSync(join(root, "sources", "source-1"), { recursive: true });
    writeFileSync(lockPath, "");
    utimesSync(lockPath, new Date(0), new Date(0));
    let ran = false;
    withVisualBaselineLock({
      archiveRoot: root,
      sourceId: "source-1",
      staleAfterMs: 10,
      now: () => 100,
      operation: () => { ran = true; },
    });
    expect(ran).toBe(true);
  });

  it("does not let a contender remove a freshly acquired owner's lock", () => {
    const root = mkdtempSync(join(tmpdir(), "awardping-baseline-lock-live-"));
    roots.push(root);
    withVisualBaselineLock({
      archiveRoot: root,
      sourceId: "source-1",
      now: () => 100,
      operation: ({ lockPath, token }) => {
        let contenderClock = 100;
        expect(() => withVisualBaselineLock({
          archiveRoot: root,
          sourceId: "source-1",
          timeoutMs: 1,
          staleAfterMs: 10,
          now: () => { contenderClock += 1; return contenderClock; },
          operation: () => null,
        })).toThrow("Timed out waiting for visual baseline lock");
        expect(JSON.parse(readFileSync(lockPath, "utf8")).token).toBe(token);
      },
    });
  });

  it("serializes async production operations for the same source", async () => {
    const root = mkdtempSync(join(tmpdir(), "awardping-baseline-lock-async-"));
    roots.push(root);
    let releaseFirst;
    let firstEntered = false;
    let secondEntered = false;
    const firstMayExit = new Promise((resolve) => { releaseFirst = resolve; });
    const first = withVisualBaselineLockAsync({
      archiveRoot: root,
      sourceId: "source-1",
      operation: async () => {
        firstEntered = true;
        await firstMayExit;
      },
    });
    while (!firstEntered) await new Promise((resolve) => setTimeout(resolve, 1));
    const second = withVisualBaselineLockAsync({
      archiveRoot: root,
      sourceId: "source-1",
      operation: () => { secondEntered = true; },
    });

    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(secondEntered).toBe(false);
    releaseFirst();
    await Promise.all([first, second]);
    expect(secondEntered).toBe(true);
  });
});
