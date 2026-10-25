import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "libpg-query";

const migrationUrl = new URL("../supabase/migrations/20261025174449_program_text_utf16_fast_path.sql", import.meta.url);
const originalUrl = new URL("../supabase/migrations/20261023180338_program_text_monitoring.sql", import.meta.url);
const supplementary = /[\u{10000}-\u{10FFFF}]/u;
const sqlLiteral = value => `'${JSON.stringify(value).replaceAll("'", "''")}'::jsonb`;
const name = fn => fn.funcname.map(x => x.String.sval).join(".");
const option = (fn, key) => fn.options.find(x => x.DefElem.defname === key)?.DefElem.arg;
const body = fn => option(fn, "as").List.items[0].String.sval;
const functions = ast => ast.stmts.map(x => x.stmt.CreateFunctionStmt).filter(Boolean);

// A PostgreSQL UTF8 text value cannot represent NUL or a lone surrogate.
// Refuse such fixture input rather than pretending either SQL helper accepts it.
function textDomain(text) {
  if (text === null) return null;
  if (typeof text !== "string" || text.includes("\0") || !text.isWellFormed()) throw new Error("Not PostgreSQL UTF8 text");
  return text;
}
function expectedLength(text) { return textDomain(text) === null ? null : text.length; }
function legacySlice(text, start, end) {
  if (textDomain(text) === null || start === null || end === null || start < 0 || end <= start) return null;
  let at = 0, startIndex = null, index = 0;
  const codepoints = [...text];
  for (const ch of codepoints) {
    const size = ch.codePointAt(0) > 65535 ? 2 : 1;
    if (at === start) startIndex = index;
    else if (at < start && at + size > start) return null;
    at += size;
    if (at === end) return startIndex === null ? null : codepoints.slice(startIndex, index + 1).join("");
    if (at > end) return null;
    index++;
  }
  return null;
}
function optimizedSliceModel(text, start, end) {
  if (textDomain(text) === null || start === null || end === null || start < 0 || end <= start) return null;
  if (!supplementary.test(text)) return end > [...text].length ? null : [...text].slice(start, end).join("");
  return legacySlice(text, start, end);
}
function expectedSlice(text, start, end) {
  if (textDomain(text) === null || start === null || end === null || start < 0 || end <= start || end > text.length) return null;
  const splitsPair = at => at > 0 && at < text.length && /[\uD800-\uDBFF]/.test(text[at - 1]) && /[\uDC00-\uDFFF]/.test(text[at]);
  return splitsPair(start) || splitsPair(end) ? null : text.slice(start, end);
}

function fixtureTexts() {
  const edge = String.fromCodePoint(1, 0x7f, 0x80, 0x7ff, 0x800, 0xd7ff, 0xe000, 0xffff, 0x10000, 0x1f393, 0x10ffff);
  const result = [null, "", "abc", "é — 中\nA\r\n\t", "e\u0301 café", "A😀B", "😀", "😀😀", "中😀e\u0301𐀀Z", edge];
  // Fixed-seed coverage over the whole Unicode scalar range, not just emoji.
  let seed = 0x6d2b79f5;
  const next = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
  for (let n = 0; n < 80; n++) {
    let value = "";
    for (let j = 0; j < 12; j++) {
      let cp = next() % 0x110000;
      if (cp === 0 || cp >= 0xd800 && cp <= 0xdfff) cp = 0x20;
      value += String.fromCodePoint(cp);
    }
    result.push(value);
  }
  return result;
}

export function buildReadOnlyUtf16ParitySQL() {
  const fixtures = [];
  for (const [id, text] of fixtureTexts().entries()) {
    const length = text?.length ?? 0;
    const ranges = [[null, 1], [0, null], [-1, 1], [0, 0], [1, 1], [2, 1], [0, length], [0, length + 1],
      [length, length + 1], [0, 1], [1, 2], [2, 3], [3, 4], [length - 1, length], [2147483646, 2147483647]];
    for (const [start, end] of ranges) fixtures.push({ id: `${id}:${start}:${end}`, text, start, end,
      expected_length: expectedLength(text), expected_slice: expectedSlice(text, start, end) });
  }
  return `WITH fixtures AS MATERIALIZED (
 SELECT value->>'id' AS id,value->>'text' AS text,(value->>'start')::integer AS start_at,
  (value->>'end')::integer AS end_at,(value->>'expected_length')::integer AS expected_length,value->>'expected_slice' AS expected_slice
 FROM jsonb_array_elements(${sqlLiteral(fixtures)})
), checked AS MATERIALIZED (
 SELECT id,private.awardping_program_utf16_length(text) IS NOT DISTINCT FROM expected_length AS length_matches,
  private.awardping_program_utf16_slice(text,start_at,end_at) IS NOT DISTINCT FROM expected_slice AS slice_matches
 FROM fixtures
)
SELECT count(*) AS fixtures,count(*) FILTER(WHERE NOT length_matches OR NOT slice_matches) AS mismatches,
 coalesce(jsonb_agg(id) FILTER(WHERE NOT length_matches OR NOT slice_matches),'[]'::jsonb) AS failed_ids FROM checked;`;
}

