import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { describe, it, expect } from "vitest";
import { parse } from "libpg-query";
import { isKnownProgramTextHtmlShellReference } from "./lib/program-text-capture-contract.mjs";

const old = readFileSync(new URL("../supabase/migrations/20261025161903_program_text_fact_reviews.sql", import.meta.url), "utf8");
const sql = readFileSync(new URL("../supabase/migrations/20261025172715_program_text_loading_shell_guard.sql", import.meta.url), "utf8");
const ast = await parse(sql), originalAst = await parse(old);
const functions = tree => tree.stmts.map(x => x.stmt.CreateFunctionStmt).filter(Boolean);
const name = fn => fn.funcname.map(x => x.String.sval).join(".");
const option = (fn, key) => fn.options.find(x => x.DefElem.defname === key)?.DefElem.arg;
const body = fn => option(fn, "as").List.items[0].String.sval;
const edits = {
  "private.awardping_program_fact_validation_valid": ["if not private.awardping_program_source_allowed(v_source.id)",
    "if private.awardping_program_fact_known_html_shell(v_ref)\n   or not private.awardping_program_source_allowed(v_source.id)"],
  "private.awardping_program_fact_source_ready": ["and private.awardping_program_text_reference_valid(v_ref)",
    "and private.awardping_program_text_reference_valid(v_ref)\n  and not private.awardping_program_fact_known_html_shell(v_ref)"],
  "private.awardping_program_fact_review_current": ["if not private.awardping_program_source_allowed(v_source.id)",
    "if not private.awardping_program_fact_source_ready(v_source.id)\n   or not private.awardping_program_source_allowed(v_source.id)"],
};

describe("historical loading-shell factual-readiness hold", () => {
  it("binds the exact verified original instead of inventing a length threshold", () => {
    const text = "Loading... Skip to page contentSkip to chat Skip to page contentSkip to chat";
    const sha = createHash("sha256").update(text).digest("hex");
    const fn = functions(ast).find(fn => name(fn) === "private.awardping_program_fact_known_html_shell");
    expect(text.length).toBe(76); expect(body(fn)).toContain(sha);
    expect(body(fn)).toContain("p_ref->>'text_length'='76'");
    expect(body(fn)).toContain("('http_html','rendered_html')");
    for (const acquisition of ["http_html", "rendered_html"]) expect(isKnownProgramTextHtmlShellReference({acquisition,text_length:76,text_sha256:sha})).toBe(true);
    for (const ref of [{acquisition:"pdf_text",text_length:76,text_sha256:sha},{acquisition:"http_html",text_length:77,text_sha256:sha},
      {acquisition:"http_html",text_length:76,text_sha256:"0".repeat(64)}]) expect(isKnownProgramTextHtmlShellReference(ref)).toBe(false);
  });
  it("preserves all existing proof, quote, ownership, stale approval and atomic release checks", () => {
    for (const [key, [before, after]] of Object.entries(edits)) {
      const original = functions(originalAst).find(fn => name(fn) === key), replacement = functions(ast).find(fn => name(fn) === key);
      expect(body(replacement)).toBe(body(original).replace(before, after));
      expect(replacement.replace).toBe(true);
    }
    expect(functions(ast)).toHaveLength(4);
    expect(sql).not.toMatch(/\b(?:update|insert\s+into|delete\s+from|drop|alter\s+table|security\s+definer)\b/i);
  });
  it("keeps the helper private and leaves all capture histories and source states untouched", async () => {
    expect(sql).toContain("revoke all on function private.awardping_program_fact_known_html_shell(jsonb) from public,anon,authenticated");
    expect(sql).toContain("grant execute on function private.awardping_program_fact_known_html_shell(jsonb) to service_role");
    expect(sql).not.toMatch(/grant\s+execute[^;]+to\s+(?:public|anon|authenticated)\b/i);
    for (const fn of functions(ast)) {
      expect(fn.options.some(x => x.DefElem.defname === "set" && x.DefElem.arg.VariableSetStmt.name === "search_path")).toBe(true);
      if (option(fn,"language").String.sval === "sql") await parse(body(fn));
    }
  });
});
