import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { atomicTasks } from "./awardping-worker-catalog.mjs";

// Neither command center may be imported here: the CLI can launch work and
// the web center starts a server. Their source text is read instead, and only
// the direct-script branch of each atomic-task argument builder is inspected.
// The maintenance branches keep the split "--env", envPath pair on purpose
// because run-awardping-maintenance.mjs accepts it; the direct branch cannot,
// because page-audit-batch launches evaluate-public-page-audit-canaries.mjs,
// whose parser reads a value only from the inline --key=value form.

function source(relative) {
  return readFileSync(new URL(relative, import.meta.url), "utf8").replace(/\r\n?/g, "\n");
}

// A top-level function from its declaration to its column-zero closing brace.
function functionText(text, name) {
  const start = text.indexOf(`function ${name}(`);
  expect(start, `function ${name}`).toBeGreaterThanOrEqual(0);
  const end = text.indexOf("\n}\n", start);
  expect(end, `end of function ${name}`).toBeGreaterThan(start);
  return text.slice(start, end + 2);
}

const INLINE_ENV_TOKEN = "`--env=${envPath}`";
const SPLIT_ENV_PAIR = /"--env",\s*envPath,/;

describe("command center direct-script env forwarding", () => {
  it("routes page-audit-batch to the consumer whose parser reads only inline --env", () => {
    const task = atomicTasks.find((candidate) => candidate.id === "page-audit-batch");
    expect(task?.run).toMatchObject({ kind: "script", applyArg: true });
    expect(task.run.args[0]).toBe("scripts/evaluate-public-page-audit-canaries.mjs");

    // parseArgs there is a pure function; evaluate only that extracted text.
    const parserText = functionText(
      source("./evaluate-public-page-audit-canaries.mjs"),
      "parseArgs",
    );
    const parseArgs = new Function(`${parserText}\nreturn parseArgs;`)();
    expect(parseArgs(["--env=.env.worker.local"]).env).toBe(".env.worker.local");
    expect(parseArgs(["--env", ".env.worker.local"]).env).toBe("true");
  });

  it("CLI atomicTaskArgs emits one inline env token after the optional apply arg", () => {
    const fn = functionText(source("./awardping-command-center.mjs"), "atomicTaskArgs");
    const directStart = fn.lastIndexOf("return [");
    expect(fn.slice(0, directStart)).toContain("scripts/run-awardping-maintenance.mjs");
    const directBranch = fn.slice(directStart);
    expect(directBranch).toMatch(
      /\.\.\.\(run\.applyArg \? \[`--apply=\$\{apply\}`\] : \[\]\),\s*`--env=\$\{envPath\}`,\s*\];/,
    );
    expect(directBranch.split(INLINE_ENV_TOKEN).length - 1).toBe(1);
    expect(directBranch).not.toMatch(SPLIT_ENV_PAIR);
  });

  it("web startAtomicTask emits one inline env token after the optional apply arg", () => {
    const fn = functionText(source("./awardping-command-center-web.mjs"), "startAtomicTask");
    const directStart = fn.indexOf("\n    : [");
    const directEnd = fn.indexOf("if (!commandArgs.length)");
    expect(directStart).toBeGreaterThan(0);
    expect(directEnd).toBeGreaterThan(directStart);
    expect(fn.slice(0, directStart)).toContain("scripts/run-awardping-maintenance.mjs");
    const directBranch = fn.slice(directStart, directEnd);
    expect(directBranch).toMatch(
      /\.\.\.\(run\.applyArg \? \["--apply=true"\] : \[\]\),\s*`--env=\$\{envPath\}`,\s*\];/,
    );
    expect(directBranch.split(INLINE_ENV_TOKEN).length - 1).toBe(1);
    expect(directBranch).not.toMatch(SPLIT_ENV_PAIR);
  });
});
