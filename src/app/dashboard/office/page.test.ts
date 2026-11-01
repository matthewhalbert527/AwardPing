import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {beforeEach,describe,expect,it,vi} from "vitest";
const m=vi.hoisted(()=>({user:vi.fn(),office:vi.fn(),profile:vi.fn(),client:vi.fn(),from:vi.fn(),form:vi.fn(),configured:true}));
vi.mock("server-only",()=>({}));
vi.mock("@/lib/config",()=>({hasSupabaseConfig:()=>m.configured,appConfig:{}}));
vi.mock("@/lib/auth",()=>({requireUser:m.user,getUserProfile:m.profile}));
vi.mock("@/lib/offices",async importOriginal=>({...await importOriginal<typeof import("@/lib/offices")>(),requireOfficeContext:m.office}));
vi.mock("@/lib/supabase/server",()=>({createSupabaseServerClient:m.client}));
vi.mock("@/components/office-forms",()=>Object.fromEntries(["InviteMemberForm","MemberPreferenceSelect","MemberRoleSelect","OfficeNameForm","PrivacyControls","ProfileSettingsForm","ReissueInviteButton"].map(name=>[name,(props:unknown)=>{m.form(name,props);return createElement("div",{"data-form":name});}])));
vi.mock("@/components/setup-notice",()=>({SetupNotice:()=>createElement("p",null,"Set up AwardPing")}));
import OfficePage from "./page";
type Result={data:never[]};
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return{promise,resolve};}
let reads:Map<string,ReturnType<typeof deferred<Result>>>,filters:Array<{table:string;kind:string;key:string;value:unknown}>;
class Query{
  constructor(readonly table:string){}
  select(){return this;}
  eq(key:string,value:unknown){filters.push({table:this.table,kind:"eq",key,value});return this;}
  is(key:string,value:unknown){filters.push({table:this.table,kind:"is",key,value});return this;}
  neq(key:string,value:unknown){filters.push({table:this.table,kind:"neq",key,value});return this;}
  order(){return this;}
  then(resolve:(result:Result)=>unknown){return reads.get(this.table)!.promise.then(resolve);}
}
beforeEach(()=>{
  vi.resetAllMocks();m.configured=true;filters=[];reads=new Map(["office_members","office_invites","office_invite_security_reissues"].map(table=>[table,deferred<Result>()]));
  m.user.mockResolvedValue({id:"user-current"});m.office.mockResolvedValue({current:{officeId:"office-current",officeName:"Current office",role:"owner"}});
  m.profile.mockResolvedValue(null);m.from.mockImplementation(table=>new Query(table));m.client.mockResolvedValue({from:m.from});
});
describe("parallel authorized office settings reads",()=>{
  it("starts all independent reads before any completes and preserves exact tenant/invite filters",async()=>{
    const profile=deferred<null>();m.profile.mockReturnValue(profile.promise);
    const pending=OfficePage();
    await vi.waitFor(()=>expect(m.from).toHaveBeenCalledTimes(3));
    expect(m.profile).toHaveBeenCalledExactlyOnceWith("user-current");
    for(const table of reads.keys())expect(filters).toContainEqual({table,kind:"eq",key:"office_id",value:"office-current"});
    expect(filters).toContainEqual({table:"office_members",kind:"eq",key:"status",value:"active"});
    expect(filters).toContainEqual({table:"office_invites",kind:"is",key:"accepted_at",value:null});
    expect(filters).toContainEqual({table:"office_invite_security_reissues",kind:"neq",key:"status",value:"delivered"});
    for(const r of reads.values())r.resolve({data:[]});profile.resolve(null);
    expect(renderToStaticMarkup(await pending)).toContain("Office settings");
  });
  it("never fetches invitations or management data for a regular member",async()=>{
    m.office.mockResolvedValue({current:{officeId:"member-office",officeName:"Member office",role:"member"}});
    reads.get("office_members")!.resolve({data:[]});
    const html=renderToStaticMarkup(await OfficePage());
    expect(m.from).toHaveBeenCalledExactlyOnceWith("office_members");
    expect(filters).toContainEqual({table:"office_members",kind:"eq",key:"office_id",value:"member-office"});
    expect(html).not.toContain('data-form="InviteMemberForm"');expect(html).not.toContain('data-form="OfficeNameForm"');
    expect(html).toContain('data-form="ProfileSettingsForm"');
  });
  it("preserves administrator management controls and profile recovery flags",async()=>{
    m.office.mockResolvedValue({current:{officeId:"admin-office",officeName:"Admin office",role:"admin"}});
    m.profile.mockResolvedValue({full_name:"Current name",organization:"Current organization",personal_data_reentry_required:true,personal_data_legacy_recovery_available:true});
    for(const r of reads.values())r.resolve({data:[]});
    const html=renderToStaticMarkup(await OfficePage());
    expect(html).toContain('data-form="InviteMemberForm"');
    expect(m.form).toHaveBeenCalledWith("ProfileSettingsForm",{initialFullName:"Current name",initialOrganization:"Current organization",reentryRequired:true,legacyRecoveryAvailable:true});
  });
  it("does not start private reads before authentication and office authorization",async()=>{
    m.user.mockRejectedValue(Error("redirect:/login"));await expect(OfficePage()).rejects.toThrow("redirect:/login");
    expect(m.office).not.toHaveBeenCalled();expect(m.client).not.toHaveBeenCalled();expect(m.profile).not.toHaveBeenCalled();
    m.user.mockResolvedValue({id:"user-current"});m.office.mockRejectedValue(Error("No office workspace"));await expect(OfficePage()).rejects.toThrow("No office workspace");
    expect(m.client).not.toHaveBeenCalled();expect(m.profile).not.toHaveBeenCalled();
  });
});
