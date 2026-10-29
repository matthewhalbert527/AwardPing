import { describe, expect, it } from "vitest";
import {
  directoryFilterOptions,
  getAwardDirectoryCategories,
  type DirectoryFilterField,
  type DirectoryFilterInput,
} from "./award-directory-filters";

const OTHER = "Other / not listed";
const fields: DirectoryFilterField[] = ["academicLevels", "disciplines", "citizenship"];
const ordered: Record<DirectoryFilterField, string[]> = {
  academicLevels: ["High school", "Undergraduate", "Recent graduate", "Graduate", "Master's", "Doctoral", "Professional", OTHER],
  disciplines: ["STEM", "Engineering", "Computing & data", "Mathematics", "Natural sciences", "Environment & earth sciences", "Social sciences & policy", "Arts", "Business & law", "Health & medicine", "Education", "No field restriction", "Multiple fields (check courses)", OTHER],
  citizenship: ["U.S. citizens", "U.S. nationals", "U.S. permanent residents", "DACA / undocumented", "All nationalities", "Country-specific criteria", "New American criteria", "Work authorization", OTHER],
};
const labels: Record<string, string> = {
  Arts: "Arts & humanities",
  "Environment & earth sciences": "Environment & earth",
  "Social sciences & policy": "Society & policy",
  "Multiple fields (check courses)": "Multiple fields",
  "Country-specific criteria": "Country-specific",
  "U.S. permanent residents": "U.S. green card",
};
function input(field?: DirectoryFilterField, values: readonly string[] = []): DirectoryFilterInput {
  return { academicLevels: [], disciplines: [], citizenship: [], ...(field ? { [field]: values } : {}) };
}
function options(values: readonly string[]) {
  return values.map(value => ({ value, label: labels[value] ?? value }));
}

