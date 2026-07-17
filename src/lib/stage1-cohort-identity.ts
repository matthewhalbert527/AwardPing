import { createHash } from "node:crypto";

export const stage1CohortIdentityVersion = "stage1-national-25-v1";

export const stage1CohortIdentity = Object.freeze([
  [1, "rhodes_us", "Rhodes Scholarship (United States)", "3e0c02fe-70cc-4933-81c4-b58ac4036bff", "rhodes-scholarship", "https://www.rhodeshouse.ox.ac.uk/scholarships/the-rhodes-scholarship/"],
  [2, "marshall", "Marshall Scholarship", "4c02307f-5928-4066-8f97-bd704b372184", "marshall-scholarship", "https://www.marshallscholarship.org/"],
  [3, "fulbright_us_student", "Fulbright U.S. Student Program", "5dd1afc1-a560-495a-9bee-1f26f835475b", "fulbright-u-s-student-program", "https://us.fulbrightonline.org/"],
  [4, "gates_cambridge", "Gates Cambridge Scholarship", "b6fc3596-4f9a-4cab-ba83-69b3e5387774", "gates-cambridge-scholarship", "https://www.gatescambridge.org/"],
  [5, "churchill", "Churchill Scholarship", "0695c116-1151-4b68-997e-93df400734dd", "churchill-scholarship", "https://www.churchillscholarship.org/"],
  [6, "schwarzman", "Schwarzman Scholars", "dd23afbb-299e-489f-8a0b-e4d7506848de", "schwarzman-scholars", "https://www.schwarzmanscholars.org/"],
  [7, "knight_hennessy", "Knight-Hennessy Scholars", "141944a8-fd04-4433-b0e4-8990fae56764", "knight-hennessy-scholars", "https://knight-hennessy.stanford.edu/"],
  [8, "yenching", "Yenching Academy", "2da1b35d-fe8b-46cd-bc4b-b099e0fd1363", "yenching-academy-scholars", "https://yenchingacademy.pku.edu.cn/"],
  [9, "luce", "Luce Scholars Program", "a643d94e-216b-4449-bf2f-99d8503793d7", "luce-scholars-program", "https://lucescholars.org/"],
  [10, "truman", "Harry S. Truman Scholarship", "bf04d4c1-4db3-4f4e-bf1b-e4dbca7bb7d3", "truman-scholarship", "https://www.truman.gov/"],
  [11, "goldwater", "Barry Goldwater Scholarship", "4a2c1160-d5bc-41db-b645-d51030585275", "goldwater-scholarship", "https://goldwaterscholarship.gov/"],
  [12, "udall_undergraduate", "Udall Undergraduate Scholarship", "ef4c98ad-ffaa-4f15-9771-d9a94487bf0d", "udall-scholarship", "https://www.udall.gov/OurPrograms/Scholarship/Scholarship.aspx"],
  [13, "beinecke", "Beinecke Scholarship", "26b5b55f-57e9-42a7-ae4c-37d389c5e70c", "beinecke-scholarship", "https://beineckescholarship.org/"],
  [14, "gilman", "Benjamin A. Gilman International Scholarship", "c699e979-fbbe-4d58-8a4a-fc36fe6db833", "gilman-international-scholarship", "https://www.gilmanscholarship.org/"],
  [15, "boren", "Boren Scholarships and Fellowships", "5cabc508-416c-4387-8652-276e7c76afe1", "boren-awards", "https://www.borenawards.org/"],
  [16, "cls", "Critical Language Scholarship Program", "ba1a3c76-4868-42b4-994b-6cbae72a7044", "critical-language-scholarship", "https://clscholarship.org/"],
  [17, "nsf_grfp", "NSF Graduate Research Fellowship Program", "d955a846-cee1-4c01-932e-e3cb7215f3fb", "nsf-graduate-research-fellowship-program", "https://www.nsfgrfp.org/"],
  [18, "hertz", "Hertz Fellowship", "4d2f6a7f-024e-4194-be31-1b9f63e497bc", "hertz-foundation-graduate-fellowship", "https://www.hertzfoundation.org/the-fellowship/"],
  [19, "ndseg", "National Defense Science and Engineering Graduate Fellowship", "e776ca2f-4b2c-431e-a3f9-248ad78c30e8", "national-defense-science-and-engineering-graduate-fellowship", "https://ndseg.org/"],
  [20, "smart", "SMART Scholarship-for-Service Program", "d7d4d117-f312-456f-a75c-3dbd5d372c99", "smart-scholarship-for-service-program", "https://www.smartscholarship.org/smart"],
  [21, "gem", "GEM Fellowship", "4b7cef78-b2c9-4463-ad3e-0f42a9164425", "gem-national-consortium", "https://www.gemfellowship.org/"],
  [22, "noaa_hollings", "NOAA Ernest F. Hollings Undergraduate Scholarship", "a9b42e3f-6d7e-4b0d-8132-77c2042b311d", "noaa-hollings-scholarship", "https://www.noaa.gov/office-education/hollings-scholarship"],
  [23, "soros", "Paul & Daisy Soros Fellowships for New Americans", "3cf7c610-0246-4dfb-b26c-289254e40ce6", "paul-and-daisy-soros-fellowships-for-new-americans", "https://www.pdsoros.org/"],
  [24, "samvid", "Samvid Scholars", "406c12bc-49f3-4d4c-b90d-9ba7e4e0f70e", "samvid-scholars-program", "https://samvidscholars.org/"],
  [25, "gaither", "James C. Gaither Junior Fellows Program", "7007882c-af99-4919-ad2c-2672ffcccfaf", "james-c-gaither-junior-fellows-program", "https://carnegieendowment.org/james-c-gaither-junior-fellows-program"],
] as const);

export type Stage1CohortIdentityRow = {
  launch_rank: number;
  cohort_key: string;
  canonical_name: string;
  canonical_shared_award_id: string;
  canonical_slug: string;
  official_homepage: string;
};

export const stage1CohortIdentityPayload = stage1CohortIdentity
  .map((row) => row.join("|"))
  .join("\n");

export const stage1CohortIdentityHash = createHash("sha256")
  .update(JSON.stringify(stage1CohortIdentityPayload), "utf8")
  .digest("hex");

export function stage1CohortIdentityMismatch(
  rows: readonly Stage1CohortIdentityRow[],
): string | null {
  if (rows.length !== stage1CohortIdentity.length) {
    return `Expected ${stage1CohortIdentity.length} exact Stage 1 awards; found ${rows.length}.`;
  }
  const ordered = [...rows].sort((left, right) => left.launch_rank - right.launch_rank);
  for (let index = 0; index < stage1CohortIdentity.length; index += 1) {
    const expected = stage1CohortIdentity[index];
    const actual = ordered[index];
    const actualValues = [
      actual.launch_rank,
      actual.cohort_key,
      actual.canonical_name,
      actual.canonical_shared_award_id,
      actual.canonical_slug,
      actual.official_homepage,
    ];
    if (expected.some((value, valueIndex) => value !== actualValues[valueIndex])) {
      return `Stage 1 identity mismatch at launch rank ${expected[0]} (${expected[1]}).`;
    }
  }
  return null;
}
