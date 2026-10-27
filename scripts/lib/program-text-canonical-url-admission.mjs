// Finite current25 collection identity boundary. This is not cross-award access.
export const PAPPG_CANONICAL_SOURCE_ID = "de868fe8-54ba-4fa0-8210-b27c8f182112";
export const PAPPG_CANONICAL_OWNER_ID = "d955a846-cee1-4c01-932e-e3cb7215f3fb";
export const PAPPG_CANONICAL_URL = "https://www.nsf.gov/policies/pappg";
export const PAPPG_CANONICAL_COHORT = "nsf_grfp";
export const PAPPG_PRESERVED_SOURCE_IDS = Object.freeze([
  "19204933-2b56-42ac-96ee-b54213a2785a", "27a2e7e7-d679-4b60-a9fb-300bbe33a94c",
  "29839757-599c-4758-873f-974380ca7e9d", "3e5795a6-d0d0-4894-af01-b1abcfdee999",
  "5a952e53-9c66-4c0f-9c42-07eaef865011", "73e4e932-cf63-47c4-a929-11a50e170728",
  "8ff84135-5a09-4873-ab89-28129e5d9cbf", "a04ebac4-827b-423d-a79f-8bfdd5e24008",
  "ca7a2e0b-39aa-44ea-9cf3-3949fbcb8e4c",
]);
const uuid = x => typeof x === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(x) && !/^0{8}(?:-0{4}){3}-0{12}$/.test(x);
const hash = x => typeof x === "string" && /^[a-f0-9]{64}$/.test(x);
const plain = x => x !== null && typeof x === "object" && !Array.isArray(x);
const exact = (x,keys) => plain(x) && Object.keys(x).length === keys.length && keys.every(k=>Object.hasOwn(x,k));
const normalized = x => typeof x === "string" ? x.split("#")[0].replace(/\/+$/,"").toLowerCase() : null;
export function needsProgramTextCanonicalUrlAdmission(source) {
  return source?.id === PAPPG_CANONICAL_SOURCE_ID || PAPPG_PRESERVED_SOURCE_IDS.includes(source?.id) ||
    normalized(source?.url) === PAPPG_CANONICAL_URL;
}
const admissionKeys = ["schema","source_id","shared_award_id","source_url","cohort_key","epoch","selected_source_id","revision","content_hash","current"];
export function validateProgramTextCanonicalUrlAdmission(value,source,epoch) {
  if (!exact(value,admissionKeys) || value.schema !== "awardping.program-text-canonical-url-admission.v1" ||
      !uuid(source?.id) || !uuid(source?.shared_award_id) || !uuid(epoch) ||
      value.source_id !== source.id || value.shared_award_id !== source.shared_award_id || value.source_url !== source.url ||
      value.epoch !== epoch || value.cohort_key !== PAPPG_CANONICAL_COHORT || value.selected_source_id !== PAPPG_CANONICAL_SOURCE_ID ||
      typeof value.current !== "boolean" || !((uuid(value.revision) && hash(value.content_hash)) ||
        value.current === false && value.revision === null && value.content_hash === null))
    throw new Error("Canonical URL admission identity is invalid");
  if (value.current && (source.id !== PAPPG_CANONICAL_SOURCE_ID || source.shared_award_id !== PAPPG_CANONICAL_OWNER_ID ||
      source.url !== PAPPG_CANONICAL_URL)) throw new Error("Canonical URL admission cannot grant a different source");
  return value;
}
export function hasProgramTextCanonicalUrlAdmission(source,{cohort,epoch}={}) {
  if (!needsProgramTextCanonicalUrlAdmission(source)) return true;
  if (source?.id !== PAPPG_CANONICAL_SOURCE_ID || source.shared_award_id !== PAPPG_CANONICAL_OWNER_ID ||
      source.url !== PAPPG_CANONICAL_URL || cohort !== undefined && cohort !== PAPPG_CANONICAL_COHORT) return false;
  try { return validateProgramTextCanonicalUrlAdmission(source.canonical_url_admission,source,epoch).current; }
  catch { return false; }
}
export async function attachProgramTextCanonicalUrlAdmissions(db,sources,{epoch}={}) {
  if (!uuid(epoch) || !Array.isArray(sources) || sources.some(s=>!uuid(s?.id)) || new Set(sources.map(s=>s.id)).size !== sources.length)
    throw new Error("Invalid canonical URL admission scope");
  const needed=sources.filter(needsProgramTextCanonicalUrlAdmission), byId=new Map();
  for(let i=0;i<needed.length;i+=100) {
    const batch=needed.slice(i,i+100), ids=batch.map(s=>s.id);
    const {data,error}=await db.rpc("get_program_text_canonical_url_admissions",{p_source_ids:ids,p_epoch:epoch});
    if(error || !exact(data,["schema","epoch","source_ids","admissions"]) ||
        data.schema !== "awardping.program-text-canonical-url-admission-page.v1" || data.epoch !== epoch ||
        !Array.isArray(data.source_ids) || data.source_ids.length!==ids.length || new Set(data.source_ids).size!==ids.length ||
        data.source_ids.some(id=>!ids.includes(id)) || !Array.isArray(data.admissions) || data.admissions.length!==ids.length)
      throw new Error("Current canonical URL admission is unavailable");
    for(const proof of data.admissions) {
      const source=batch.find(s=>s.id===proof?.source_id);
      if(!source || byId.has(source.id)) throw new Error("Canonical URL admission rows are incomplete or duplicated");
      byId.set(source.id,validateProgramTextCanonicalUrlAdmission(proof,source,epoch));
    }
    if(ids.some(id=>!byId.has(id))) throw new Error("Canonical URL admission omitted a required source");
  }
  return sources.map(source=>needsProgramTextCanonicalUrlAdmission(source)
    ? {...source,canonical_url_admission:byId.get(source.id)} : source);
}
/** Fresh check immediately before ordinary capture. It is not an in-flight lock. */
export async function assertCurrentCanonicalUrlAdmission(db,source,{epoch}={}) {
  if(!needsProgramTextCanonicalUrlAdmission(source)) return true;
  if(!hasProgramTextCanonicalUrlAdmission(source,{epoch})) throw new Error("Canonical URL admission is held");
  const [fresh]=await attachProgramTextCanonicalUrlAdmissions(db,[source],{epoch});
  if(!hasProgramTextCanonicalUrlAdmission(fresh,{epoch}) || fresh.canonical_url_admission.revision!==source.canonical_url_admission.revision ||
      fresh.canonical_url_admission.content_hash!==source.canonical_url_admission.content_hash)
    throw new Error("Canonical URL admission changed since the roster snapshot");
  const {data,error}=await db.rpc("program_text_source_is_approved",{p_source_id:source.id});
  if(error || data!==true) throw new Error("Canonical URL source no longer has current required-role approval");
  return true;
}