describe("award directory broad filter categories", () => {
  it("keeps missing fields visible as Other / not listed rather than inferring eligibility", () => {
    expect(getAwardDirectoryCategories(input())).toEqual({
      academicLevels: [OTHER], disciplines: [OTHER], citizenship: [OTHER],
    });
  });

  it("deduplicates normalized known values and returns a stable logical order", () => {
    expect(getAwardDirectoryCategories({
      academicLevels: ["Graduate", " undergraduate ", "UNDERGRADUATE."],
      disciplines: ["Arts", "STEM", " stem "],
      citizenship: ["U.S. citizens", "  U.S.   CITIZENS. "],
    })).toEqual({ academicLevels: ["Undergraduate", "Graduate"], disciplines: ["STEM", "Arts"], citizenship: ["U.S. citizens"] });
  });

  it.each([
    { field: "academicLevels", raw: "Not eligible: Undergraduate" },
    { field: "academicLevels", raw: "Graduate students are not eligible" },
    { field: "academicLevels", raw: "Undergraduate or Graduate (unreviewed condition)" },
    { field: "academicLevels", raw: "Undergraduate.." },
    { field: "disciplines", raw: "Not STEM" },
    { field: "disciplines", raw: "Engineering excluded" },
    { field: "disciplines", raw: "STEM except an unreviewed subject" },
    { field: "citizenship", raw: "No U.S. citizens" },
    { field: "citizenship", raw: "Not a U.S. citizen" },
    { field: "citizenship", raw: "U.S. citizenship is not required" },
    { field: "citizenship", raw: "U.S. citizens only if an unreviewed condition is met" },
  ] as const)("does not infer a category from words inside unknown $field text: $raw", ({ field, raw }) => {
    expect(getAwardDirectoryCategories(input(field, [raw]))[field]).toEqual([OTHER]);
  });

  it.each(fields)("handles blank and unknown %s without losing the fallback", field => {
    expect(getAwardDirectoryCategories(input(field, ["", " \t\n "]))[field]).toEqual([OTHER]);
    expect(getAwardDirectoryCategories(input(field, ["Unreviewed requirement"]))[field]).toEqual([OTHER]);
  });

  it("preserves both a known category and unknown substantive criteria", () => {
    expect(getAwardDirectoryCategories(input("academicLevels", ["Undergraduate", "Unreviewed restriction"])).academicLevels).toEqual(["Undergraduate", OTHER]);
  });

  it.each([
    { field: "academicLevels", raw: ["Sophomore", "Junior", "Graduating seniors", "Undergraduate (associate, bachelor's)"], expected: ["Undergraduate"] },
    { field: "academicLevels", raw: ["Recent graduates", "Individuals who have graduated during the previous academic year"], expected: ["Recent graduate"] },
    { field: "academicLevels", raw: ["Postgraduate / Recent graduate"], expected: ["Recent graduate", "Graduate"] },
    { field: "academicLevels", raw: ["  MASTER’S   student.  "], expected: ["Graduate", "Master's"] },
    { field: "academicLevels", raw: ["Doctoral student (early stage)"], expected: ["Graduate", "Doctoral"] },
    { field: "academicLevels", raw: ["Graduate (master's, doctoral, professional)"], expected: ["Graduate", "Master's", "Doctoral", "Professional"] },
    { field: "academicLevels", raw: ["Undergraduate senior, bachelor's degree-holder with no graduate degree enrollment, joint bachelor's-master's student with at least three undergraduate years completed, or first-year graduate student in their first graduate degree program"], expected: ["Undergraduate", "Graduate", "Master's"] },
    { field: "academicLevels", raw: ["Gap year preparing for graduate school"], expected: [OTHER] },
    { field: "disciplines", raw: ["Science, mathematics, and engineering"], expected: ["STEM", "Engineering", "Mathematics"] },
    { field: "disciplines", raw: ["Science, technology, engineering, and mathematics (STEM) fields, including STEM education"], expected: ["STEM", "Engineering", "Mathematics", "Education"] },
    { field: "disciplines", raw: ["STEM, including STEM education"], expected: ["STEM", "Education"] },
    { field: "disciplines", raw: ["Social sciences (excluding neuroscience and clinical psychology)"], expected: ["Social sciences & policy"] },
    { field: "disciplines", raw: ["Environmental, Tribal public policy, and health care fields"], expected: ["Environment & earth sciences", "Social sciences & policy", "Health & medicine"] },
    { field: "disciplines", raw: ["All fields of study", "All fields of study (no restrictions based on field of study or career aspiration)"], expected: ["No field restriction"] },
    { field: "disciplines", raw: ["Almost any discipline at graduate level leading to the award of a British university degree", "Any postgraduate subject available at the University of Cambridge"], expected: ["Multiple fields (check courses)"] },
    { field: "citizenship", raw: ["U.S. citizen, U.S. national, or permanent resident of the United States.", "US citizen", "U.S. National", "US permanent resident"], expected: ["U.S. citizens", "U.S. nationals", "U.S. permanent residents"] },
    { field: "citizenship", raw: ["U.S. citizen or U.S. national at the time of application."], expected: ["U.S. citizens", "U.S. nationals"] },
    { field: "citizenship", raw: ["U.S. Dual Citizen"], expected: ["U.S. citizens", "Country-specific criteria"] },
    { field: "citizenship", raw: ["United States", "Australia", "Canada", "New Zealand", "United Kingdom"], expected: ["Country-specific criteria"] },
    { field: "citizenship", raw: ["U.S. citizenship is not required for applicants attending a U.S. institution if eligible to work in the U.S. for 10–12 months from September 1 through at least June 30 following graduation.", "Must be a U.S. citizen if attending a participating institution located outside the United States."], expected: ["Country-specific criteria", "Work authorization"] },
    { field: "citizenship", raw: ["Naturalized US citizens, green card holders, asylees, refugees, or individuals who graduated from both high school and college in the United States."], expected: ["New American criteria"] },
    { field: "citizenship", raw: ["Citizens of any country outside the United Kingdom", "Dual citizens of the United Kingdom and another country", "Mainland Chinese applicants holding a P.R.C. passport are eligible if currently enrolled as undergraduates at a Mainland Chinese university."], expected: ["Country-specific criteria"] },
    { field: "citizenship", raw: ["DACA Recipient", "Undocumented students and applicants with DACA status"], expected: ["DACA / undocumented"] },
  ] as const)("maps reviewed whole $field criteria without dropping their conditional category: $raw", ({ field, raw, expected }) => {
    expect(getAwardDirectoryCategories(input(field, raw))[field]).toEqual(expected);
  });

  it("does not infer degree eligibility from a discipline phrase mentioning a degree", () => {
    expect(getAwardDirectoryCategories(input("disciplines", ["STEM fields (MS/MA)"]))).toEqual({
      academicLevels: [OTHER], disciplines: ["STEM"], citizenship: [OTHER],
    });
  });

  it("treats broad field/nationality categories as explicit options rather than wildcard eligibility", () => {
    const result = getAwardDirectoryCategories({
      academicLevels: ["Undergraduate"],
      disciplines: ["No field restriction"],
      citizenship: ["All nationalities"],
    });
    expect(result.disciplines).toEqual(["No field restriction"]);
    expect(result.citizenship).toEqual(["All nationalities"]);
    expect(result.disciplines).not.toContain("STEM");
    expect(result.citizenship).not.toContain("U.S. citizens");
  });

  it.each(fields)("returns only present %s options, deduplicated in the frozen order", field => {
    const values = ordered[field];
    const categories = [input(field, [...values].reverse()), input(field, values)];
    expect(directoryFilterOptions(field, categories)).toEqual(options(values));
    expect(directoryFilterOptions(field, [])).toEqual([]);
    const subset = [values.at(-1)!, values[1], values[0], values[1]];
    expect(directoryFilterOptions(field, [input(field, subset)])).toEqual(options([values[0], values[1], values.at(-1)!]));
  });

  it("does not mutate frozen input arrays or return shared mutable result arrays", () => {
    const raw = Object.freeze({
      academicLevels: Object.freeze(["Graduate", "Undergraduate"]),
      disciplines: Object.freeze(["Arts", "STEM"]),
      citizenship: Object.freeze(["U.S. citizens"]),
    });
    const before = structuredClone(raw);
    const categorized = getAwardDirectoryCategories(raw);
    const firstOptions = directoryFilterOptions("disciplines", Object.freeze([categorized]));
    firstOptions[0].label = "Mutated caller label";
    expect(directoryFilterOptions("disciplines", [categorized])).toEqual(options(["STEM", "Arts"]));
    expect(raw).toEqual(before);
    expect(categorized).toEqual({ academicLevels: ["Undergraduate", "Graduate"], disciplines: ["STEM", "Arts"], citizenship: ["U.S. citizens"] });
  });
});