// Explicit operator-invoked generator only: reads saved private proof data but
// never opens a database, fetches a page, executes SQL or submits a model request.
export function buildReadOnlyRealProofSQL(directory, explain = false) {
  const documents = [];
  for (const cohort of ["goldwater", "hertz", "nsf_grfp"]) {
    const context = JSON.parse(readFileSync(resolve(directory, `${cohort}.json`), "utf8"));
    const proposal = JSON.parse(readFileSync(resolve(directory, `${cohort}.proposal.json`), "utf8"));
    for (const doc of context.documents) {
      documents.push({ cohort, source_id: doc.reference.source.id, text: textDomain(doc.text), length: doc.reference.text_length,
        blocks: doc.blocks.map(block => ({ text: block.text, start: block.start_utf16, end: block.end_utf16 })),
        quotes: proposal.fields.flatMap(field => field.items.flatMap(item => item.support))
          .filter(quote => quote.source_id === doc.reference.source.id).map(quote => ({ text: quote.text, start: quote.start_utf16, end: quote.end_utf16 })) });
    }
  }
  const query = `WITH documents AS MATERIALIZED (
 SELECT value->>'text' AS text,(value->>'length')::integer AS length,value->'blocks' AS blocks,value->'quotes' AS quotes
 FROM jsonb_array_elements(${sqlLiteral(documents)})
), checked AS MATERIALIZED (
 SELECT length,jsonb_array_length(blocks) AS block_count,jsonb_array_length(quotes) AS quote_count,
  private.awardping_program_utf16_length(text)=length AS length_matches,
  (SELECT bool_and(private.awardping_program_utf16_length(value->>'text')=(value->>'end')::integer-(value->>'start')::integer
   AND private.awardping_program_utf16_slice(text,(value->>'start')::integer,(value->>'end')::integer) IS NOT DISTINCT FROM value->>'text')
   FROM jsonb_array_elements(blocks)) AS blocks_match,
  (SELECT coalesce(bool_and(private.awardping_program_utf16_length(value->>'text')=(value->>'end')::integer-(value->>'start')::integer
   AND private.awardping_program_utf16_slice(text,(value->>'start')::integer,(value->>'end')::integer) IS NOT DISTINCT FROM value->>'text'),true)
   FROM jsonb_array_elements(quotes)) AS quotes_match
 FROM documents
)
SELECT count(*) AS documents,sum(length) AS text_characters,sum(block_count) AS blocks,sum(quote_count) AS quotes,
 bool_and(length_matches AND blocks_match AND quotes_match) AS all_exact FROM checked;`;
  return explain ? `EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${query}` : query;
}

