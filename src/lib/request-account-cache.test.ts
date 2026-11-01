import { AsyncLocalStorage } from "node:async_hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m=vi.hoisted(()=>({internals:null as null|{A:unknown},auth:vi.fn(),read:vi.fn(),configured:true}));
// Exercise React's actual Server Component cache implementation. The dispatcher
// supplies only the render-local cache root normally supplied by the RSC renderer.
vi.mock("react",async importOriginal=>{
  const actual=await importOriginal<typeof import("react")>();
  const {createRequire}=await import("node:module"),{dirname,join}=await import("node:path");
  const require=createRequire(import.meta.url),server=require(join(dirname(require.resolve("react")),"cjs/react.react-server.development.js"));
  m.internals=server.__SERVER_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  return{...actual,cache:server.cache};
});
vi.mock("server-only",()=>({}));
vi.mock("next/navigation",()=>({redirect:(path:string)=>{throw Error("redirect:"+path);}}));
vi.mock("@/lib/config",()=>({appConfig:{adminEmails:["admin@example.test"]},hasSupabaseConfig:()=>m.configured}));
vi.mock("@/lib/personal-data",()=>({decryptProfileFields:(data:unknown)=>data}));
vi.mock("next/headers",()=>({cookies:async()=>({get:()=>({value:scope().office})})}));
vi.mock("@/lib/supabase/server",()=>({createSupabaseServerClient:async()=>({
  auth:{getUser:async()=>{const s=scope();m.auth(s.request);if(s.failAuth)throw Error("fresh session unavailable");return{data:{user:s.user?{id:s.user,email:s.user+"@example.test"}:null}};}},
  from:(table:string)=>new Query(table),
})}));
vi.mock("@/lib/supabase/admin",()=>({createSupabaseAdminClient:()=>{throw Error("No privileged client needed for request context");}}));
import {getCurrentUser,getUserProfile,requireUser} from "./auth";
import {getOfficeContext,requireOfficeContext} from "./offices";
type Scope={request:string;user:string|null;office:string;role:string;cache:Map<unknown,unknown>;failAuth?:boolean};
const storage=new AsyncLocalStorage<Scope>();
function scope(){const s=storage.getStore();if(!s)throw Error("test request missing");return s;}
class Query{
  filters:Array<[string,unknown]>=[];
  constructor(readonly table:string){}
  select(){return this;}eq(k:string,v:unknown){this.filters.push([k,v]);return this;}in(k:string,v:unknown[]){this.filters.push([k,v]);return this;}order(){return this;}
  result(){const s=scope();m.read(s.request,this.table,this.filters);let rows:Record<string,unknown>[]=[];
    if(this.table==="profiles")rows=s.user?[{id:s.user,full_name:s.request+" profile"}]:[];
    if(this.table==="office_members")rows=s.user?["office-a","office-b"].map(office=>({id:s.user+office,user_id:s.user,office_id:office,status:"active",role:s.role,notification_preference:"immediate",email:s.user+"@example.test"})):[];
    if(this.table==="offices")rows=[{id:"office-a",name:"Office A",organization_id:"org-a"},{id:"office-b",name:"Office B",organization_id:"org-b"}];
    if(this.table==="organizations")rows=[{id:"org-a",name:"Organization A"},{id:"org-b",name:"Organization B"}];
    return rows.filter(row=>this.filters.every(([k,v])=>Array.isArray(v)?v.includes(row[k]):row[k]===v));
  }
  async maybeSingle(){return{data:this.result()[0]||null};}
  then(resolve:(result:{data:Record<string,unknown>[];error:null})=>unknown){return Promise.resolve({data:this.result(),error:null}).then(resolve);}
}
function request<T>(request:string,user:string|null,office:string,fn:()=>Promise<T>,options:Partial<Scope>={}){return storage.run({request,user,office,role:"owner",cache:new Map(),...options},fn);}
beforeEach(()=>{
  vi.clearAllMocks();m.configured=true;
  m.internals!.A={getCacheForType:(factory:()=>unknown)=>{const s=scope();if(!s.cache.has(factory))s.cache.set(factory,factory());return s.cache.get(factory);}};
});
afterEach(()=>{m.internals!.A=null;});
describe("request-local account reads",()=>{
  it("deduplicates layout/page auth, profile and primitive office lookups within one render",async()=>{
    await request("first","alice","office-b",async()=>{
      const [a,b]=await Promise.all([getCurrentUser(),getCurrentUser()]);expect(a).toBe(b);
      const [p,q]=await Promise.all([getUserProfile("alice"),getUserProfile("alice")]);expect(p).toBe(q);
      const [one,two]=await Promise.all([getOfficeContext({id:"alice"}),requireOfficeContext({id:"alice",email:"fresh-object@example.test"})]);
      expect(one).toBe(two);expect(one?.current.officeId).toBe("office-b");
    });
    expect(m.auth).toHaveBeenCalledTimes(1);
    for(const table of ["profiles","office_members","offices","organizations"])expect(m.read.mock.calls.filter(c=>c[1]===table)).toHaveLength(1);
  });
  it("isolates concurrent users and offices rather than storing private results process-wide",async()=>{
    const values=await Promise.all([request("alice request","alice","office-a",async()=>({u:await getCurrentUser(),p:await getUserProfile("alice"),o:await getOfficeContext({id:"alice"})})),request("bob request","bob","office-b",async()=>({u:await getCurrentUser(),p:await getUserProfile("bob"),o:await getOfficeContext({id:"bob"})}))]);
    expect(values[0]).toMatchObject({u:{id:"alice"},p:{full_name:"alice request profile"},o:{current:{officeId:"office-a",userId:"alice"}}});
    expect(values[1]).toMatchObject({u:{id:"bob"},p:{full_name:"bob request profile"},o:{current:{officeId:"office-b",userId:"bob"}}});
    expect(m.auth).toHaveBeenCalledTimes(2);
  });
  it("rechecks the same user's cookie, role and profile on the next request",async()=>{
    const before=await request("before","alice","office-a",async()=>({p:await getUserProfile("alice"),o:await getOfficeContext({id:"alice"})}));
    const after=await request("after","alice","office-b",async()=>({p:await getUserProfile("alice"),o:await getOfficeContext({id:"alice"})}),{role:"member"});
    expect(before).toMatchObject({p:{full_name:"before profile"},o:{current:{officeId:"office-a",role:"owner"}}});
    expect(after).toMatchObject({p:{full_name:"after profile"},o:{current:{officeId:"office-b",role:"member"}}});
  });
  it("does not reuse an authenticated account for a later anonymous request",async()=>{
    await request("signed in","alice","office-a",()=>requireUser());
    await request("signed out",null,"office-a",async()=>{expect(await getCurrentUser()).toBeNull();await expect(requireUser()).rejects.toThrow("redirect:/login");});
    expect(m.auth).toHaveBeenCalledTimes(2);expect(m.read).not.toHaveBeenCalled();
  });
  it("keeps different profile/user IDs isolated within the same render",async()=>{
    await request("isolated IDs","alice","office-a",async()=>{
      expect(await getUserProfile("bob")).toBeNull();expect(await getUserProfile("alice")).toMatchObject({full_name:"isolated IDs profile"});
      expect(await getOfficeContext({id:"bob"})).toBeNull();expect(await getOfficeContext({id:"alice"})).toMatchObject({current:{userId:"alice"}});
    });
  });
  it("does not memoize route handler/action calls outside a React render dispatcher",async()=>{
    m.internals!.A=null;
    await request("action","alice","office-a",async()=>{await getCurrentUser();await getCurrentUser();await getUserProfile("alice");await getUserProfile("alice");await getOfficeContext({id:"alice"});await getOfficeContext({id:"alice"});});
    expect(m.auth).toHaveBeenCalledTimes(2);expect(m.read.mock.calls.filter(c=>c[1]==="profiles")).toHaveLength(2);expect(m.read.mock.calls.filter(c=>c[1]==="office_members")).toHaveLength(2);
  });
  it("does not retain a failed session across render requests",async()=>{
    await expect(request("failed","alice","office-a",()=>getCurrentUser(),{failAuth:true})).rejects.toThrow("fresh session unavailable");
    await expect(request("recovered","alice","office-a",()=>getCurrentUser())).resolves.toMatchObject({id:"alice"});
    expect(m.auth).toHaveBeenCalledTimes(2);
  });
});
