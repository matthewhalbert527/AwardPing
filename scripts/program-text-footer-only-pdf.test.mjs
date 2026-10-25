import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { parse } from "libpg-query";
import { describe, it, expect } from "vitest";
import { buildProgramTextCapture, validateProgramTextCapture, isKnownProgramTextFooterOnlyPdfReference, programTextCaptureInternals } from "./lib/program-text-capture-contract.mjs";
const source={id:"11111111-1111-4111-8111-111111111111",shared_award_id:"22222222-2222-4222-8222-222222222222",url:"https://example.org/sample.pdf"};
const pages=Array.from({length:20},(_,i)=>({num:i+1,text:`2027 KHS Sample Application\t${i+1}`}));
const projection=programTextCaptureInternals.pdfTextProjection({total:20,pages});
const digest=createHash("sha256").update(projection.text).digest("hex");
const sql=readFileSync(new URL("../supabase/migrations/20261025175832_program_text_footer_only_pdf_hold.sql",import.meta.url),"utf8");
const prior=readFileSync(new URL("../supabase/migrations/20261025172715_program_text_loading_shell_guard.sql",import.meta.url),"utf8");
const ast=await parse(sql),old=await parse(prior);
const functions=tree=>tree.stmts.map(x=>x.stmt.CreateFunctionStmt).filter(Boolean);
const name=fn=>fn.funcname.map(x=>x.String.sval).join(".");
const body=fn=>fn.options.find(x=>x.DefElem.defname==="as").DefElem.arg.List.items[0].String.sval;

describe("verified footer-only sample PDF stays incomplete",()=>{
  it("recognizes exactly the restored twenty-page text, not an arbitrary sparse PDF",()=>{
    expect(projection.text.length).toBe(648);
    expect(digest).toBe("91fdc1dca7fa1478500430f80f57ecea04328cb891e2839fae24d3e4f503cd71");
    expect(projection.completeness).toEqual({status:"incomplete",reasons:["pdf_footer_only_text"]});
    for(const acquisition of ["pdf_text","pdf_ocr"])expect(isKnownProgramTextFooterOnlyPdfReference({acquisition,text_length:648,text_sha256:digest})).toBe(true);
    for(const ref of [{acquisition:"http_html",text_length:648,text_sha256:digest},{acquisition:"pdf_text",text_length:649,text_sha256:digest},
      {acquisition:"pdf_text",text_length:648,text_sha256:"0".repeat(64)}])expect(isKnownProgramTextFooterOnlyPdfReference(ref)).toBe(false);
  });
  it("preserves explicitly incomplete evidence without pretending its form content was extracted",()=>{
    const input={source,acquisition:"pdf_text",extractor:{name:"fixture",version:"1"},raw_bytes:Buffer.from("%PDF-1.4\nTEST ONLY"),content_type:"application/pdf",...projection};
    const incomplete=buildProgramTextCapture(input);
    expect(validateProgramTextCapture(incomplete)).toBe(incomplete);
    expect(()=>buildProgramTextCapture({...input,completeness:{status:"complete",reasons:[]}})).toThrow("pdf_footer_only_text");
    const genuine=programTextCaptureInternals.pdfTextProjection({total:1,pages:[{num:1,text:"Applications close October 30, 2026."}]});
    expect(genuine.completeness.status).toBe("complete");
  });
  it("matches SQL and JS quality holds without altering source state, raw evidence or authority",()=>{
    const helper=functions(ast).find(fn=>name(fn).endsWith("known_footer_only_pdf"));
    expect(body(helper)).toContain(digest);expect(body(helper)).toContain("p_ref->>'text_length'='648'");
    expect(body(helper)).toContain("('pdf_text','pdf_ocr')");
    for(const suffix of ["awardping_program_fact_validation_valid","awardping_program_fact_source_ready"]){
      const n="private."+suffix,oldBody=body(functions(old).find(fn=>name(fn)===n)),newBody=body(functions(ast).find(fn=>name(fn)===n));
      const anchor=suffix.endsWith("source_ready")?"and not private.awardping_program_fact_known_html_shell(v_ref)":"if private.awardping_program_fact_known_html_shell(v_ref)";
      const added=suffix.endsWith("source_ready")?"\n  and not private.awardping_program_fact_known_footer_only_pdf(v_ref)":"\n   or private.awardping_program_fact_known_footer_only_pdf(v_ref)";
      expect(newBody).toBe(oldBody.replace(anchor,anchor+added));
    }
    expect(sql).not.toMatch(/\b(?:update|insert\s+into|delete\s+from|drop|alter\s+table|security\s+definer)\b/i);
    expect(sql).toContain("from public,anon,authenticated");expect(sql).toContain("to service_role");
    expect(sql).not.toMatch(/grant\s+execute[^;]+to\s+(?:public|anon|authenticated)\b/i);
  });
});
