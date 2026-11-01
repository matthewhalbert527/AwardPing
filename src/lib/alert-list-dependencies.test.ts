import {expect,it,vi} from "vitest";
const m=vi.hoisted(()=>({evidenceLoaded:vi.fn(),verify:vi.fn(),rpc:vi.fn(),from:vi.fn()}));
vi.mock("server-only",()=>({}));
vi.mock("@/lib/supabase/admin",()=>({createSupabaseAdminClient:()=>({rpc:m.rpc,from:m.from})}));
vi.mock("@/lib/alert-evidence.server",()=>{m.evidenceLoaded();return{verifySavedAlertEvidence:m.verify};});
import {loadPendingAndApprovedAlertReviews,verifyPendingAlertReview} from "./alert-review.server";
it("keeps private R2/PDF verification lazy for list GETs, but loads it before a real decision check",async()=>{
  const id="10000000-0000-4000-8000-000000000001",hash="a".repeat(64),details={private:"decision-only"};
  m.from.mockImplementation(()=>({select(){return this;},eq(){return this;},order(){return this;},limit:async()=>({data:[],error:null}),single:async()=>({data:{id,content_hash:hash,status:"pending",details},error:null})}));
  expect(await loadPendingAndApprovedAlertReviews()).toEqual({pending:[],approved:[]});
  expect(m.evidenceLoaded).not.toHaveBeenCalled();expect(m.verify).not.toHaveBeenCalled();expect(m.rpc).not.toHaveBeenCalled();
  await verifyPendingAlertReview(id,hash);
  expect(m.evidenceLoaded).toHaveBeenCalledOnce();expect(m.verify).toHaveBeenCalledExactlyOnceWith(id,details,expect.anything(),"pending");
  expect(m.rpc).not.toHaveBeenCalled();
});
