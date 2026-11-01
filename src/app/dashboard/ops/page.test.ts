import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {load} from "cheerio";
import {beforeEach,describe,expect,it,vi} from "vitest";
const m=vi.hoisted(()=>({user:vi.fn(),siteAdmin:vi.fn(),office:vi.fn(),userClient:vi.fn(),adminClient:vi.fn(),rpc:vi.fn(),started:vi.fn(),clientConfig:true,adminConfig:true}));
vi.mock("server-only",()=>({}));
vi.mock("@/lib/config",()=>({hasSupabaseConfig:()=>m.clientConfig,hasSupabaseAdminConfig:()=>m.adminConfig}));
vi.mock("@/lib/auth",()=>({requireUser:m.user,isSiteAdminEmail:m.siteAdmin}));
vi.mock("@/lib/offices",async importOriginal=>({...await importOriginal<typeof import("@/lib/offices")>(),requireOfficeContext:m.office}));
vi.mock("@/lib/supabase/server",()=>({createSupabaseServerClient:m.userClient}));
vi.mock("@/lib/supabase/admin",()=>({createSupabaseAdminClient:m.adminClient}));
vi.mock("@/components/admin-run-report",()=>({AdminRunReport:()=>createElement("p",null,"Worker run details")}));
vi.mock("@/components/setup-notice",()=>({SetupNotice:()=>createElement("p",null,"Setup required")}));
import OpsPage from "./page";
type Result={data:Array<Record<string,unknown>>|null;count:number|null;error:{message:string}|null};
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return{promise,resolve};}
let gate:ReturnType<typeof deferred<Result>>,queries:Query[],digestError:boolean;
class Query{
  filters:Array<[string,string,unknown]>=[];options?:{count?:string;head?:boolean};maximum?:number;projection?:string;
  constructor(readonly table:string,readonly client:"user"|"admin"){queries.push(this);}
  select(projection:string,options?:{count?:string;head?:boolean}){this.projection=projection;this.options=options;return this;}
  eq(k:string,v:unknown){this.filters.push(["eq",k,v]);return this;}lte(k:string,v:unknown){this.filters.push(["lte",k,v]);return this;}
  gte(k:string,v:unknown){this.filters.push(["gte",k,v]);return this;}is(k:string,v:unknown){this.filters.push(["is",k,v]);return this;}
  not(k:string,op:string,v:unknown){this.filters.push(["not:"+op,k,v]);return this;}in(k:string,v:unknown[]){this.filters.push(["in",k,v]);return this;}
  order(){return this;}limit(n:number){this.maximum=n;return this;}
  result():Result{
    if(this.options?.head){let count=0;if(this.table==="shared_award_sources")count=this.filters.some(f=>f[1]==="next_check_at")?120:this.filters.some(f=>f[1]==="last_error")?9:87555;else if(this.table==="shared_award_change_events")count=10;else if(this.table==="shared_awards")count=20;return{data:null,error:null,count};}
    if(this.table==="job_runs")return{data:digestError?null:[{id:"digest-run",job_name:"send-digests",status:"succeeded",started_at:"2026-11-01T12:00:00.000Z",finished_at:"2026-11-01T12:01:00.000Z",error:null}],count:null,error:digestError?{message:"Digest records unavailable"}:null};
    return{data:[],count:null,error:null};
  }
  then(resolve:(r:Result)=>unknown){m.started(this.table,this.client);return(this.table==="alert_deliveries"?gate.promise:Promise.resolve(this.result())).then(resolve);}
}
beforeEach(()=>{
  vi.resetAllMocks();queries=[];digestError=false;gate=deferred<Result>();m.clientConfig=true;m.adminConfig=true;
  m.user.mockResolvedValue({id:"user-current",email:"admin@example.test"});m.siteAdmin.mockReturnValue(true);
  m.office.mockResolvedValue({current:{officeId:"office-current",role:"owner"}});
  m.userClient.mockResolvedValue({from:(table:string)=>new Query(table,"user")});m.adminClient.mockReturnValue({from:(table:string)=>new Query(table,"admin"),rpc:m.rpc});
  m.rpc.mockResolvedValue({data:[{lane_key:"review",display_name:"Changed-page review",enabled:true,lease_expired:false,sla_breached:false,status:"idle",consecutive_failures:0,queue_depth:0,creates_api_charge:true,oldest_item_at:null,last_error:null}],error:null});
});
describe("monitoring records independent queries",()=>{
  it("starts digest and lane reads while the first history batch is still blocked",async()=>{
    const pending=OpsPage();
    await vi.waitFor(()=>expect(m.started).toHaveBeenCalledTimes(12));
    expect(m.rpc).toHaveBeenCalledExactlyOnceWith("list_monitoring_downstream_lane_status");
    expect(m.started).toHaveBeenCalledWith("job_runs","admin");
    let done=false;void pending.then(()=>{done=true;});await Promise.resolve();expect(done).toBe(false);
    gate.resolve({data:[],count:null,error:null});
    const $=load(renderToStaticMarkup(await pending));
    const metric=(label:string)=>$("p").filter((_,el)=>$(el).text()===label).parent().text();
    expect(metric("Recorded lane status")).toContain("1/1");expect(metric("Last digest run")).toContain("succeeded");
    expect(metric("Recorded source rows")).toContain("87555");expect(metric("Legacy sources due")).toContain("120");
    expect(metric("Legacy source errors")).toContain("9");expect(metric("7-day recorded events")).toContain("10");expect(metric("Legacy structure due")).toContain("20");
  });
  it("preserves exact count semantics, source projections, list bounds and office delivery isolation",async()=>{
    gate.resolve({data:[],count:null,error:null});await OpsPage();
    const counts=queries.filter(q=>q.options?.head);expect(counts).toHaveLength(5);expect(counts.every(q=>q.options?.count==="exact"&&q.projection==="*")).toBe(true);
    expect(counts.find(q=>q.table==="shared_award_sources"&&q.filters.length===0)).toBeDefined();
    expect(counts.find(q=>q.table==="shared_award_change_events")?.filters).toEqual([["is","suppressed_at",null],["gte","detected_at",expect.any(String)]]);
    const deliveries=queries.find(q=>q.table==="alert_deliveries")!;expect(deliveries.client).toBe("user");expect(deliveries.maximum).toBe(8);
    expect(deliveries.filters).toEqual([["eq","office_id","office-current"],["eq","status","failed"]]);
    expect(queries.find(q=>q.table==="job_runs")?.maximum).toBe(1);
    expect(queries.find(q=>q.table==="local_worker_runs")?.maximum).toBe(5);
    expect(queries.find(q=>q.table==="shared_award_change_events"&&!q.options?.head)?.maximum).toBe(25);
  });
  it("retains unavailable digest/lane reporting without inventing healthy status",async()=>{
    digestError=true;m.rpc.mockResolvedValue({data:null,error:{message:"Lane records unavailable"}});gate.resolve({data:[],count:null,error:null});
    const $=load(renderToStaticMarkup(await OpsPage()));
    const metric=(label:string)=>$("p").filter((_,el)=>$(el).text()===label).parent().text();
    expect(metric("Last digest run")).toContain("Unavailable");expect(metric("Recorded lane status")).toContain("Unavailable");expect($("body").text()).not.toContain("1/1");
  });
  it("starts no history/count/RPC work for unsigned, non-admin or non-manager requests",async()=>{
    m.user.mockRejectedValue(Error("redirect:/login"));await expect(OpsPage()).rejects.toThrow("redirect:/login");expect(m.adminClient).not.toHaveBeenCalled();expect(m.userClient).not.toHaveBeenCalled();
    m.user.mockResolvedValue({id:"member",email:"member@example.test"});m.siteAdmin.mockReturnValue(false);expect(renderToStaticMarkup(await OpsPage())).toContain("site administrators");expect(m.office).not.toHaveBeenCalled();
    m.siteAdmin.mockReturnValue(true);m.office.mockResolvedValue({current:{officeId:"member-office",role:"member"}});expect(renderToStaticMarkup(await OpsPage())).toContain("office owners and admins");
    expect(m.adminClient).not.toHaveBeenCalled();expect(m.userClient).not.toHaveBeenCalled();expect(m.rpc).not.toHaveBeenCalled();expect(queries).toEqual([]);
  });
});
