import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, readFileSync, readdirSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { beforeAll, describe, expect, it } from "vitest";
import { SCRAPLING_WORKER_PROFILE, validateScraplingSourceManifest, selectScraplingSource,
  assertScraplingBaselineCompatibility, scraplingReviewText, captureScraplingWorkerSource } from "./scrapling-worker.mjs";
import { prepareR2CaptureArtifacts, collectR2CaptureArtifactFiles } from "./r2-capture-artifact-bindings.mjs";
const hash = value => createHash("sha256").update(value).digest("hex");
const ids = Array.from({length:25},(_,i)=>`00000000-0000-0000-0000-${String(i).padStart(12,"0")}`);
const source = { id: "10000000-0000-0000-0000-000000000000", shared_award_id: ids[0], url: "https://example.edu/award", page_type: "eligibility" };
const time = "2026-10-15T12:00:00.000Z";
const text = "Award rules. Applicants must be juniors. The deadline is October 31, 2026.";
let jpeg;
beforeAll(async()=>{jpeg=await sharp({create:{width:1280,height:900,channels:3,background:"white"}}).jpeg().toBuffer();});
function doc() { return {schema:"awardping.scrapling-html-document.v1",scope:"html-source-main-document",source_url:source.url,
  title:"Award rules",text,publishable:false,visibility_verified:false,
  blocks:[{kind:"paragraph",text,heading_path:[],list_path:[],table_row:[]}],
  links:[{text:"Apply",raw_href:"/apply.pdf",source_url:source.url,base_hrefs:[],heading_path:[],list_path:[]}],base_hrefs:[],limitations:["Hidden text may be stale."]}; }
function record() { return {schema:"awardping.scrapling-capture.v1",capture_profile:SCRAPLING_WORKER_PROFILE,
  source_id:source.id,url:source.url,final_url:source.url,captured_at:time,status_code:200,content_type:"text/html",
  html:`<!doctype html><html><body><p>${text}</p></body></html>`,visible_html:`<ap-document>${text}</ap-document>`,text,
  document:{schema:"awardping.scrapling-document.v1",scope:"whole-visible-main-document",title:"Award rules",text,blocks:doc().blocks,
    links:[{text:"Apply",url:"https://example.edu/apply.pdf",heading_path:[],list_path:[]}],limitations:[]},
  html_document:doc(),html_links:[],readiness:{ready_state:"complete",fonts_status:"loaded",stable:true,samples:3,stable_ms:1000},warnings:[],engine:{scrapling:"0.4.15"},
  screenshot:{schema:"awardping.scrapling-screenshot.v1",mime_type:"image/jpeg",source_url:source.url,base64:jpeg.toString("base64"),
    sha256:hash(jpeg),byte_length:jpeg.length,width:1280,height:900,captured_at:time,full_page:true,geometry_status:"unavailable",
    alignment:"not_verified",semantics_bracketed:true,limitations:[]}}; }
function manifest() {return {schema:"awardping.scrapling-source-manifest.v1",profile:SCRAPLING_WORKER_PROFILE,reviewed_at:time,
  award_ids:ids,sources:[{id:source.id,award_id:source.shared_award_id,url:source.url,kind:"html",roles:["eligibility"]}]};}

describe("exact reviewed source scope",()=>{
  it("opts in exact source UUID/award/URL only and defaults off",()=>{
    expect(selectScraplingSource(source,null)).toBeNull();
    expect(selectScraplingSource(source,validateScraplingSourceManifest(manifest()))).toMatchObject({id:source.id});
    expect(selectScraplingSource({...source,id:ids[2]},manifest())).toBeNull();
  });
  it.each(["url","shared_award_id","page_type"])("rejects a changed live %s",key=>{
    expect(()=>selectScraplingSource({...source,[key]:key==="page_type"?"pdf":"changed"},manifest())).toThrow();
  });
  it.each([
    ["duplicate ID",m=>m.sources.push({...m.sources[0]})],
    ["duplicate URL",m=>m.sources.push({...m.sources[0],id:ids[2]})],
    ["missing award",m=>m.award_ids.pop()],
    ["duplicate award",m=>m.award_ids[1]=m.award_ids[0]],
    ["unknown award",m=>m.sources[0].award_id=source.id],
    ["private URL",m=>m.sources[0].url="http://127.0.0.1/"],
    ["PDF",m=>m.sources[0].kind="pdf"],
    ["missing role",m=>m.sources[0].roles=[]],
    ["unknown schema",m=>m.schema="legacy"],
  ])("rejects %s",(_,mutate)=>{const m=manifest();mutate(m);expect(()=>validateScraplingSourceManifest(m)).toThrow();});
  it("blocks profile migration AND rollback without a baseline-only run",()=>{
    expect(()=>assertScraplingBaselineCompatibility({capture_profile:"stable-daily"},{useScrapling:true})).toThrow();
    expect(()=>assertScraplingBaselineCompatibility({capture_profile:SCRAPLING_WORKER_PROFILE},{useScrapling:false})).toThrow();
    expect(()=>assertScraplingBaselineCompatibility({capture_profile:"stable-daily"},{useScrapling:true,baselineRefresh:true})).not.toThrow();
    expect(()=>assertScraplingBaselineCompatibility({capture_profile:SCRAPLING_WORKER_PROFILE},{useScrapling:true})).not.toThrow();
  });
});

