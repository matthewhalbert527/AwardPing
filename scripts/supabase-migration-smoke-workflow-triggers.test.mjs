import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Trigger contract for the only GitHub Actions workflow in the repository.
// Direct pushes to redesign/ui-overhaul must run the same migration smoke
// that pull requests run, on exactly the same path filters, without widening
// push coverage to any other branch. The `on:` block is parsed here with a
// small indentation-driven reader so the test needs no YAML dependency; the
// block is simple (mappings, empty mappings, and quoted string lists) and
// anything outside that shape fails loudly rather than being guessed.

const WORKFLOW_URL = new URL(
  "../.github/workflows/supabase-migration-smoke.yml",
  import.meta.url,
);
const workflowText = readFileSync(WORKFLOW_URL, "utf8").replace(/\r\n?/g, "\n");

const PUSH_BRANCH = "redesign/ui-overhaul";
const RELEVANT_PATHS = [
  ".github/workflows/supabase-migration-smoke.yml",
  "package.json",
  "package-lock.json",
  "scripts/**",
  "supabase/config.toml",
  "supabase/migrations/**",
  "supabase/tests/**",
];

function unquote(value) {
  const match = value.match(/^"(.*)"$/) ?? value.match(/^'(.*)'$/);
  return match ? match[1] : value;
}

function indentOf(line) {
  return line.length - line.trimStart().length;
}

function nextContentIndent(lines, from) {
  for (let i = from; i < lines.length; i += 1) {
    if (lines[i].trim()) return indentOf(lines[i]);
  }
  return -1;
}

// Parses one block whose entries sit at exactly `indent`. Returns the value
// (a mapping, a list of strings, or null for an empty mapping) and the index
// of the first line after the block.
function parseBlock(lines, start, indent) {
  const mapping = {};
  let list = null;
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i += 1;
      continue;
    }
    const lineIndent = indentOf(line);
    if (lineIndent < indent) break;
    if (lineIndent > indent) {
      throw new Error(`Unexpected indentation at workflow line ${i + 1}: ${line}`);
    }
    const content = line.trim();
    if (content.startsWith("- ")) {
      list ??= [];
      list.push(unquote(content.slice(2).trim()));
      i += 1;
      continue;
    }
    const entry = content.match(/^([A-Za-z_][\w-]*):(?:\s+(.*))?$/);
    if (!entry) throw new Error(`Unsupported workflow line ${i + 1}: ${line}`);
    const [, key, scalar] = entry;
    if (scalar) {
      mapping[key] = unquote(scalar.trim());
      i += 1;
      continue;
    }
    const childIndent = nextContentIndent(lines, i + 1);
    if (childIndent > indent) {
      const [value, after] = parseBlock(lines, i + 1, childIndent);
      mapping[key] = value;
      i = after;
    } else {
      mapping[key] = null;
      i += 1;
    }
  }
  if (list) {
    if (Object.keys(mapping).length > 0) {
      throw new Error(`A workflow block mixes list items and keys near line ${start + 1}.`);
    }
    return [list, i];
  }
  return [mapping, i];
}

function parseTriggers(text) {
  const lines = text.split("\n");
  const onIndex = lines.findIndex((line) => line === "on:");
  expect(onIndex, "top-level `on:` block").toBeGreaterThanOrEqual(0);
  let end = onIndex + 1;
  while (end < lines.length && (!lines[end].trim() || indentOf(lines[end]) > 0)) end += 1;
  const [triggers, after] = parseBlock(lines, onIndex + 1, 2);
  expect(after, "the `on:` block ends at the next top-level key").toBe(end);
  return triggers;
}

const triggers = parseTriggers(workflowText);

describe("supabase migration smoke workflow triggers", () => {
  it("keeps the workflow file in the plain YAML shape the trigger reader understands", () => {
    expect(workflowText).not.toMatch(/\t/);
    expect(workflowText.endsWith("\n")).toBe(true);
    expect(workflowText).toMatch(/^name: Supabase migration smoke\n/);
    expect(workflowText).toMatch(/\npermissions:\n  contents: read\n/);
  });

  it("declares exactly the push, pull_request, and workflow_dispatch triggers", () => {
    expect(Object.keys(triggers).sort()).toEqual(["pull_request", "push", "workflow_dispatch"]);
  });

  it("scopes push coverage to exactly the redesign/ui-overhaul branch", () => {
    expect(triggers.push, "push trigger").toBeTruthy();
    expect(Object.keys(triggers.push).sort()).toEqual(["branches", "paths"]);
    expect(triggers.push.branches).toEqual([PUSH_BRANCH]);
  });

  it("keeps the push path filters identical to the pull_request path filters", () => {
    expect(triggers.push?.paths).toEqual(triggers.pull_request.paths);
    expect(triggers.push?.paths).toEqual(RELEVANT_PATHS);
  });

  it("preserves the pull_request path filters and the manual dispatch trigger", () => {
    expect(Object.keys(triggers.pull_request)).toEqual(["paths"]);
    expect(triggers.pull_request.paths).toEqual(RELEVANT_PATHS);
    expect(triggers.workflow_dispatch).toBeNull();
  });
});
