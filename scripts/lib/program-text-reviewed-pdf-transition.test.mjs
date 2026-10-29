import { describe, expect, it, vi } from "vitest";
import { khs2027ReviewedVisiblePdf as data } from "./fixtures/khs-2027-reviewed-visible-pdf.mjs";
import { reviewedVisiblePdfProfile } from "./program-text-reviewed-pdf.mjs";
import { reviewedPdfInitialCoverageState, reviewedPdfInitialCoverageDocument, REVIEWED_PDF_INITIAL_POLICY, REVIEWED_PDF_INITIAL_REASON } from "./program-text-reviewed-pdf-transition.mjs";
import { validateProgramTextReference } from "./program-text-artifacts.mjs";
import { monitorProgramTextSource } from "./program-text-monitor.mjs";
import { createProgramTextRepository } from "./program-text-repository.mjs";

// Only immutable reference contracts are fixture data here. A binary-proof
// success is separately exercised against the retained 2.74 MB original; unit
// tests must not depend on a developer's private evidence folder.
const source = { ...data.source }, epoch = "33333333-3333-4333-8333-333333333333";
function reference({ old = false, minute = 1, captureId = old ? "a".repeat(64) : "b".repeat(64) } = {}) {
  const profile = reviewedVisiblePdfProfile(source), prefix = `program-text/sources/${source.id}/${captureId}/`;
  const textSha = old ? "91fdc1dca7fa1478500430f80f57ecea04328cb891e2839fae24d3e4f503cd71" : "73de008251ee0ba9b5b6a37977533f4e42e10d193f7ac65748f1757049424c49";
  return { kind:"program_text",schema:"awardping.program-text-reference.v1",capture_id:captureId,source:{...source},final_url:source.url,
    captured_at:`2026-10-29T19:${String(minute).padStart(2,"0")}:00.000Z`,acquisition:"pdf_text",extractor:old?{name:"pdf-parse",version:"program-text-v1/pdf"}:profile.extractor,
    text_sha256:textSha,text_length:old?648:36517,blocks_sha256:old?"c".repeat(64):"fb3d950f0f5cae7482cbff9f9b17400954dc1f6e0eaefb94166b37d5343e6ca4",
    completeness:{status:"complete",reasons:[]},artifacts:{
      raw:{object_key:prefix+"original.pdf",sha256:profile.raw.sha256,byte_length:profile.raw.byte_length,content_type:"application/pdf"},
      text:{object_key:prefix+"text.txt",sha256:textSha,byte_length:old?648:36674,content_type:"text/plain; charset=utf-8"},
      metadata:{object_key:prefix+"metadata.json",sha256:"d".repeat(64),byte_length:old?5000:517324,content_type:"application/json"},
    } };
}
function fixture() {
  const old=reference({old:true,minute:0}), current=reference();
  return {source:{...source},epoch,current_ref:current,expected_state:{schema:"awardping.program-text-state.v1",epoch,status:"baseline_ready",
    baseline_ref:old,latest_ref:structuredClone(old),last_checked_at:old.captured_at,first_captured_at:old.captured_at,successful_checks:48}};
}

