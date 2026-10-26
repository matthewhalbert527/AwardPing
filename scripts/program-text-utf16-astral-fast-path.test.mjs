import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { parse } from "libpg-query";

const migrationUrl = new URL("../supabase/migrations/20261026174903_program_text_utf16_astral_fast_path.sql", import.meta.url);
const bmpMigrationUrl = new URL("../supabase/migrations/20261025174449_program_text_utf16_fast_path.sql", import.meta.url);
const supplementary = /[\u{10000}-\u{10FFFF}]/u;
const scalarCache = new Map();
const scalars = text => {
  if (!scalarCache.has(text)) scalarCache.set(text, [...text]);
  return scalarCache.get(text);
};
function textDomain(text) {
  if (text === null) return null;
  if (typeof text !== "string" || text.includes("\0") || !text.isWellFormed()) throw new Error("Not PostgreSQL UTF8 text");
  return text;
}
function expectedSlice(text, start, end) {
  if (textDomain(text) === null || start === null || end === null || start < 0 || end <= start || end > text.length) return null;
  const split = at => at > 0 && at < text.length && /[\uD800-\uDBFF]/u.test(text[at - 1]) && /[\uDC00-\uDFFF]/u.test(text[at]);
  return split(start) || split(end) ? null : text.slice(start, end);
}
function legacySlice(text, start, end) {
  if (textDomain(text) === null || start === null || end === null || start < 0 || end <= start) return null;
  let at = 0, first = null;
  const codepoints = scalars(text);
  for (let index = 0; index < codepoints.length; index++) {
    const size = codepoints[index].length;
    if (at === start) first = index;
    else if (at < start && at + size > start) return null;
    at += size;
    if (at === end) return first === null ? null : codepoints.slice(first, index + 1).join("");
    if (at > end) return null;
  }
  return null;
}
// Model the SQL's native BMP-run/astral matches and codepoint substr positions.
// Cache only JS scalar arrays so long-page regression checks stay inexpensive.
function astralSliceModel(text, start, end) {
  if (textDomain(text) === null || start === null || end === null || start < 0 || end <= start) return null;
  if (!supplementary.test(text)) return end > text.length ? null : text.slice(start, end);
  if (end > text.length) return null;
  let at = 0, codeStart = start, codeEnd = end;
  for (const match of text.matchAll(/([^\u{10000}-\u{10FFFF}]*)([\u{10000}-\u{10FFFF}])/gu)) {
    at += match[1].length + 2;
    if (start === at - 1 || end === at - 1) return null;
    if (start >= at) codeStart--;
    if (end >= at) codeEnd--;
    if (at >= end) break;
  }
  return scalars(text).slice(codeStart, codeEnd).join("");
}
function fixtureTexts() {
  const edge = String.fromCodePoint(1, 0x7f, 0x80, 0x7ff, 0x800, 0xd7ff, 0xe000, 0xffff, 0x10000, 0x1f44d, 0x1f44e, 0x10ffff);
  const texts = [null, "", "abc", "é — 中\nA\r\n\t", "e\u0301 café", "A😀B", "😀", "😀😀", "中😀e\u0301𐀀Z", edge,
    "👍\n\nDeadline: October 30, 2026.\n\n👎", "\u00a0\u202f\t\n\r\f\v😀\nZ", "𐀀" + String.fromCodePoint(0x10ffff) + "x"];
  let seed = 0x5d37e91b;
  const next = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
  for (let n = 0; n < 96; n++) {
    let text = "";
    for (let j = 0; j < 14; j++) {
      let cp = next() % 0x110000;
      if (cp === 0 || cp >= 0xd800 && cp <= 0xdfff) cp = 32;
      text += String.fromCodePoint(cp);
    }
    texts.push(text);
  }
  return texts;
}
function parityCases() {
  return fixtureTexts().flatMap((text, index) => {
    const length = text?.length ?? 0;
    const ranges = [[null, 1], [0, null], [-1, 1], [0, 0], [1, 1], [2, 1], [0, length], [0, length + 1],
      [length, length + 1], [0, 1], [1, 2], [2, 3], [3, 4], [length - 1, length], [length - 2, length], [2147483646, 2147483647]];
    for (const at of [0, 1, 2, Math.floor(length / 2), length - 2, length - 1]) ranges.push([at, Math.min(length, at + 2)]);
    return ranges.map(([start, end], range) => ({ id: `${index}:${range}`, text, start, end, expected: expectedSlice(text, start, end) }));
  });
}

