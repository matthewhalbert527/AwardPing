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
const aliasAwardId = "30000000-0000-0000-0000-000000000001";
const secondAliasAwardId = "30000000-0000-0000-0000-000000000002";
const aliasSource = { ...source, id: "40000000-0000-0000-0000-000000000001", shared_award_id: aliasAwardId };
function sharedUrlManifest() {
  const m = manifest();
  // Existing negative fixtures mutate their shared roster; this fixture owns its copy.
  m.award_ids = Array.from({ length: 25 }, (_, i) => `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`);
  m.award_aliases = [{ award_id: aliasAwardId, canonical_award_id: ids[0], cohort_key: "award-0" }];
  m.sources.push({ ...m.sources[0], id: aliasSource.id, award_id: aliasAwardId });
  return m;
}

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
  it.each([false, true])("keeps both exact stored owners of a shared canonical/alias URL (reverse=%s)", reverse => {
    const m = sharedUrlManifest();
    if (reverse) m.sources.reverse();
    const bytes = JSON.stringify(m);
    expect(validateScraplingSourceManifest(m)).toBe(m);
    expect(JSON.stringify(m)).toBe(bytes);
    for (const actual of [source, aliasSource]) {
      expect(selectScraplingSource(actual, m)).toMatchObject({ id: actual.id, award_id: actual.shared_award_id, url: actual.url });
      expect(() => selectScraplingSource({ ...actual, shared_award_id: actual === source ? aliasAwardId : ids[0] }, m)).toThrow(/identity/);
      expect(() => selectScraplingSource({ ...actual, url: `${actual.url}/changed` }, m)).toThrow(/identity/);
    }
    expect(selectScraplingSource({ ...aliasSource, id: ids[2] }, m)).toBeNull();
  });
  it("allows two declared alias owners in one cohort without requiring a canonical-owner source", () => {
    const m = sharedUrlManifest();
    m.award_aliases.push({ ...m.award_aliases[0], award_id: secondAliasAwardId });
    m.sources[0] = { ...m.sources[0], award_id: secondAliasAwardId };
    expect(validateScraplingSourceManifest(m)).toBe(m);
  });
  it.each([ids[0], aliasAwardId, secondAliasAwardId])("rejects repeated owner %s even after other owners share the URL", awardId => {
    const m = sharedUrlManifest();
    m.award_aliases.push({ ...m.award_aliases[0], award_id: secondAliasAwardId });
    m.sources.push({ ...m.sources[0], id: "40000000-0000-0000-0000-000000000002", award_id: secondAliasAwardId });
    m.sources.push({ ...m.sources[0], id: "40000000-0000-0000-0000-000000000003", award_id: awardId });
    expect(() => validateScraplingSourceManifest(m)).toThrow(/duplicate/);
  });
  it.each([
    ["missing alias", m => delete m.award_aliases],
    ["unknown alias owner", m => m.sources[1].award_id = secondAliasAwardId],
    ["malformed alias", m => m.award_aliases[0].award_id = "not-a-uuid"],
    ["wrong cohort", m => m.award_aliases.push({ award_id: secondAliasAwardId, canonical_award_id: m.award_ids[1], cohort_key: "award-0" })],
    ["duplicate ID across owners", m => m.sources[1].id = m.sources[0].id],
  ])("does not waive %s for shared URLs", (_, mutate) => {
    const m = sharedUrlManifest(); mutate(m);
    expect(() => validateScraplingSourceManifest(m)).toThrow();
  });
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
  it("captures a shared URL independently for both source IDs and retains each actual owner", async () => {
    const root = mkdtempSync(join(tmpdir(), "awardping-scrapling-alias-adapter-"));
    try {
      const m = validateScraplingSourceManifest(sharedUrlManifest()), invocations = [], captures = [];
      for (const actual of [source, aliasSource]) {
        expect(selectScraplingSource(actual, m)?.id).toBe(actual.id);
        captures.push(await captureScraplingWorkerSource(actual, { archiveRoot: root, capture: async capturedSource => {
          invocations.push({ ...capturedSource });
          return { ...record(), source_id: capturedSource.id };
        } }));
      }
      expect(invocations).toEqual([source, aliasSource]);
      expect(captures[0].dir).not.toBe(captures[1].dir);
      for (const [index, capture] of captures.entries()) {
        const actual = [source, aliasSource][index], meta = JSON.parse(readFileSync(capture.meta_path, "utf8"));
        expect(meta.source).toMatchObject({ id: actual.id, shared_award_id: actual.shared_award_id, url: actual.url });
        for (const ref of Object.values(meta.files).filter(value => typeof value === "string"))
          expect(ref).toMatch(new RegExp(`^sources/${actual.id}/captures/`));
        expect(prepareR2CaptureArtifacts(collectR2CaptureArtifactFiles(capture), { readFile: readFileSync })).toBeTruthy();
      }
      expect(captures[0].image_hash).toBe(captures[1].image_hash);
      const filesBefore = captures.map(capture => readFileSync(capture.meta_path, "utf8"));
      await expect(captureScraplingWorkerSource(aliasSource, { archiveRoot: root, capture: async () => record() })).rejects.toThrow();
      expect(captures.map(capture => readFileSync(capture.meta_path, "utf8"))).toEqual(filesBefore);
    } finally { rmSync(root, { recursive: true, force: true }); }
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