describe("finite reviewed-PDF silent first coverage",()=>{
  it("admits only the pinned historical footer and resets repeated coverage to one",()=>{
    const f=fixture(),before=structuredClone(f);expect(()=>validateProgramTextReference(f.expected_state.baseline_ref)).not.toThrow();
    const next=reviewedPdfInitialCoverageState(f);
    expect(next).toEqual({schema:"awardping.program-text-state.v1",epoch,status:"baseline_ready",baseline_ref:f.current_ref,latest_ref:f.current_ref,
      last_checked_at:f.current_ref.captured_at,first_captured_at:f.current_ref.captured_at,successful_checks:1});
    expect(f).toEqual(before);expect(REVIEWED_PDF_INITIAL_POLICY).toBe("awardping.reviewed-visible-pdf-initial-coverage.v1");
    expect(REVIEWED_PDF_INITIAL_REASON).toContain("require an independent repeat");
  });
  for(const[name,mutate]of[
    ["source ID",f=>f.source.id="11111111-1111-4111-8111-111111111111"],
    ["owner",f=>f.source.shared_award_id="11111111-1111-4111-8111-111111111111"],
    ["URL query",f=>f.source.url+="?other=1"],
    ["source title",f=>f.source.title="Other PDF"],
    ["epoch",f=>f.epoch="11111111-1111-4111-8111-111111111111"],
    ["state schema",f=>f.expected_state.schema="unknown"],
    ["pending status",f=>f.expected_state.status="awaiting_review"],
    ["different pending pair",f=>f.expected_state.latest_ref=f.current_ref],
    ["old footer digest",f=>{for(const ref of [f.expected_state.baseline_ref,f.expected_state.latest_ref]){ref.text_sha256="0".repeat(64);ref.artifacts.text.sha256=ref.text_sha256;}}],
    ["old footer length",f=>{f.expected_state.baseline_ref.text_length=649;f.expected_state.latest_ref=structuredClone(f.expected_state.baseline_ref);}],
    ["old owner",f=>{f.expected_state.baseline_ref.source.shared_award_id="11111111-1111-4111-8111-111111111111";f.expected_state.latest_ref=structuredClone(f.expected_state.baseline_ref);}],
    ["old raw SHA",f=>{f.expected_state.baseline_ref.artifacts.raw.sha256="0".repeat(64);f.expected_state.latest_ref=structuredClone(f.expected_state.baseline_ref);}],
    ["old raw byte count",f=>{f.expected_state.baseline_ref.artifacts.raw.byte_length++;f.expected_state.latest_ref=structuredClone(f.expected_state.baseline_ref);}],
    ["old final URL",f=>{f.expected_state.baseline_ref.final_url+="?other=1";f.expected_state.latest_ref=structuredClone(f.expected_state.baseline_ref);}],
    ["new raw SHA",f=>f.current_ref.artifacts.raw.sha256="0".repeat(64)],
    ["new extractor",f=>f.current_ref.extractor={name:"pdf-parse",version:"program-text-v1/pdf"}],
    ["new text digest",f=>{f.current_ref.text_sha256="0".repeat(64);f.current_ref.artifacts.text.sha256=f.current_ref.text_sha256;}],
    ["new OCR acquisition",f=>f.current_ref.acquisition="pdf_ocr"],
    ["new final URL",f=>f.current_ref.final_url+="?other=1"],
    ["equal observation time",f=>f.current_ref.captured_at=f.expected_state.last_checked_at],
    ["older observation time",f=>f.current_ref.captured_at="2026-10-28T00:00:00.000Z"],
    ["invalid last checked time",f=>f.expected_state.last_checked_at="invalid"],
    ["later state observation",f=>f.expected_state.last_checked_at="2026-10-29T20:00:00.000Z"],
  ])it("preserves state for "+name,()=>{const f=fixture();mutate(f);const before=structuredClone(f);expect(reviewedPdfInitialCoverageState(f)).toBeNull();expect(f).toEqual(before);});
  it("does not count a second reserved-profile observation as a second repair",()=>{const f=fixture();f.expected_state.baseline_ref=f.current_ref;f.expected_state.latest_ref=structuredClone(f.current_ref);f.current_ref=reference({minute:2,captureId:"e".repeat(64)});expect(reviewedPdfInitialCoverageState(f)).toBeNull();});
  it.each(["awaiting_review","held","error"])("monitor preserves a historical %s comparison before any capture/transition",async status=>{
    const f=fixture();f.expected_state.status=status;f.expected_state.latest_ref=reference({old:true,minute:1,captureId:"e".repeat(64)});f.expected_state.last_checked_at=f.expected_state.latest_ref.captured_at;
    const callbacks={readState:vi.fn(async()=>f.expected_state),capture:vi.fn(),retain:vi.fn(),verifyRetention:vi.fn(),loadCapture:vi.fn(),compareAndSetState:vi.fn(),enqueueReview:vi.fn(),transitionReviewedPdfFirstCoverage:vi.fn()};
    const r=await monitorProgramTextSource({source,epoch,callbacks});expect(r.reason).toBe("existing_review_pair_preserved");
    for(const key of ["capture","retain","loadCapture","compareAndSetState","enqueueReview","transitionReviewedPdfFirstCoverage"])expect(callbacks[key]).not.toHaveBeenCalled();
  });
  it("document construction cannot trust a plausible reference without replaying real original bytes",()=>{
    const f=fixture(),next=reviewedPdfInitialCoverageState(f);
    expect(()=>reviewedPdfInitialCoverageDocument({source,text:"Fake complete body",raw_source:{bytes:Buffer.from("%PDF-fake")}},
      {source_id:source.id,expected_state:f.expected_state,next_state:next,current_ref:f.current_ref})).toThrow();
  });
  it("repository refuses an invalid cold original before any RPC",async()=>{
    const f=fixture(),db={rpc:vi.fn()},loadCapture=vi.fn(async()=>({source,text:"Fake complete body"}));
    const repo=createProgramTextRepository(db,{loadCapture,bucket:"private-bucket"});
    await expect(repo.transitionReviewedPdfFirstCoverage({source_id:source.id,expected_state:f.expected_state,next_state:reviewedPdfInitialCoverageState(f),current_ref:f.current_ref})).rejects.toThrow();
    expect(loadCapture).toHaveBeenCalledExactlyOnceWith(f.current_ref);expect(db.rpc).not.toHaveBeenCalled();
  });
});