// Frozen public copy only; no private captures or supporting quotations.

const rows = [
  {
    "cohort": "beinecke",
    "academicLevels": [
      "For the 2027 cycle, applicants must be college juniors pursuing a bachelor’s degree during 2026–2027, currently enrolled when applying, planning full-time undergraduate study the following term, and expecting graduation between December 2027 and August 2028. The award supports later master’s or doctoral study."
    ],
    "disciplines": [
      "Research- or creative-focused graduate study in the arts, humanities or social sciences. Social-science applicants intending graduate study in neuroscience or clinical psychology should not apply."
    ],
    "citizenship": [
      "U.S. citizens, or U.S. nationals from American Samoa or the Commonwealth of the Northern Mariana Islands."
    ],
    "expected": {
      "academicLevels": [
        "Undergraduate"
      ],
      "disciplines": [
        "Social sciences & policy",
        "Arts"
      ],
      "citizenship": [
        "U.S. citizens",
        "Country-specific criteria"
      ]
    }
  },
  {
    "cohort": "boren",
    "academicLevels": [
      "Undergraduate Scholarships: Associate's or bachelor's students at application; must stay enrolled as undergraduates until the Scholarship is complete. Community-college and transfer students are encouraged.",
      "Graduate Fellowships: Graduate students or applicants to eligible U.S. graduate programs; enrollment required by the Fellowship start and through completion. Eligible degrees include master's, JD and doctoral programs; certificates alone are not eligible."
    ],
    "disciplines": [
      "Students from any field may apply; listed preferred majors are preferences, not exclusive eligibility. Only undergraduate STEM majors qualify for the shorter summer-only track."
    ],
    "citizenship": [
      "U.S. citizens only at the national application deadline; permanent residents and international students are not eligible. Do not propose study in a destination of which you are a citizen."
    ],
    "expected": {
      "academicLevels": [
        "Undergraduate",
        "Graduate",
        "Master's",
        "Doctoral",
        "Professional"
      ],
      "disciplines": [
        "No field restriction"
      ],
      "citizenship": [
        "U.S. citizens"
      ]
    }
  },
  {
    "cohort": "churchill",
    "academicLevels": [
      "Churchill Scholarship: Graduating undergraduates or graduates within 12 months of the deadline.",
      "Kanders Churchill: Bachelor’s degree holders; no time limit since graduation."
    ],
    "disciplines": [
      "Churchill Scholarship: Science, mathematics or engineering in an eligible Cambridge MPhil or MASt.",
      "Kanders Churchill: Master’s in Public Policy, with a prior STEM major or minor."
    ],
    "citizenship": [
      "U.S. citizens, native-born or naturalized; also required for Kanders."
    ],
    "expected": {
      "academicLevels": [
        "Undergraduate",
        "Recent graduate",
        "Other / not listed"
      ],
      "disciplines": [
        "STEM",
        "Engineering",
        "Mathematics",
        "Social sciences & policy"
      ],
      "citizenship": [
        "U.S. citizens"
      ]
    }
  },
  {
    "cohort": "cls",
    "academicLevels": [
      "At application, enrollment in an accredited U.S. degree programme at undergraduate (associate/bachelor’s) or graduate (master’s/doctoral/professional) level is required. Virtual-institute applicants must be undergraduates."
    ],
    "disciplines": [
      "Students in any field of study may apply and must explain the language’s connection to their academic and professional goals."
    ],
    "citizenship": [
      "Be a U.S. citizen or national at the time of application; permanent residents and applicants awaiting naturalization are ineligible.",
      "Overseas institutes: Overseas participants must enter on a U.S. passport. Dual citizenship/other host-country nationality ties can prevent placement; alternate placements are not guaranteed."
    ],
    "expected": {
      "academicLevels": [
        "Undergraduate",
        "Graduate",
        "Master's",
        "Doctoral",
        "Professional"
      ],
      "disciplines": [
        "No field restriction"
      ],
      "citizenship": [
        "U.S. citizens",
        "U.S. nationals",
        "Country-specific criteria"
      ]
    }
  },
  {
    "cohort": "fulbright_us_student",
    "academicLevels": [],
    "disciplines": [
      "Program opportunities span academic disciplines, including creative and performing arts; availability and restrictions depend on the host-country award."
    ],
    "citizenship": [
      "U.S. citizens or U.S. nationals at the deadline; permanent residents are ineligible. Dual-citizen eligibility for the other country depends on that award's rules."
    ],
    "expected": {
      "academicLevels": [
        "Other / not listed"
      ],
      "disciplines": [
        "Multiple fields (check courses)"
      ],
      "citizenship": [
        "U.S. citizens",
        "U.S. nationals",
        "Country-specific criteria"
      ]
    }
  },
  {
    "cohort": "gaither",
    "academicLevels": [
      "Graduating seniors and applicants who graduated during the previous academic year; applicants who began graduate studies are excluded except for the stated completed joint-degree exception."
    ],
    "disciplines": [],
    "citizenship": [
      "Applicants attending a university in the United States: U.S. citizenship is not required for applicants attending a university located in the United States. All applicants still need U.S. work authorization for the stated employment period.",
      "Applicants attending a participating university outside the United States: Applicants attending a participating university outside the United States must be U.S. citizens.",
      "F-1 students: F-1 students may apply if they are eligible to work in the United States for the full year."
    ],
    "expected": {
      "academicLevels": [
        "Undergraduate",
        "Recent graduate"
      ],
      "disciplines": [
        "Other / not listed"
      ],
      "citizenship": [
        "Country-specific criteria",
        "Work authorization"
      ]
    }
  },
  {
    "cohort": "gates_cambridge",
    "academicLevels": [
      "Postgraduate only: eligible full-time master’s programmes and full-time or part-time PhDs; no undergraduate degrees."
    ],
    "disciplines": [
      "Any subject available at Cambridge within the scholarship’s eligible postgraduate degree types."
    ],
    "citizenship": [
      "Citizens of countries outside the United Kingdom are eligible; dual citizens of the UK and another country may apply."
    ],
    "expected": {
      "academicLevels": [
        "Graduate",
        "Master's",
        "Doctoral"
      ],
      "disciplines": [
        "Multiple fields (check courses)"
      ],
      "citizenship": [
        "Country-specific criteria"
      ]
    }
  },
  {
    "cohort": "gem",
    "academicLevels": [
      "MS fellowship: Master's-level graduate study.",
      "PhD fellowship: Doctoral graduate study."
    ],
    "disciplines": [],
    "citizenship": [
      "U.S. citizenship or U.S. permanent residency is required at the time of application."
    ],
    "expected": {
      "academicLevels": [
        "Graduate",
        "Master's",
        "Doctoral"
      ],
      "disciplines": [
        "Other / not listed"
      ],
      "citizenship": [
        "U.S. citizens",
        "U.S. permanent residents"
      ]
    }
  },
  {
    "cohort": "gilman",
    "academicLevels": [
      "Undergraduates at accredited U.S. two- or four-year institutions; community-college and transfer students are encouraged. High-school, graduate and postgraduate study are not funded.",
      "No minimum GPA requirement, although academic preparedness/performance is considered in selection."
    ],
    "disciplines": [],
    "citizenship": [
      "U.S. citizens or U.S. nationals; permanent residents alone are not eligible.",
      "Pending naturalization: FAQ allows an applicant expecting naturalization before the abroad program begins to apply, but funds require proof of U.S. citizenship (naturalization certificate or passport)."
    ],
    "expected": {
      "academicLevels": [
        "Undergraduate",
        "Other / not listed"
      ],
      "disciplines": [
        "Other / not listed"
      ],
      "citizenship": [
        "U.S. citizens",
        "U.S. nationals",
        "Other / not listed"
      ]
    }
  },
  {
    "cohort": "goldwater",
    "academicLevels": [
      "Sophomore: Three to four full-time undergraduate semesters remaining, beginning in September of the award year.",
      "Junior: One to two full-time undergraduate semesters remaining, beginning in September of the award year."
    ],
    "disciplines": [
      "Natural sciences, mathematics and engineering, with a research-focused career."
    ],
    "citizenship": [
      "U.S. citizens, U.S. nationals and U.S. permanent residents; permanent residents submit their Permanent Resident Card."
    ],
    "expected": {
      "academicLevels": [
        "Undergraduate"
      ],
      "disciplines": [
        "STEM",
        "Engineering",
        "Mathematics",
        "Natural sciences"
      ],
      "citizenship": [
        "U.S. citizens",
        "U.S. nationals",
        "U.S. permanent residents"
      ]
    }
  },
  {
    "cohort": "hertz",
    "academicLevels": [
      "College seniors, first-year graduate students and gap-year applicants preparing for PhD study can apply; the standard funded-entry window is PhD year one or two in fall 2027.",
      "Standalone master's students/graduates entering a PhD can apply; master's years within an already-accepted PhD program count toward graduate years."
    ],
    "disciplines": [
      "Applied physical sciences, applied biological sciences, mathematics and engineering; applicants explain how their work addresses real-world challenges."
    ],
    "citizenship": [
      "U.S. citizens or permanent residents."
    ],
    "expected": {
      "academicLevels": [
        "Undergraduate",
        "Graduate",
        "Master's"
      ],
      "disciplines": [
        "STEM",
        "Engineering",
        "Mathematics",
        "Natural sciences"
      ],
      "citizenship": [
        "U.S. citizens",
        "U.S. permanent residents"
      ]
    }
  },
  {
    "cohort": "luce",
    "academicLevels": [
      "Graduating seniors, recent graduates and young professionals, with at least a bachelor’s degree by program start."
    ],
    "disciplines": [
      "Wide-ranging fields, including arts, journalism, law, medicine, public health, science, business, environmental studies and international relations. Asian Studies majors are not excluded."
    ],
    "citizenship": [
      "U.S. citizens or permanent residents."
    ],
    "expected": {
      "academicLevels": [
        "Undergraduate",
        "Recent graduate"
      ],
      "disciplines": [
        "STEM",
        "Environment & earth sciences",
        "Social sciences & policy",
        "Arts",
        "Business & law",
        "Health & medicine"
      ],
      "citizenship": [
        "U.S. citizens",
        "U.S. permanent residents"
      ]
    }
  },
  {
    "cohort": "marshall",
    "academicLevels": [
      "First undergraduate degree from an accredited four-year U.S. college/university by September 2027, with graduation after April 2024; no age limit."
    ],
    "disciplines": [
      "Almost any graduate discipline, subject to course restrictions. MBA, MSc/MFE Financial Economics, second undergraduate degrees, PGDip/PGCert, professional qualifying medicine/dentistry/veterinary/law, distance learning and part-time courses are not funded.",
      "Oxford MPP is restricted to one partnership scholar per year; the Oxford 1+1 MPP plus MSc Public Policy Research combination is not permitted."
    ],
    "citizenship": [
      "U.S. citizens at application; permanent residents alone are not eligible. Dual citizens must also hold U.S. citizenship."
    ],
    "expected": {
      "academicLevels": [
        "Other / not listed"
      ],
      "disciplines": [
        "Multiple fields (check courses)",
        "Other / not listed"
      ],
      "citizenship": [
        "U.S. citizens"
      ]
    }
  },
  {
    "cohort": "ndseg",
    "academicLevels": [
      "Bachelor's degree completed by 2026 for the fall 2027 fellowship; new entrants or early graduate students within the first two years, with at least three degree years remaining."
    ],
    "disciplines": [],
    "citizenship": [
      "U.S. citizens, U.S. dual citizens and U.S. nationals. Permanent residents and people merely awaiting citizenship are ineligible."
    ],
    "expected": {
      "academicLevels": [
        "Graduate"
      ],
      "disciplines": [
        "Other / not listed"
      ],
      "citizenship": [
        "U.S. citizens",
        "U.S. nationals"
      ]
    }
  },
  {
    "cohort": "noaa_hollings",
    "academicLevels": [],
    "disciplines": [
      "A declared NOAA-mission major, including oceanic, environmental, biological or atmospheric sciences; mathematics; engineering; remote sensing; computer/information science; relevant physical/social sciences; or teacher education. The list is not exhaustive."
    ],
    "citizenship": [
      "U.S. citizenship is required at the time of application."
    ],
    "expected": {
      "academicLevels": [
        "Other / not listed"
      ],
      "disciplines": [
        "STEM",
        "Engineering",
        "Computing & data",
        "Mathematics",
        "Natural sciences",
        "Environment & earth sciences",
        "Social sciences & policy",
        "Education"
      ],
      "citizenship": [
        "U.S. citizens"
      ]
    }
  },
  {
    "cohort": "nsf_grfp",
    "academicLevels": [
      "Level 1: bachelor's seniors or bachelor's holders with no prior graduate-degree enrollment. Level 2: joint bachelor's/master's students in the final undergraduate or first graduate year, or first-year students in their first graduate degree program.",
      "One application per annual competition; after graduate-degree enrollment, only one application is allowed in the first year of the first graduate program."
    ],
    "disciplines": [],
    "citizenship": [
      "U.S. citizens, U.S. nationals and permanent residents at the application deadline and, if offered, at fellowship acceptance. Student-visa holders and applicants awaiting green cards are not eligible."
    ],
    "expected": {
      "academicLevels": [
        "Undergraduate",
        "Graduate",
        "Master's",
        "Other / not listed"
      ],
      "disciplines": [
        "Other / not listed"
      ],
      "citizenship": [
        "U.S. citizens",
        "U.S. nationals",
        "U.S. permanent residents"
      ]
    }
  },
  {
    "cohort": "samvid",
    "academicLevels": [
      "Incoming first-year graduate students; qualifying dual degrees and a master’s portion of a master’s/PhD lasting at least two years may qualify."
    ],
    "disciplines": [],
    "citizenship": [
      "U.S. citizens or DACA recipients; permanent residents are not eligible."
    ],
    "expected": {
      "academicLevels": [
        "Graduate",
        "Master's"
      ],
      "disciplines": [
        "Other / not listed"
      ],
      "citizenship": [
        "U.S. citizens",
        "DACA / undocumented"
      ]
    }
  },
  {
    "cohort": "schwarzman",
    "academicLevels": [
      "Class of 2028–2029: Applicants may be completing undergraduate study or already hold undergraduate/graduate degrees; the required undergraduate degree must be conferred by August 1, 2028. The funded course is a master’s degree."
    ],
    "disciplines": [
      "All undergraduate fields are welcome; applicants should explain how Schwarzman develops their leadership potential in their field."
    ],
    "citizenship": [],
    "expected": {
      "academicLevels": [
        "Undergraduate"
      ],
      "disciplines": [
        "No field restriction"
      ],
      "citizenship": [
        "Other / not listed"
      ]
    }
  },
  {
    "cohort": "smart",
    "academicLevels": [
      "General SMART degree levels: Bachelor’s, master’s and doctoral degree study in supported STEM disciplines."
    ],
    "disciplines": [
      "Aerospace and Aeronautical Engineering",
      "Biomedical Engineering",
      "Biosciences",
      "Chemical Engineering",
      "Chemistry",
      "Civil Engineering",
      "Cognitive, Neural, and Behavioral Sciences",
      "Computer Science and Engineering",
      "Data Science and Analytics",
      "Electrical Engineering",
      "Geosciences",
      "Industrial and Systems Engineering",
      "Information Sciences",
      "Materials Science and Engineering",
      "Mathematics",
      "Mechanical Engineering",
      "Naval Architecture and Ocean Engineering",
      "Nuclear Engineering",
      "Oceanography",
      "Operations Research",
      "Physics",
      "Software Engineering"
    ],
    "citizenship": [],
    "expected": {
      "academicLevels": [
        "Undergraduate",
        "Graduate",
        "Master's",
        "Doctoral"
      ],
      "disciplines": [
        "STEM",
        "Engineering",
        "Computing & data",
        "Mathematics",
        "Natural sciences",
        "Environment & earth sciences"
      ],
      "citizenship": [
        "Other / not listed"
      ]
    }
  },
  {
    "cohort": "soros",
    "academicLevels": [],
    "disciplines": [
      "All fields of eligible graduate or professional study are considered."
    ],
    "citizenship": [
      "U.S.-citizen-by-birth applicants: U.S.-citizen-by-birth applicants generally need both birth parents born abroad as non-U.S. citizens and not eligible for U.S. citizenship at birth. The page allows a single-birth-parent exception when that immigrant parent raised the applicant and the other parent was absent with no contact. Parent location/current status does not decide eligibility.",
      "Immigrant pathways: Applicants born abroad as non-U.S. citizens may qualify through naturalized citizenship, citizenship following adoption by American parents, a valid green card, or granted U.S. refugee/asylee status.",
      "U.S.-high-school-and-college pathway: If no other listed immigrant pathway applies, a person born abroad must have graduated from both high school and college in the United States; this includes current/past DACA recipients. An American high school located abroad does not satisfy that U.S.-schooling route."
    ],
    "expected": {
      "academicLevels": [
        "Other / not listed"
      ],
      "disciplines": [
        "No field restriction"
      ],
      "citizenship": [
        "New American criteria"
      ]
    }
  },
  {
    "cohort": "truman",
    "academicLevels": [],
    "disciplines": [
      "Any graduate/professional degree with a credible path to public service, including policy, law, education, health, sciences and other fields; domestic and overseas study can be funded. MBA support is rare and requires a clear public-service connection."
    ],
    "citizenship": [],
    "expected": {
      "academicLevels": [
        "Other / not listed"
      ],
      "disciplines": [
        "Multiple fields (check courses)"
      ],
      "citizenship": [
        "Other / not listed"
      ]
    }
  },
  {
    "cohort": "udall_undergraduate",
    "academicLevels": [
      "College sophomores and juniors. The Environment criteria expressly specify accredited higher-education institutions; both Native category pages also address sophomore/junior college students."
    ],
    "disciplines": [
      "Environment: Conservation, environmental stewardship or environmental policy, with a career addressing environmental issues.",
      "Tribal Policy: An array of policy issues affecting Indian country and careers serving a tribe or Native Americans and Alaska Natives.",
      "Native Health Care: Health-care practice and delivery in Indian country, or health-care policy and research."
    ],
    "citizenship": [
      "The 2027 undergraduate criteria list U.S. citizens, nationals and lawful permanent residents for the Environment category and for the Native American/Alaska Native categories."
    ],
    "expected": {
      "academicLevels": [
        "Undergraduate"
      ],
      "disciplines": [
        "Environment & earth sciences",
        "Social sciences & policy",
        "Health & medicine"
      ],
      "citizenship": [
        "U.S. citizens",
        "U.S. nationals",
        "U.S. permanent residents"
      ]
    }
  },
  {
    "cohort": "yenching",
    "academicLevels": [
      "Bachelor's degree holders or undergraduates completing their degree by August of the intended enrollment year; prior master's degree holders may apply on international/HMT tracks."
    ],
    "disciplines": [
      "Applicants may come from any field. China Studies offers Economics and Management; History and Archaeology; Philosophy and Religion; Politics and International Relations; Law and Society; Literature and Culture."
    ],
    "citizenship": [
      "International: Non-Chinese citizens with a valid passport. The published page additionally requires former Mainland/Hong Kong/Macao/Taiwan citizens to show passport/citizenship documents dating before April 30, 2021 and proof of cancellation of Chinese nationality.",
      "Hong Kong, Macao and Taiwan: Separate HMT track through Yenching plus a supplementary Peking University Graduate Admissions application.",
      "Mainland Chinese: PRC passport holders from Mainland China use a separate process and must currently be undergraduates at a Mainland Chinese university; this condition does not apply to HMT candidates."
    ],
    "expected": {
      "academicLevels": [
        "Undergraduate"
      ],
      "disciplines": [
        "No field restriction"
      ],
      "citizenship": [
        "Country-specific criteria"
      ]
    }
  }
] as Array<DirectoryFilterInput & {
  cohort: string;
  expected: { academicLevels: string[]; disciplines: string[]; citizenship: string[] };
}>;

