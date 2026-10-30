import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parse } from "libpg-query";
const oldSql=readFileSync(new URL("../supabase/migrations/20261030151153_program_award_expansion_registry.sql",import.meta.url),"utf8");
const sql=readFileSync(new URL("../supabase/migrations/20261030154351_replace_unadmitted_aauw_with_cooke.sql",import.meta.url),"utf8");
const candidates=text=>JSON.parse(text.match(/\$candidates\$([\s\S]*?)\$candidates\$/)[1]);
describe("unadmitted Cooke replacement and current Rotary source boundaries",()=>{
 it("changes only the unadmitted candidate function",async()=>{
  expect((await parse(sql)).stmts).toHaveLength(2);
  expect(sql).not.toMatch(/\b(?:insert|update|delete|truncate|alter table)\b/i);
  expect(sql).toContain("75e4534704b7ee60a452b7f1b95f7d7c9c8368cb79f2fed69b4b1f90c8227e35");
 });
 it("refuses any already admitted or registered affected identity",()=>{
  expect(sql).toContain("public.program_award_expansion_admissions where cohort_key in ('aauw_international','cooke_transfer','rotary_peace')");
  expect(sql).toContain("public.program_award_registry where cohort_key in ('aauw_international','cooke_transfer','rotary_peace')");
 });
 it("preserves the first five and the other three second-batch identities",()=>{
  const before=candidates(oldSql),after=candidates(sql);
  expect(after).toHaveLength(10);
  for(const previous of before.filter(row=>!["aauw_international","rotary_peace"].includes(row.cohort_key))){
   expect(after.find(row=>row.cohort_key===previous.cohort_key)).toEqual(previous);
  }
  expect(after.reduce((n,row)=>n+row.source_urls.length,0)).toBe(35);
  expect(after.filter(row=>row.batch===1).reduce((n,row)=>n+row.source_urls.length,0)).toBe(17);
 });
 it("limits Cooke to three accessible official applicant pages at the existing identity",()=>{
  const current=candidates(sql).find(row=>row.cohort_key==="cooke_transfer");
  expect(current).toMatchObject({batch:2,launch_rank:33,canonical_shared_award_id:"49d227e1-5a2c-4c0c-9060-2de72e4b058a",canonical_slug:"cooke-undergraduate-transfer-scholarship"});
  expect(current.source_urls).toHaveLength(3);
  expect(current.source_urls.every(url=>url.startsWith("https://www.jkcf.org/our-scholarships/undergraduate-transfer-scholarship/"))).toBe(true);
  expect(candidates(sql).some(row=>row.cohort_key==="aauw_international")).toBe(false);
 });
 it("uses current Rotary programme navigation without collecting the historical alias",()=>{
  const current=candidates(sql).find(row=>row.cohort_key==="rotary_peace");
  expect(current.official_homepage).toBe("https://www.rotary.org/en/get-involved/our-programs/peace-fellowships");
  expect(current.source_urls).toHaveLength(3);
  expect(current.source_urls.every(url=>url.startsWith(current.official_homepage))).toBe(true);
 });
});