const parityFlag = process.argv.includes("--print-readonly-parity-sql");
const realFlag = process.argv.indexOf("--print-readonly-real-proof-sql");
const planFlag = process.argv.indexOf("--print-readonly-real-proof-plan-sql");
if (parityFlag) {
  process.stdout.write(buildReadOnlyUtf16ParitySQL());
} else if (realFlag >= 0 || planFlag >= 0) {
  const index = realFlag >= 0 ? realFlag : planFlag;
  if (!process.argv[index + 1]) throw new Error("An explicit saved-context directory is required.");
  process.stdout.write(buildReadOnlyRealProofSQL(process.argv[index + 1], planFlag >= 0));
} else {
  const { describe, it, expect } = await import("vitest");
  const sql = readFileSync(migrationUrl, "utf8"), original = readFileSync(originalUrl, "utf8");
  const ast = await parse(sql), previous = await parse(original), current = functions(ast);
  describe("private UTF16 SQL fast path", () => {
    it("changes exactly two immutable strict private helpers and no proof or authority rules", async () => {
      expect(current.map(name)).toEqual(["private.awardping_program_utf16_length", "private.awardping_program_utf16_slice"]);
      expect(ast.stmts).toHaveLength(6);
      for (const fn of current) {
        expect(fn.replace).toBe(true);
        expect(option(fn,"strict").Boolean.boolval).toBe(true);
        expect(option(fn,"volatility").String.sval).toBe("immutable");
        expect(option(fn,"security")).toBeUndefined();
        expect(fn.options.some(x => x.DefElem.defname === "set" && x.DefElem.arg.VariableSetStmt.name === "search_path"
          && x.DefElem.arg.VariableSetStmt.args[0].A_Const.sval.sval === "")).toBe(true);
        if (option(fn,"language").String.sval === "sql") await parse(body(fn));
      }
      expect(sql).not.toMatch(/\b(?:insert|update|delete|truncate|alter|drop|statement_timeout|lock_timeout|security\s+definer)\b/i);
      expect(sql).not.toMatch(/grant\s+execute[^;]+to\s+(?:public|anon|authenticated)\b/i);
      for (const signature of ["awardping_program_utf16_length(text)","awardping_program_utf16_slice(text,integer,integer)"]) {
        expect(sql).toContain(`revoke all on function private.${signature} from public,anon,authenticated`);
        expect(sql).toContain(`grant execute on function private.${signature} to service_role`);
      }
    });
    it("preserves the entire established astral-aware loop verbatim", () => {
      const old = body(functions(previous).find(fn => name(fn).endsWith("utf16_slice")));
      const replacement = body(current.find(fn => name(fn).endsWith("utf16_slice")));
      const loop = old.slice(old.indexOf(" foreach v_ch"));
      expect(replacement.slice(replacement.indexOf(" foreach v_ch"))).toBe(loop);
      expect(replacement).toContain("if p_start<0 or p_end<=p_start then return null; end if;");
      expect(replacement.indexOf("if p_end>char_length(p_text) then return null; end if;")).toBeLessThan(replacement.indexOf("return substr(p_text,p_start+1,p_end-p_start)"));
    });
    it("counts supplementary characters natively under fixed C collation", () => {
      const length = body(current[0]), slice = body(current[1]);
      expect(length).toBe("\nselect char_length(p_text) + regexp_count(p_text collate pg_catalog.\"C\",U&'[\\+010000-\\+10FFFF]');\n");
      expect(length).not.toMatch(/unnest|string_to_array/);
      expect(slice).toContain("p_text collate pg_catalog.\"C\" !~ U&'[\\+010000-\\+10FFFF]'");
    });
    it.each(fixtureTexts().slice(0,10).map((text,index) => [index,text]))("matches JS UTF16 and the legacy loop for every boundary of fixture %s", (_index,text) => {
      const length = text?.length ?? 0;
      for (let start=-1;start<=length+1;start++) for (let end=-1;end<=length+1;end++) {
        expect(optimizedSliceModel(text,start,end)).toBe(expectedSlice(text,start,end));
        expect(legacySlice(text,start,end)).toBe(expectedSlice(text,start,end));
      }
      expect(expectedLength(text)).toBe(text?.length ?? null);
      if (text !== null) expect([...text].length + [...text].filter(ch=>supplementary.test(ch)).length).toBe(text.length);
      for (const pair of [[null,1],[0,null],[2147483646,2147483647]]) expect(optimizedSliceModel(text,...pair)).toBe(expectedSlice(text,...pair));
    });
    it("matches fixed-seed whole-Unicode scalar samples, including split surrogate boundaries", () => {
      for (const text of fixtureTexts().slice(10)) {
        for (let start=-1;start<=text.length+1;start++) for (let end=start;end<=text.length+1;end++) {
          expect(optimizedSliceModel(text,start,end)).toBe(expectedSlice(text,start,end));
          expect(legacySlice(text,start,end)).toBe(expectedSlice(text,start,end));
        }
      }
    });
    it("handles long BMP pages, CJK, combining marks and newline gaps without changing offsets", () => {
      const prefix="é — 中 e\u0301\n", text=prefix.repeat(5000)+"Deadline: October 30, 2026.";
      expect(supplementary.test(text)).toBe(false);
      for (const start of [0,1,5,9,1000,text.length-27,text.length-1]) expect(optimizedSliceModel(text,start,Math.min(start+20,text.length))).toBe(expectedSlice(text,start,Math.min(start+20,text.length)));
      expect(optimizedSliceModel(text,0,text.length+1)).toBeNull();
      const marked="😀"+text;
      expect(optimizedSliceModel(marked,1,3)).toBeNull();
      expect(optimizedSliceModel(marked,2,marked.length)).toBe(text);
    });
    it.each(["\0","a\0b","\uD800","\uDC00","x\uD800y"])("does not generate impossible PostgreSQL UTF8 fixture input %j", value => {
      expect(()=>expectedLength(value)).toThrow("Not PostgreSQL UTF8 text");
    });
    it("generates a single SELECT-only, JS-derived database parity check without executing it", async () => {
      const query=buildReadOnlyUtf16ParitySQL(), tree=await parse(query);
      expect(tree.stmts).toHaveLength(1); expect(tree.stmts[0].stmt.SelectStmt).toBeDefined();
      expect(query).toContain("IS NOT DISTINCT FROM expected_slice");
      expect(query).toContain("private.awardping_program_utf16_length");
      expect(query).not.toMatch(/\b(?:create|insert|update|delete|alter|drop|set|execute)\s/i);
    });
    it("contains no database, source-collection or model-request execution path", () => {
      const source=readFileSync(new URL(import.meta.url),"utf8");
      const implementation=source.slice(0,source.indexOf("const parityFlag"));
      expect(implementation).not.toMatch(/\bfetch\s*\(|\.rpc\s*\(|createClient\s*\(|execSync|spawnSync|PutObject|submitProgramText/);
    });
  });
}
