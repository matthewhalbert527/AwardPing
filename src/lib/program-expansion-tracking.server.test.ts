import {describe,it,expect,vi} from 'vitest';
import type {Stage1PublicationEntry} from './stage1-publication';
import {isApprovedProgramExpansionSource,type ProgramExpansionTrackingContext} from './program-expansion-tracking.server';
import monitoring from '../../config/program-text-monitoring.json';
vi.mock('server-only',()=>({}));
vi.mock('@/lib/stage1-publication',()=>({isStage1SourceIdentityExcluded:()=>false}));
const cases=[
  {
    "cohort_key": "ppia_jsi",
    "id": "83900fc9-380a-4076-a0ac-ab9601a0147a",
    "shared_award_id": "874d043a-3819-4032-a7c4-bb9582a1d51f",
    "url": "https://www.ppiaprogram.org/JSI"
  },
  {
    "cohort_key": "ppia_jsi",
    "id": "2b97a926-7b4b-45cf-b572-3e20a57be22c",
    "shared_award_id": "874d043a-3819-4032-a7c4-bb9582a1d51f",
    "url": "https://www.ppiaprogram.org/"
  },
  {
    "cohort_key": "daad_rise",
    "id": "9959b621-20e0-43dc-ac28-7e7003756202",
    "shared_award_id": "4a862735-6d67-4154-81ad-4bcc51ad0ec1",
    "url": "https://www.daad.de/rise/en/rise-germany/"
  },
  {
    "cohort_key": "daad_rise",
    "id": "fe13c090-73d6-4434-8bec-3b9e05b95d53",
    "shared_award_id": "4a862735-6d67-4154-81ad-4bcc51ad0ec1",
    "url": "https://www.daad.de/rise/en/rise-germany/find-an-internship/what-applicants-need-to-know/"
  },
  {
    "cohort_key": "daad_rise",
    "id": "1e0f93f0-d952-4d9b-9404-3d220977efa0",
    "shared_award_id": "4a862735-6d67-4154-81ad-4bcc51ad0ec1",
    "url": "https://www.daad.de/rise/en/rise-germany/find-an-internship/application-portal/"
  },
  {
    "cohort_key": "daad_rise",
    "id": "126adf51-6848-4eed-bb47-b71b0f09f56f",
    "shared_award_id": "4a862735-6d67-4154-81ad-4bcc51ad0ec1",
    "url": "https://www.daad.de/rise/en/rise-germany/find-an-internship/what-applicants-need-to-know/faq/"
  },
  {
    "cohort_key": "tillman",
    "id": "98938651-b0af-474e-96d4-9e4622de0c93",
    "shared_award_id": "cb8740aa-4585-4e1c-a939-35fc854cb12b",
    "url": "https://pattillmanfoundation.org/eligibility-and-compensation/"
  },
  {
    "cohort_key": "tillman",
    "id": "a58d550e-d6c0-4ddd-84b3-bddb29d427c9",
    "shared_award_id": "cb8740aa-4585-4e1c-a939-35fc854cb12b",
    "url": "https://pattillmanfoundation.org/frequently-asked-questions/"
  },
  {
    "cohort_key": "tillman",
    "id": "6f8aebc1-8282-4621-b2fc-4c2305b1998a",
    "shared_award_id": "cb8740aa-4585-4e1c-a939-35fc854cb12b",
    "url": "https://pattillmanfoundation.org/scholar-benefits/"
  },
  {
    "cohort_key": "tillman",
    "id": "7f3621f2-1422-40e5-b2da-8f1f15b51c04",
    "shared_award_id": "cb8740aa-4585-4e1c-a939-35fc854cb12b",
    "url": "https://pattillmanfoundation.org/apply/"
  },
  {
    "cohort_key": "freeman_asia",
    "id": "43e9bff0-776c-41d6-a390-1c875f7a3d92",
    "shared_award_id": "06713967-eaf6-49cf-aa8d-a12d6cf1ab51",
    "url": "https://www.iie.org/programs/freeman-asia/"
  },
  {
    "cohort_key": "freeman_asia",
    "id": "1fb9d6e2-9259-489a-9a5d-cc89d44cd499",
    "shared_award_id": "06713967-eaf6-49cf-aa8d-a12d6cf1ab51",
    "url": "https://www.iie.org/programs/freeman-asia/apply/"
  },
  {
    "cohort_key": "freeman_asia",
    "id": "a32fc45a-303b-4bc6-b200-12572b0f036f",
    "shared_award_id": "06713967-eaf6-49cf-aa8d-a12d6cf1ab51",
    "url": "https://www.iie.org/programs/freeman-asia/eligibility/"
  },
  {
    "cohort_key": "freeman_asia",
    "id": "2f6957ee-a1d3-4543-b1e5-1e277fe0fbc4",
    "shared_award_id": "06713967-eaf6-49cf-aa8d-a12d6cf1ab51",
    "url": "https://www.iie.org/programs/freeman-asia/about/award-details/"
  },
  {
    "cohort_key": "james_madison",
    "id": "5c3ec960-6782-432c-89c8-271fc966032f",
    "shared_award_id": "592d1ab0-7eff-402a-82ba-90d19559aa7f",
    "url": "https://www.jamesmadison.gov/"
  },
  {
    "cohort_key": "james_madison",
    "id": "0f217532-3638-4cc4-8548-7ae9f4eec489",
    "shared_award_id": "592d1ab0-7eff-402a-82ba-90d19559aa7f",
    "url": "https://www.jamesmadison.gov/fellowship-information/fellowship-eligibility"
  },
  {
    "cohort_key": "james_madison",
    "id": "cb0b55db-3a5b-4ac7-ac09-63419a684a9a",
    "shared_award_id": "592d1ab0-7eff-402a-82ba-90d19559aa7f",
    "url": "https://www.jamesmadison.gov/fellowship-information/faq"
  },
  {
    "cohort_key": "rangel",
    "id": "eb63f27e-2c7e-4011-b9a4-c263ff0a07fa",
    "shared_award_id": "e6ebd346-0567-4464-85b1-92a555036992",
    "url": "https://rangelprogram.org/graduate-fellowship-program/"
  },
  {
    "cohort_key": "rangel",
    "id": "774ad37b-5a34-4ed7-8b89-6a464e814270",
    "shared_award_id": "e6ebd346-0567-4464-85b1-92a555036992",
    "url": "https://rangelprogram.org/graduate-fellowship-program/overview-eligibility/"
  },
  {
    "cohort_key": "rangel",
    "id": "6b1fcefe-a5f5-4bac-abcf-117c51605970",
    "shared_award_id": "e6ebd346-0567-4464-85b1-92a555036992",
    "url": "https://rangelprogram.org/graduate-fellowship-program/application-requirements/"
  },
  {
    "cohort_key": "rangel",
    "id": "db69aeb5-5e51-4fc3-9470-8d927e2cb270",
    "shared_award_id": "e6ebd346-0567-4464-85b1-92a555036992",
    "url": "https://rangelprogram.org/graduate-fellowship-program/faqs/"
  },
  {
    "cohort_key": "rangel",
    "id": "531dd57f-73c1-4da8-8f61-2833cc60d3bf",
    "shared_award_id": "e6ebd346-0567-4464-85b1-92a555036992",
    "url": "https://rangelprogram.org/graduate-fellowship-program/university-partners/"
  },
  {
    "cohort_key": "pickering",
    "id": "bca3dffd-d0f4-4379-81e2-dc9a1beefe7f",
    "shared_award_id": "06b39341-8489-4c72-a555-dfd96d336f4b",
    "url": "https://pickeringfellowship.org/"
  },
  {
    "cohort_key": "pickering",
    "id": "ea9a0c12-8f54-47c7-9b21-0e56f269da9a",
    "shared_award_id": "06b39341-8489-4c72-a555-dfd96d336f4b",
    "url": "https://pickeringfellowship.org/overview-eligibility/"
  },
  {
    "cohort_key": "pickering",
    "id": "76bbf296-74cd-41b0-931b-9ec783a8ead1",
    "shared_award_id": "06b39341-8489-4c72-a555-dfd96d336f4b",
    "url": "https://pickeringfellowship.org/how-to-apply/"
  },
  {
    "cohort_key": "pickering",
    "id": "32f9fb62-9ed9-4b81-b65d-cd8dc9240540",
    "shared_award_id": "06b39341-8489-4c72-a555-dfd96d336f4b",
    "url": "https://pickeringfellowship.org/overview-eligibility/faqs/"
  },
  {
    "cohort_key": "pickering",
    "id": "c6619efd-b603-46e3-8378-204ea5c634b1",
    "shared_award_id": "06b39341-8489-4c72-a555-dfd96d336f4b",
    "url": "https://pickeringfellowship.org/approvedprograms/"
  },
  {
    "cohort_key": "daad_study",
    "id": "56aa30ee-164e-489a-ae5c-f2902dbb0db5",
    "shared_award_id": "440d6985-ece9-48c4-ac30-65a739f60d65",
    "url": "https://www.daad.org/en/find-funding/scholarship-database/?type=a&q=&status=0&subject=0&onlydaad=1&detail_to_show=0&target=44&origin=44&pg=1&detail_to_show=50026200"
  },
  {
    "cohort_key": "daad_study",
    "id": "8d654c9d-e572-4488-94a3-e4238e7b1155",
    "shared_award_id": "440d6985-ece9-48c4-ac30-65a739f60d65",
    "url": "https://www.daad.org/en/find-funding/country-specific-information-for-us-applicants/"
  },
  {
    "cohort_key": "daad_study",
    "id": "88906939-65e7-492d-a671-da56678dfecd",
    "shared_award_id": "440d6985-ece9-48c4-ac30-65a739f60d65",
    "url": "https://www.daad.org/en/find-funding/scholarship-database/?origin=44&status=3&type=a&q=&onlydaad=1&language=en&detail_to_show=50026200&tab="
  },
  {
    "cohort_key": "rotary_peace",
    "id": "c906cb21-aeb3-40b9-a5fe-b72fb54db2e9",
    "shared_award_id": "4f66e3fa-3924-4d0d-a04d-a32989f74c2e",
    "url": "https://www.rotary.org/en/get-involved/our-programs/peace-fellowships"
  },
  {
    "cohort_key": "rotary_peace",
    "id": "235ed53e-5cd3-4315-b653-7450e0e10c84",
    "shared_award_id": "4f66e3fa-3924-4d0d-a04d-a32989f74c2e",
    "url": "https://www.rotary.org/en/get-involved/our-programs/peace-fellowships/peace-fellowships-masters-degree-programs"
  },
  {
    "cohort_key": "rotary_peace",
    "id": "37255bb3-547a-4181-a953-86c38093e87c",
    "shared_award_id": "4f66e3fa-3924-4d0d-a04d-a32989f74c2e",
    "url": "https://www.rotary.org/en/get-involved/our-programs/peace-fellowships/peace-fellowships-certificate-program"
  },
  {
    "cohort_key": "voyager",
    "id": "a39ca8af-102b-4edd-a827-b748e58f22ac",
    "shared_award_id": "10dda818-c922-47ac-8b56-55494c2c889f",
    "url": "https://www.obama.org/programs/voyager-scholarship/"
  },
  {
    "cohort_key": "voyager",
    "id": "d6530e44-ed3e-47a3-b404-ea636d8b573f",
    "shared_award_id": "10dda818-c922-47ac-8b56-55494c2c889f",
    "url": "https://www.obama.org/programs/voyager-scholarship/faq/"
  }
];
function proof(row:typeof cases[number]){const publication={registry:{policy_version:'program-basic-expansion-v1',cohort_key:row.cohort_key},canonicalAwardId:row.shared_award_id,memberAwardIds:[row.shared_award_id],allowedSourceIdSet:new Set([row.id]),approvedTextAlertSourceBindings:{[row.id]:{url:row.url,shared_award_id:row.shared_award_id,epoch:monitoring.epoch}}}as unknown as Stage1PublicationEntry;const context={schema:'awardping.program-award-expansion-tracking.v1',admission_id:'90000000-0000-4000-8000-000000000003',cohort_key:row.cohort_key,canonical_shared_award_id:row.shared_award_id,epoch:monitoring.epoch,source_ids:[row.id]}as ProgramExpansionTrackingContext;return{publication,context};}
describe('exact admitted URL policy across both expansion batches',()=>{
 it.each(cases)('accepts the actual admitted $cohort_key source $id',row=>{const p=proof(row);expect(isApprovedProgramExpansionSource(p.publication,p.context,row)).toBe(true);});
 it.each(cases.filter(r=>r.url.includes('detail_to_show=50026200')))('preserves exact DAAD query identity $id',row=>{const p=proof(row);expect(isApprovedProgramExpansionSource(p.publication,p.context,{...row,url:'https://www.daad.org/en/find-funding/scholarship-database/'})).toBe(false);expect(isApprovedProgramExpansionSource(p.publication,p.context,{...row,url:row.url.replace('50026200','50026201')})).toBe(false);expect(isApprovedProgramExpansionSource(p.publication,p.context,{...row,shared_award_id:'90000000-0000-4000-8000-000000000090'})).toBe(false);expect(isApprovedProgramExpansionSource(p.publication,p.context,{...row,id:'90000000-0000-4000-8000-000000000090'})).toBe(false);});
 it.each(['https://name:password@example.test/rules','https://example.test:8443/rules','https://example.test/rules#part','javascript:alert(1)'])('rejects a nonordinary URL even if a caller supplies matching text metadata %s',url=>{const row={...cases[0],url},p=proof(row);expect(isApprovedProgramExpansionSource(p.publication,p.context,row)).toBe(false);});
 it('never grants the modern exception to a legacy publication',()=>{const row=cases[0],p=proof(row);p.publication.registry.policy_version='stage1-publication-v1';expect(isApprovedProgramExpansionSource(p.publication,p.context,row)).toBe(false);});
});