/** Optional operator-invoked SELECT-only parity generator; never executes SQL. */
export function buildReadOnlyAstralUtf16ParitySQL() {
  const data = JSON.stringify(parityCases()).replaceAll("'", "''");
  return `WITH fixtures AS MATERIALIZED (
 SELECT value->>'id' AS id,value->>'text' AS text,(value->>'start')::integer AS start_at,
  (value->>'end')::integer AS end_at,value->>'expected' AS expected
 FROM jsonb_array_elements('${data}'::jsonb)
), checked AS MATERIALIZED (
 SELECT id,private.awardping_program_utf16_slice(text,start_at,end_at) IS NOT DISTINCT FROM expected AS matches
 FROM fixtures
)
SELECT count(*) AS fixtures,count(*) FILTER(WHERE NOT matches) AS mismatches,
 coalesce(jsonb_agg(id) FILTER(WHERE NOT matches),'[]'::jsonb) AS failed_ids FROM checked;`;
}

if (process.argv.includes("--print-readonly-parity-sql")) {
  process.stdout.write(buildReadOnlyAstralUtf16ParitySQL());
} else {
  const { describe, it, expect } = await import("vitest");
  const sql = readFileSync(migrationUrl, "utf8"), prior = readFileSync(bmpMigrationUrl, "utf8");
  const ast = await parse(sql);
  const fn = ast.stmts[0].stmt.CreateFunctionStmt;
  const option = key => fn.options.find(value => value.DefElem.defname === key)?.DefElem.arg;
  const body = option("as").List.items[0].String.sval;
  describe("private UTF16 supplementary-scalar fast path", () => {
    it("changes only the immutable strict private slice helper and retains its authority", () => {
      expect(ast.stmts).toHaveLength(3);
      expect(fn.funcname.map(value => value.String.sval).join(".")).toBe("private.awardping_program_utf16_slice");
      expect(fn.replace).toBe(true);
      expect(option("strict").Boolean.boolval).toBe(true);
      expect(option("volatility").String.sval).toBe("immutable");
      expect(option("security")).toBeUndefined();
      expect(fn.options.some(value => value.DefElem.defname === "set" && value.DefElem.arg.VariableSetStmt.name === "search_path" &&
        value.DefElem.arg.VariableSetStmt.args[0].A_Const.sval.sval === "")).toBe(true);
      expect(sql.match(/create or replace function/gi)).toHaveLength(1);
      expect(sql).not.toMatch(/\b(?:insert|update|delete|truncate|alter|drop|statement_timeout|lock_timeout|security\s+definer)\b/i);
      expect(sql).toContain("revoke all on function private.awardping_program_utf16_slice(text,integer,integer) from public,anon,authenticated");
      expect(sql).toContain("grant execute on function private.awardping_program_utf16_slice(text,integer,integer) to service_role");
    });
    it("preserves the entire BMP branch and bounds before substr", () => {
      const bmp = source => source.match(/ if p_text collate[\s\S]*?\n end if;/u)[0];
      expect(bmp(sql)).toBe(bmp(prior));
      expect(body).toContain("if p_start<0 or p_end<=p_start then return null; end if;");
      expect(body.indexOf("if p_end>char_length(p_text) then return null; end if;")).toBeLessThan(body.indexOf("return substr(p_text,p_start+1,p_end-p_start)"));
    });
    it("walks only fixed C-collated BMP runs plus astrals, with exact split rejection before conversion", () => {
      expect(body).not.toMatch(/string_to_array|foreach|ascii\(/i);
      const steps = ["p_end>private.awardping_program_utf16_length(p_text)", "for v_match in select regexp_matches(p_text collate pg_catalog.\"C\"",
        "v_at:=v_at+char_length(v_match[1])+2", "if p_start=v_at-1 or p_end=v_at-1 then return null",
        "if p_start>=v_at then v_start:=v_start-1", "if p_end>=v_at then v_end:=v_end-1", "exit when v_at>=p_end", "return substr(p_text,v_start+1,v_end-v_start)"];
      const positions = steps.map(step => body.indexOf(step));
      expect(positions.every(position => position >= 0)).toBe(true);
      expect(positions).toEqual([...positions].sort((a, b) => a - b));
      expect(body).toContain("U&'([^\\+010000-\\+10FFFF]*)([\\+010000-\\+10FFFF])','g'");
    });
    it.each([
      ["null text", null, 0, 1], ["null start", "😀", null, 2], ["null end", "😀", 0, null], ["negative start", "A😀B", -1, 2],
      ["empty zero range", "", 0, 0], ["empty positive range", "", 0, 1], ["equal endpoints", "A😀B", 1, 1], ["reversed endpoints", "A😀B", 3, 1],
      ["start outside text", "A😀B", 5, 6], ["end outside text", "A😀B", 0, 5], ["integer-limit offsets", "A😀B", 2147483646, 2147483647],
      ["start splits astral", "A😀B", 2, 3], ["end splits astral", "A😀B", 1, 2], ["complete astral", "A😀B", 1, 3],
      ["astral then BMP", "😀漢", 0, 3], ["BMP then astral", "漢😀", 0, 3], ["consecutive astrals", "😀👎", 0, 4],
      ["start at second astral", "😀👎", 2, 4], ["split second astral", "😀👎", 3, 4], ["tail after astral", "😀tail", 2, 6],
      ["CJK combining and newlines", "漢e\u0301\n😀\r\nZ", 1, 8],
    ])("preserves %s exactly", (_name, text, start, end) => {
      expect(astralSliceModel(text, start, end)).toBe(expectedSlice(text, start, end));
      expect(legacySlice(text, start, end)).toBe(expectedSlice(text, start, end));
    });
    it("matches every boundary of representative strings and fixed-seed Unicode scalars", () => {
      for (const text of fixtureTexts()) {
        const length = text?.length ?? 0;
        for (let start = -1; start <= length + 1; start++) for (let end = -1; end <= length + 1; end++) {
          assert.equal(astralSliceModel(text, start, end), expectedSlice(text, start, end));
          assert.equal(legacySlice(text, start, end), expectedSlice(text, start, end));
        }
      }
      for (const value of parityCases()) assert.equal(astralSliceModel(value.text, value.start, value.end), value.expected);
      expect(parityCases()).toHaveLength(2398);
    });
    it("retains all 536 synthetic long-page blocks and gaps with exactly two footer astrals", () => {
      let text = "";
      const blocks = [];
      for (let index = 0; index < 536; index++) {
        if (index) text += index % 3 ? "\n\n" : "\r\n\t";
        const value = index === 534 ? "👍 Yes" : index === 535 ? "👎 No" : `Section ${index}: é 漢 e\u0301. Applicants must submit complete official materials by the published deadline.`;
        const start = text.length; text += value;
        blocks.push({ start, end: text.length, text: value });
      }
      expect(scalars(text).filter(character => character.length === 2)).toHaveLength(2);
      expect(text.length).toBeGreaterThan(48000);
      let cursor = 0;
      for (const block of blocks) {
        expect(astralSliceModel(text, block.start, block.end)).toBe(block.text);
        if (cursor < block.start) expect(astralSliceModel(text, cursor, block.start)).toBe(text.slice(cursor, block.start));
        cursor = block.end;
      }
      expect(astralSliceModel(text, 0, text.length + 1)).toBeNull();
      expect(astralSliceModel(text, blocks[534].start + 1, blocks[534].end)).toBeNull();
      expect(astralSliceModel(text, blocks[535].start, blocks[535].start + 1)).toBeNull();
    });
    it("handles dense supplementary extremes, BMP tails, combining marks and line breaks", () => {
      const dense = ["😀".repeat(4096), "😀".repeat(4096) + "Deadline: January 31, 2027.",
        "é漢e\u0301😀\n".repeat(1500), String.fromCodePoint(0x10000, 0x10ffff).repeat(2048)];
      for (const text of dense) for (const [start, end] of [[0, text.length], [0, 2], [1, 2], [2, text.length], [text.length - 2, text.length], [0, text.length + 1]]) {
        expect(astralSliceModel(text, start, end)).toBe(expectedSlice(text, start, end));
      }
    });
    it.each(["\0", "a\0b", "\uD800", "\uDC00", "x\uD800y"])("refuses impossible PostgreSQL UTF8 fixture %j without changing it", text => {
      expect(() => astralSliceModel(text, 0, 1)).toThrow("Not PostgreSQL UTF8 text");
    });
    it("provides a single SELECT-only optional operator parity query without executing it", async () => {
      const query = buildReadOnlyAstralUtf16ParitySQL(), tree = await parse(query);
      expect(tree.stmts).toHaveLength(1);
      expect(tree.stmts[0].stmt.SelectStmt).toBeDefined();
      expect(query).toContain("IS NOT DISTINCT FROM expected");
      expect(query).not.toMatch(/\b(?:create|insert|update|delete|alter|drop|set|execute)\s/i);
      const source = readFileSync(new URL(import.meta.url), "utf8");
      expect(source.slice(0, source.indexOf('if (process.argv.includes("--print-readonly-parity-sql"))')))
        .not.toMatch(/\bfetch\s*\(|\.rpc\s*\(|createClient\s*\(|execSync|spawnSync|PutObject|submitProgramText/);
    });
  });
}