describe("directory categories for the 23 published source-verified basic snapshots", () => {
  it("uses every current published award, without manufacturing held data or omitting awkward cases", () => {
    expect(rows).toHaveLength(23);
    expect(new Set(rows.map(row => row.cohort)).size).toBe(23);
    expect(rows.map(row => row.cohort)).not.toContain("rhodes");
    expect(rows.map(row => row.cohort)).not.toContain("knight_hennessy");
  });

  it.each(rows)("classifies exact reviewed whole phrases for $cohort without changing the facts", row => {
    const input = Object.freeze({
      academicLevels: Object.freeze([...row.academicLevels]),
      disciplines: Object.freeze([...row.disciplines]),
      citizenship: Object.freeze([...row.citizenship]),
    });
    const before = structuredClone(input);
    const categories = getAwardDirectoryCategories(input);
    expect(categories.academicLevels).toEqual(row.expected.academicLevels);
    expect(categories.disciplines).toEqual(row.expected.disciplines);
    expect(categories.citizenship).toEqual(row.expected.citizenship);
    expect(input).toEqual(before);
  });

  it.each(rows)("rejects unreviewed additions and negated forms of $cohort copy", row => {
    for (const field of ["academicLevels", "disciplines", "citizenship"] as const) {
      for (const value of row[field]) {
        for (const changed of [`Not eligible: ${value}`, `${value} Additional unreviewed condition.`]) {
          expect(getAwardDirectoryCategories({ academicLevels: [], disciplines: [], citizenship: [], [field]: [changed] })[field]).toEqual([OTHER]);
        }
      }
    }
  });

  it("restores useful ordered academic options instead of only All/Other", () => {
    const categorized = rows.map(getAwardDirectoryCategories);
    expect(directoryFilterOptions("academicLevels", categorized).map(option => option.value)).toEqual([
      "Undergraduate", "Recent graduate", "Graduate", "Master's", "Doctoral", "Professional", OTHER,
    ]);
    expect(directoryFilterOptions("citizenship", categorized).map(option => option.value)).toEqual([
      "U.S. citizens", "U.S. nationals", "U.S. permanent residents", "DACA / undocumented", "Country-specific criteria", "New American criteria", "Work authorization", OTHER,
    ]);
    expect(directoryFilterOptions("disciplines", categorized).map(option => option.value)).toEqual([
      "STEM", "Engineering", "Computing & data", "Mathematics", "Natural sciences", "Environment & earth sciences", "Social sciences & policy", "Arts", "Business & law", "Health & medicine", "Education", "No field restriction", "Multiple fields (check courses)", OTHER,
    ]);
  });

  it("keeps all six held discipline arrays Other without borrowing fields from names or overviews", () => {
    expect(rows.filter(row => !row.disciplines.length).map(row => row.cohort)).toEqual(["gaither", "gem", "gilman", "ndseg", "nsf_grfp", "samvid"]);
    for (const row of rows.filter(row => !row.disciplines.length)) expect(getAwardDirectoryCategories(row).disciplines).toEqual([OTHER]);
  });

  it("does not harvest excluded fields, prior backgrounds or country/course examples as universal disciplines", () => {
    const categories = (cohort: string) => getAwardDirectoryCategories(rows.find(row => row.cohort === cohort)!);
    expect(categories("beinecke").disciplines).toEqual(["Social sciences & policy", "Arts"]);
    expect(categories("marshall").disciplines).toEqual(["Multiple fields (check courses)", OTHER]);
    expect(categories("fulbright_us_student").disciplines).toEqual(["Multiple fields (check courses)"]);
    expect(categories("truman").disciplines).toEqual(["Multiple fields (check courses)"]);
    expect(categories("boren").disciplines).toEqual(["No field restriction"]);
    expect(categories("yenching").disciplines).toEqual(["No field restriction"]);
    const kanders = rows.find(row => row.cohort === "churchill")!.disciplines[1];
    expect(getAwardDirectoryCategories({ academicLevels: [], citizenship: [], disciplines: [kanders] }).disciplines).toEqual(["Social sciences & policy"]);
    for (const value of ["Not eligible: Arts", "Social sciences excluded", "All subjects except a new unreviewed restriction", "Any subject (unreviewed course list)"]) {
      expect(getAwardDirectoryCategories({ academicLevels: [], citizenship: [], disciplines: [value] }).disciplines).toEqual([OTHER]);
    }
  });

  it("keeps four held academic fields and three held citizenship fields as Other", () => {
    expect(rows.filter(row => !row.academicLevels.length).map(row => row.cohort)).toEqual(["fulbright_us_student", "noaa_hollings", "soros", "truman"]);
    expect(rows.filter(row => !row.citizenship.length).map(row => row.cohort)).toEqual(["schwarzman", "smart", "truman"]);
    for (const row of rows) {
      if (!row.academicLevels.length) expect(getAwardDirectoryCategories(row).academicLevels).toEqual([OTHER]);
      if (!row.citizenship.length) expect(getAwardDirectoryCategories(row).citizenship).toEqual([OTHER]);
    }
  });

  it("does not promote exclusions, prior degrees or track qualifications into broader eligibility", () => {
    const categories = (cohort: string) => getAwardDirectoryCategories(rows.find(row => row.cohort === cohort)!);
    expect(categories("beinecke").academicLevels).toEqual(["Undergraduate"]);
    expect(categories("gaither").academicLevels).toEqual(["Undergraduate", "Recent graduate"]);
    expect(categories("samvid").academicLevels).toEqual(["Graduate", "Master's"]);
    expect(categories("hertz").academicLevels).toEqual(["Undergraduate", "Graduate", "Master's"]);
    expect(categories("yenching").academicLevels).toEqual(["Undergraduate"]);
    expect(categories("marshall").academicLevels).toEqual([OTHER]);
    expect(categories("gates_cambridge").academicLevels).not.toContain("Undergraduate");
    expect(categories("soros").citizenship).toEqual(["New American criteria"]);
    expect(categories("yenching").citizenship).toEqual(["Country-specific criteria"]);
    expect(categories("gaither").citizenship).toEqual(["Country-specific criteria", "Work authorization"]);
    expect(categories("gilman").citizenship).not.toContain("U.S. permanent residents");
    expect(categories("samvid").citizenship).not.toContain("U.S. permanent residents");
    expect(rows.map(categories => getAwardDirectoryCategories(categories).citizenship).flat()).not.toContain("All nationalities");
  });

  it("retains September aliases and requires separately reviewed new copy", () => {
    expect(getAwardDirectoryCategories({ academicLevels: ["Sophomores", "Doctoral student (early stage)"], disciplines: [], citizenship: ["US permanent resident"] })).toMatchObject({
      academicLevels: ["Undergraduate", "Graduate", "Doctoral"], citizenship: ["U.S. permanent residents"],
    });
    expect(getAwardDirectoryCategories({
      academicLevels: ["Not undergraduate; only doctoral students are eligible", "Master's studies excluded"],
      disciplines: [],
      citizenship: ["U.S. citizenship is not required", "No U.S. citizens", "All nationalities except an unreviewed condition"],
    })).toMatchObject({ academicLevels: [OTHER], citizenship: [OTHER] });
  });
});