describe("full HTML evidence contract",()=>{
  it.each(["text","title","blocks","links","base_hrefs"])("retains changed %s in review evidence",field=>{
    const a=doc(),b=doc();b[field]=typeof b[field]==="string"?`${b[field]} changed`:[...b[field],{change:"new"}];
    expect(scraplingReviewText(a)).not.toBe(scraplingReviewText(b));
  });
  it("retains body qualifications and hidden rules without claiming visibility",()=>{
    const d=doc();d.text+=" Hidden FAQ: applicants must be citizens.";
    expect(scraplingReviewText(d)).toContain("Hidden FAQ: applicants must be citizens.");
    expect(scraplingReviewText(d)).toContain("not screenshot locations");
  });
  it("preserves significant repeated whitespace inside raw link/base attributes",()=>{
    const a=doc(),b=doc();a.links[0].raw_href="?program=arts  science";b.links[0].raw_href="?program=arts science";
    expect(scraplingReviewText(a)).not.toBe(scraplingReviewText(b));
    a.base_hrefs=["https://example.edu/arts  science/"];b.base_hrefs=["https://example.edu/arts science/"];
    expect(scraplingReviewText(a)).not.toBe(scraplingReviewText(b));
  });
  it("seals existing artifact slots, binds HTML and never supplies fake geometry",async()=>{
    const root=mkdtempSync(join(tmpdir(),"awardping-scrapling-adapter-"));
    try {
      let options;
      const capture=await captureScraplingWorkerSource(source,{archiveRoot:root,capture:async(_,o)=>{options=o;return record();}});
      expect(options.captureProfile).toBe(SCRAPLING_WORKER_PROFILE);
      expect(capture.text).toContain(text);
      expect(capture.layout_path).toBeNull();
      expect(capture.html_capture.screenshot_alignment).toBe("not_verified");
      const meta=JSON.parse(readFileSync(capture.meta_path,"utf8"));
      expect(meta.source.id).toBe(source.id);
      expect(meta.files.html).toContain("page.html.txt");
      expect(hash(readFileSync(capture.html_path))).toBe(meta.html_capture.sha256);
      expect(collectR2CaptureArtifactFiles(capture).map(x=>x.name)).toEqual(["page","thumb","text","html","meta"]);
      const prepared=prepareR2CaptureArtifacts(collectR2CaptureArtifactFiles(capture),{readFile:readFileSync});
      expect(prepared).toBeTruthy();
      await expect(captureScraplingWorkerSource(source,{archiveRoot:root,capture:async()=>record()})).rejects.toThrow();
    } finally {rmSync(root,{recursive:true,force:true});}
  });
  it("does not write an evidence bundle after a failed collector",async()=>{
    const root=mkdtempSync(join(tmpdir(),"awardping-scrapling-adapter-"));
    try {
      await expect(captureScraplingWorkerSource(source,{archiveRoot:root,capture:async()=>{throw new Error("network boundary rejected");}})).rejects.toThrow();
      expect(readdirSync(root)).toEqual([]);
    } finally {rmSync(root,{recursive:true,force:true});}
  });
  it("rejects archive junction escape before evidence files are written",async()=>{
    const root=mkdtempSync(join(tmpdir(),"awardping-scrapling-adapter-"));
    const outside=mkdtempSync(join(tmpdir(),"awardping-scrapling-outside-"));
    try {
      mkdirSync(join(root,"sources"));
      symlinkSync(outside,join(root,"sources",source.id),"junction");
      await expect(captureScraplingWorkerSource(source,{archiveRoot:root,capture:async()=>record()})).rejects.toThrow("escaped archive");
      expect(readdirSync(outside)).toEqual([]);
    } finally {rmSync(root,{recursive:true,force:true});rmSync(outside,{recursive:true,force:true});}
  });
});
