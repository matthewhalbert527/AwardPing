import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { getReviewedAwardDirectoryCategories, directoryCategoryReviewKey } from "./award-directory-category-reviews.server";
import { getAwardDirectoryCategories } from "./award-directory-filters";
import { matchesDirectorySelections } from "./award-directory-selection";

// Literal independent review expectations for the actual 50 current awards.
const cases = [
  {
    "cohort": "amgen_us",
    "id": "9592a089-dd1d-4e5b-b7d1-74e766906830",
    "facts": {
      "academicLevels": [
        "Sophomores, juniors and non-graduating seniors returning to undergraduate study in the fall."
      ],
      "disciplines": [
        "Biomedical and biotechnology-related research; students from any major may apply."
      ],
      "citizenship": [
        "U.S. citizens or U.S. permanent residents."
      ],
      "eligibility": [
        "U.S. citizens or permanent residents enrolled at accredited four-year institutions in the U.S., Puerto Rico or other U.S. territories. Eligible sophomores, juniors and non-graduating seniors must return to undergraduate study in the fall, have GPA 3.2 or higher and be interested in a Ph.D. or M.D.–Ph.D.",
        "Each host requires its own application; applicants may apply to multiple hosts in the U.S., but only one program region. Participation is limited to one summer."
      ]
    },
    "expected": {
      "academicLevels": [
        "Undergraduate"
      ],
      "disciplines": [
        "STEM",
        "Natural sciences",
        "Health & medicine",
        "No field restriction"
      ],
      "citizenship": [
        "U.S. citizens",
        "U.S. permanent residents"
      ]
    }
  },
  {
    "cohort": "astronaut",
    "id": "9880eddb-203a-4474-88b1-a3a877b398a3",
    "facts": {
      "academicLevels": [
        "Undergraduates entering junior or senior year."
      ],
      "disciplines": [
        "Eligible STEM fields, with a research focus; biomedical research may qualify."
      ],
      "citizenship": [
        "U.S. citizens."
      ],
      "eligibility": [
        "U.S. citizens entering junior or senior year at a participating institution, normally enrolled full-time for both semesters. A faculty nomination is required.",
        "Applicants should intend to pursue research or advance their STEM field. Professional medical practice is excluded; biomedical research can qualify.",
        "Institutional study requirements apply, including a separate transfer-student provision."
      ]
    },
    "expected": {
      "academicLevels": [
        "Undergraduate"
      ],
      "disciplines": [
        "STEM",
        "Engineering",
        "Computing & data",
        "Mathematics",
        "Natural sciences",
        "Environment & earth sciences",
        "Health & medicine"
      ],
      "citizenship": [
        "U.S. citizens"
      ]
    }
  },
  {
    "cohort": "beinecke",
    "id": "26b5b55f-57e9-42a7-ae4c-37d389c5e70c",
    "facts": {
      "academicLevels": [
        "For the 2027 cycle, applicants must be college juniors pursuing a bachelor’s degree during 2026–2027, currently enrolled when applying, planning full-time undergraduate study the following term, and expecting graduation between December 2027 and August 2028. The award supports later master’s or doctoral study."
      ],
      "disciplines": [
        "Research- or creative-focused graduate study in the arts, humanities or social sciences. Social-science applicants intending graduate study in neuroscience or clinical psychology should not apply."
      ],
      "citizenship": [
        "U.S. citizens, or U.S. nationals from American Samoa or the Commonwealth of the Northern Mariana Islands."
      ],
      "eligibility": [
        "Applicants must demonstrate superior intellectual ability, scholastic achievement and personal promise; attend a participating institution; and have a documented undergraduate history of eligibility for need-based financial aid. Institutional, state or federal need-based grants can demonstrate that history, and financial need is considered in selection."
      ]
    },
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
    "cohort": "blakemore_freeman",
    "id": "f7cea269-67b7-4372-bd68-4a995c096db4",
    "facts": {
      "academicLevels": [
        "Bachelor’s degree required by the grant start; advanced-level language learners."
      ],
      "disciplines": [
        "Advanced Chinese (Taiwan), Japanese, Korean, Indonesian, Khmer, Thai or Vietnamese language study."
      ],
      "citizenship": [
        "U.S. citizens or permanent residents (green card holders)."
      ],
      "eligibility": [
        "U.S. citizenship or permanent residence, a bachelor’s degree by the grant start, and advanced language ability. By the grant start, applicants must have completed at least third-year college-level language classes.",
        "Applicants must pursue a career using the language and devote the grant to full-time intensive language study; part-time study and research are excluded.",
        "Apply separately to the approved language school. A fellowship is conditional on admission; grants do not support study in the United States."
      ]
    },
    "expected": {
      "academicLevels": [
        "Degree holder"
      ],
      "disciplines": [
        "Arts"
      ],
      "citizenship": [
        "U.S. citizens",
        "U.S. permanent residents"
      ]
    }
  },
  {
    "cohort": "boren",
    "id": "5cabc508-416c-4387-8652-276e7c76afe1",
    "facts": {
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
      "eligibility": [
        "U.S. citizen at the national deadline; high-school graduate/GED; at least 18 when submitting; an eligible overseas language program outside Western Europe, Canada, Australia and New Zealand, in a destination where the applicant is not a citizen.",
        "Remain enrolled in an accredited U.S. degree program throughout the award; ROTC, Reserve and National Guard participants must be inactive/non-drilling during it.",
        "Recipients commit to at least one year of federal government service; selection gives preference to applicants demonstrating a longer-term federal service commitment."
      ]
    },
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
    "cohort": "chevening",
    "id": "60d68065-a9ee-4ef5-9096-1467c299538e",
    "facts": {
      "academicLevels": [
        "One-year master’s study after an eligible undergraduate degree and the required work experience."
      ],
      "disciplines": [],
      "citizenship": [
        "Citizens of Chevening-eligible countries or territories; British/dual British exclusions and specified exceptions apply."
      ],
      "eligibility": [
        "Citizenship of an eligible country or territory, a qualifying undergraduate degree completed at least two years before the deadline, and at least 2,800 hours of work experience gained after that degree. Residence requirements apply for ODA-country awards.",
        "Commit to returning to the country of award for at least two years, apply to three eligible UK courses and receive at least one unconditional offer by the offer deadline.",
        "British or dual British citizenship is generally excluded, with the stated British Overseas Territory and Hong Kong BN(O) exceptions. UK residency and previous UK-government funding restrictions also apply."
      ]
    },
    "expected": {
      "academicLevels": [
        "Degree holder",
        "Graduate",
        "Master's"
      ],
      "disciplines": [
        "STEM",
        "Engineering",
        "Computing & data",
        "Mathematics",
        "Natural sciences",
        "Environment & earth sciences",
        "Social sciences & policy",
        "Arts",
        "Business & law",
        "Health & medicine",
        "Education",
        "Multiple fields (check courses)"
      ],
      "citizenship": [
        "Country-specific criteria"
      ]
    }
  },
  {
    "cohort": "churchill",
    "id": "0695c116-1151-4b68-997e-93df400734dd",
    "facts": {
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
      "eligibility": [
        "Churchill Scholarship: Participating-institution students graduating in the deadline’s academic year, or graduates from those institutions within the preceding 12 months; bachelor’s degree by award start.",
        "Kanders Churchill: Bachelor’s major or minor in STEM from any U.S. college or university; no time limit since graduation.",
        "Churchill Scholarship — STEM: Churchill STEM selection has no minimum GPA, though most applicants have very high averages; the committee assesses academic achievement and proven research talent."
      ]
    },
    "expected": {
      "academicLevels": [
        "Undergraduate",
        "Recent graduate",
        "Degree holder"
      ],
      "disciplines": [
        "STEM",
        "Engineering",
        "Computing & data",
        "Mathematics",
        "Natural sciences",
        "Environment & earth sciences",
        "Social sciences & policy",
        "Health & medicine"
      ],
      "citizenship": [
        "U.S. citizens"
      ]
    }
  },
  {
    "cohort": "cls",
    "id": "ba1a3c76-4868-42b4-994b-6cbae72a7044",
    "facts": {
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
      "eligibility": [
        "Be at least 18 by May 15, 2027. Undergraduate applicants must complete at least one full year of study (two semesters or three quarters) before the summer 2027 programme begins.",
        "Enroll in at least one credit-bearing class through the home U.S. institution in fall 2026 and remain in good academic standing. Limited case-by-case fall exceptions cover approved study abroad, national scholarships/fellowships, and substantive co-op/internship programmes with documentation. Spring enrollment is required unless graduating in December 2026.",
        "Meet any language-specific prerequisites and apply once for only one language in the year; multiple applications make an applicant ineligible."
      ]
    },
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
    "cohort": "daad_rise",
    "id": "4a862735-6d67-4154-81ad-4bcc51ad0ec1",
    "facts": {
      "academicLevels": [
        "Undergraduate"
      ],
      "disciplines": [
        "Biology, chemistry, computer science, physics, earth sciences, engineering or a closely related field."
      ],
      "citizenship": [
        "Eligibility is based on enrollment at a university/college in the United States, Canada, United Kingdom or Ireland; applicants of other nationalities can qualify under the conditions below.",
        "Applicants without U.S., Canadian, British or Irish citizenship may apply if they have studied at a university/college in one of those countries for more than twelve months by the application deadline.",
        "German citizens are eligible only with proof of having lived outside Germany for at least six years."
      ],
      "eligibility": [
        "Undergraduate enrollment in the U.S., Canada, United Kingdom or Ireland, with at least two years completed by the placement and undergraduate status retained throughout it. See official rules for other conditions."
      ]
    },
    "expected": {
      "academicLevels": [
        "Undergraduate"
      ],
      "disciplines": [
        "STEM",
        "Engineering",
        "Computing & data",
        "Natural sciences",
        "Environment & earth sciences"
      ],
      "citizenship": [
        "Country-specific criteria"
      ]
    }
  },
  {
    "cohort": "daad_study",
    "id": "440d6985-ece9-48c4-ac30-65a739f60d65",
    "facts": {
      "academicLevels": [
        "Master’s or other eligible postgraduate study"
      ],
      "disciplines": [
        "Academic disciplines covered by this programme; artistic disciplines and architecture have separate DAAD programmes."
      ],
      "citizenship": [
        "U.S./Canada application route: U.S. or Canadian citizens/permanent residents; other nationals living in the U.S. or Canada may qualify with a U.S./Canadian degree completed by funding start. Other applicants may need a different DAAD office."
      ],
      "eligibility": [
        "Published U.S. graduate route: A first university degree is required by the funding start. The latest degree normally must be no more than six years old; applicants resident in Germany for over 15 months at the deadline are ineligible. See current official guidance for admission and language requirements."
      ]
    },
    "expected": {
      "academicLevels": [
        "Degree holder",
        "Graduate",
        "Master's"
      ],
      "disciplines": [
        "STEM",
        "Engineering",
        "Computing & data",
        "Mathematics",
        "Natural sciences",
        "Environment & earth sciences",
        "Social sciences & policy",
        "Business & law",
        "Health & medicine",
        "Education",
        "Multiple fields (check courses)"
      ],
      "citizenship": [
        "U.S. citizens",
        "U.S. permanent residents",
        "Country-specific criteria"
      ]
    }
  },
  {
    "cohort": "doe_csgf",
    "id": "cd2f7cf3-6751-4b42-8a23-891788da30e9",
    "facts": {
      "academicLevels": [
        "Graduating undergraduates and eligible early graduate students entering or pursuing Ph.D. study."
      ],
      "disciplines": [
        "Engineering and the physical, computer, mathematical or life sciences, using computational research."
      ],
      "citizenship": [
        "U.S. citizens or lawful permanent residents."
      ],
      "eligibility": [
        "U.S. citizens or lawful permanent residents planning full-time, uninterrupted Ph.D. study at an accredited U.S. university.",
        "Eligible applicants include undergraduate seniors, first-year graduate students, employed applicants and others entering graduate study. Current master’s students must begin their Ph.D. at a different institution in the fall when funding begins.",
        "Second-year or later graduate students and concurrent professional doctoral degree students are ineligible."
      ]
    },
    "expected": {
      "academicLevels": [
        "Undergraduate",
        "Graduate",
        "Doctoral"
      ],
      "disciplines": [
        "STEM",
        "Engineering",
        "Computing & data",
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
    "cohort": "ellison_graduate",
    "id": "3ed2ee95-7e6c-4f75-800e-6d42f5288dbb",
    "facts": {
      "academicLevels": [
        "Doctoral (DPhil/PhD) study at Oxford. Final-year degree applicants may apply conditionally."
      ],
      "disciplines": [
        "EIT-linked doctoral projects in pathogen research, materials and devices for life sciences, plant biology and economics."
      ],
      "citizenship": [],
      "eligibility": [
        "Meet the relevant Oxford doctoral course entry requirements and demonstrate research experience aligned with an EIT project.",
        "Final-year degree students may apply; any offer remains conditional on meeting Oxford’s entry requirements.",
        "EIT funds full-time doctoral courses; research-area application and funding arrangements differ."
      ]
    },
    "expected": {
      "academicLevels": [
        "Degree holder",
        "Graduate",
        "Doctoral"
      ],
      "disciplines": [
        "STEM",
        "Engineering",
        "Computing & data",
        "Mathematics",
        "Natural sciences",
        "Environment & earth sciences",
        "Social sciences & policy",
        "Health & medicine"
      ],
      "citizenship": [
        "Other / not listed"
      ]
    }
  },
  {
    "cohort": "fait",
    "id": "fe11c501-8d14-41bf-8cc8-a7a2edb2ca50",
    "facts": {
      "academicLevels": [
        "Final one or two years of a bachelor’s degree, or a two-year master’s degree."
      ],
      "disciplines": [
        "IT-related fields, including computer science, information technology, cybersecurity, computer engineering and networking."
      ],
      "citizenship": [
        "U.S. citizens when applying."
      ],
      "eligibility": [
        "U.S. citizenship, a cumulative GPA of at least 3.2, and a full-time IT-related degree at a U.S.-based accredited institution.",
        "Undergraduates must be on track to graduate in spring 2028 for one year of funding, or spring 2029 for two years.",
        "Graduate applicants seek a full-time IT-related master’s beginning in fall 2027 and ending in spring 2029.",
        "Fellows must meet security, suitability and medical requirements and pass the Foreign Service assessments.",
        "After completing the fellowship and entry requirements, one-year fellows commit to three years of Foreign Service; two-year fellows commit to five years."
      ]
    },
    "expected": {
      "academicLevels": [
        "Undergraduate",
        "Graduate",
        "Master's"
      ],
      "disciplines": [
        "STEM",
        "Engineering",
        "Computing & data"
      ],
      "citizenship": [
        "U.S. citizens"
      ]
    }
  },
  {
    "cohort": "freeman_asia",
    "id": "06713967-eaf6-49cf-aa8d-a12d6cf1ab51",
    "facts": {
      "academicLevels": [
        "Undergraduate"
      ],
      "disciplines": [],
      "citizenship": [
        "U.S. citizens or permanent residents"
      ],
      "eligibility": [
        "First bachelor’s or associate-degree students with at least a 2.8 GPA and at least one home-institution enrollment term remaining after returning. See official rules for other study-abroad conditions.",
        "Receive need-based financial aid or demonstrate verifiable financial need for the proposed study-abroad program.",
        "Study abroad must award academic credit through the home campus or another accredited U.S. institution; internship-based programs do not qualify.",
        "Eligible destinations are Cambodia, Hong Kong, Indonesia, Japan, Korea, Laos, Macao, Malaysia, Mongolia, the Philippines, Singapore, Taiwan, Thailand and Vietnam. A multi-country program must include at least eight weeks and intensive language study in one eligible country.",
        "Prior experience in the host country is limited: summer applicants must not have spent more than four weeks there in the previous five years; semester or academic-year applicants must not have spent more than six weeks there in that period. Previous Freeman-ASIA recipients are ineligible."
      ]
    },
    "expected": {
      "academicLevels": [
        "Undergraduate"
      ],
      "disciplines": [
        "No field restriction"
      ],
      "citizenship": [
        "U.S. citizens",
        "U.S. permanent residents"
      ]
    }
  },
  {
    "cohort": "fulbright_uk_summer",
    "id": "797be24a-f4d7-45cc-8767-9f0bc2453599",
    "facts": {
      "academicLevels": [
        "Undergraduates with at least two years of study remaining after the Institute."
      ],
      "disciplines": [
        "Institute-specific historical, cultural and academic themes; background requirements depend on the selected Institute."
      ],
      "citizenship": [
        "U.S. citizens holding a U.S. passport."
      ],
      "eligibility": [
        "Published 2026 rules: Published 2026 rules require U.S. citizenship and a U.S. passport, little or no study/travel outside North America, GPA of at least 3.6, age 18 by the programme start and at least two undergraduate years remaining after the Institute.",
        "Published 2026 rules: Participants must attend the whole programme and must not join another study abroad programme during summer 2026."
      ]
    },
    "expected": {
      "academicLevels": [
        "Undergraduate"
      ],
      "disciplines": [
        "Multiple fields (check courses)"
      ],
      "citizenship": [
        "U.S. citizens"
      ]
    }
  },
  {
    "cohort": "fulbright_us_student",
    "id": "5dd1afc1-a560-495a-9bee-1f26f835475b",
    "facts": {
      "academicLevels": [
        "Bachelor’s degree or equivalent must be conferred before the grant begins. In creative and performing arts, four years of professional training or experience can meet the basic requirement; applicants without a bachelor’s should confirm eligibility with the programme before applying."
      ],
      "disciplines": [
        "Program opportunities span academic disciplines, including creative and performing arts; availability and restrictions depend on the host-country award."
      ],
      "citizenship": [
        "U.S. citizens or U.S. nationals at the deadline; permanent residents are ineligible. Dual-citizen eligibility for the other country depends on that award's rules."
      ],
      "eligibility": [
        "Meet the award-specific language requirements and demonstrate enough language ability to carry out the project and adjust to life in the host country.",
        "Applicants holding, or who will hold, a Ph.D. by the national application deadline are ineligible; a J.D. is permitted.",
        "Medical-degree study abroad, medical internships or residencies, clinical training, patient care or patient contact are not funded. M.D. holders may receive grants for advanced academic study; those who completed postgraduate medical training and propose hospital or clinic research should use the U.S. Scholar programme.",
        "Anyone resident abroad for five or more of the six years before the national deadline is ineligible; nine months abroad in a calendar year counts as a year. Host-country award rules may impose additional residence restrictions; extensive prior host-country experience is generally a competitive disadvantage rather than automatic ineligibility."
      ]
    },
    "expected": {
      "academicLevels": [
        "Undergraduate",
        "Degree holder"
      ],
      "disciplines": [
        "STEM",
        "Engineering",
        "Computing & data",
        "Mathematics",
        "Natural sciences",
        "Environment & earth sciences",
        "Social sciences & policy",
        "Arts",
        "Business & law",
        "Health & medicine",
        "Education",
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
    "id": "7007882c-af99-4919-ad2c-2672ffcccfaf",
    "facts": {
      "academicLevels": [
        "Graduating seniors and applicants who graduated during the previous academic year; applicants who began graduate studies are excluded except for the stated completed joint-degree exception."
      ],
      "disciplines": [],
      "citizenship": [
        "Applicants attending a university in the United States: U.S. citizenship is not required for applicants attending a university located in the United States. All applicants still need U.S. work authorization for the stated employment period.",
        "Applicants attending a participating university outside the United States: Applicants attending a participating university outside the United States must be U.S. citizens.",
        "F-1 students: F-1 students may apply if they are eligible to work in the United States for the full year."
      ],
      "eligibility": [
        "Applicants must be graduating seniors or have graduated during the previous academic year. Starting graduate studies makes an applicant ineligible, except for a completed joint bachelor’s/master’s degree programme.",
        "Applications are accepted only through participating universities and designated nominating officials."
      ]
    },
    "expected": {
      "academicLevels": [
        "Undergraduate",
        "Recent graduate"
      ],
      "disciplines": [
        "Social sciences & policy",
        "Multiple fields (check courses)"
      ],
      "citizenship": [
        "U.S. citizens",
        "Country-specific criteria",
        "Work authorization"
      ]
    }
  },
  {
    "cohort": "gates_cambridge",
    "id": "b6fc3596-4f9a-4cab-ba83-69b3e5387774",
    "facts": {
      "academicLevels": [
        "Postgraduate only: eligible full-time master’s programmes and full-time or part-time PhDs; no undergraduate degrees."
      ],
      "disciplines": [
        "Any subject available at Cambridge within the scholarship’s eligible postgraduate degree types."
      ],
      "citizenship": [
        "Citizens of countries outside the United Kingdom are eligible; dual citizens of the UK and another country may apply."
      ],
      "eligibility": [
        "Degree eligibility: Apply for an eligible Cambridge PhD (full-time or part-time pilot), full-time MLitt or eligible full-time one-year postgraduate course. Undergraduate, MASt, non-PhD part-time and listed professional/non-standard courses are excluded.",
        "Current Cambridge students: Current Cambridge students may apply for a new postgraduate course, including a second Gates scholarship for a new degree; funding cannot cover the remainder of a course already started. All current Cambridge students are considered in the international round.",
        "Scholarship academic criteria: Gates has no minimum GPA requirement; academic excellence is assessed across the application and references."
      ]
    },
    "expected": {
      "academicLevels": [
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
        "Environment & earth sciences",
        "Social sciences & policy",
        "Arts",
        "Business & law",
        "Health & medicine",
        "Education",
        "Multiple fields (check courses)"
      ],
      "citizenship": [
        "Country-specific criteria"
      ]
    }
  },
  {
    "cohort": "gem",
    "id": "4b7cef78-b2c9-4463-ad3e-0f42a9164425",
    "facts": {
      "academicLevels": [
        "MS fellowship: Master's-level graduate study.",
        "PhD fellowship: Doctoral graduate study."
      ],
      "disciplines": [
        "Engineering and science graduate study at GEM member universities, including computing, data science, mathematics and the listed life/physical sciences; check the programme’s eligible-discipline list and university department requirements."
      ],
      "citizenship": [
        "U.S. citizenship or U.S. permanent residency is required at the time of application."
      ],
      "eligibility": [
        "MS applicants need a minimum cumulative GPA of 2.8/4.0; PhD applicants need 3.0/4.0. At least one year must remain in the programme when the fellowship is awarded.",
        "The fellowship requires admission to a GEM member university STEM graduate programme with confirmed departmental funding. Online programmes are not funded. Universities may impose additional residency, assistantship or other requirements.",
        "Apply to at least three GEM member universities, except when already matriculated in the same graduate programme for which support is sought and that programme confirms willingness in writing to support the applicant as a GEM Fellow. This exception does not apply merely because an undergraduate institution offers support, or when moving from an MS to a PhD.",
        "Employer-sponsored fellows must accept the sponsor’s summer internship obligation: MS fellows contract for two summers; PhD fellows for at least the summer immediately after sponsorship. Summer-school substitution requires an approved special-circumstance waiver."
      ]
    },
    "expected": {
      "academicLevels": [
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
        "Environment & earth sciences",
        "Health & medicine"
      ],
      "citizenship": [
        "U.S. citizens",
        "U.S. permanent residents"
      ]
    }
  },
  {
    "cohort": "gilman",
    "id": "c699e979-fbbe-4d58-8a4a-fc36fe6db833",
    "facts": {
      "academicLevels": [
        "Undergraduates at accredited U.S. two- or four-year institutions; community-college and transfer students are encouraged. High-school, graduate and postgraduate study are not funded.",
        "No minimum GPA requirement, although academic preparedness/performance is considered in selection."
      ],
      "disciplines": [],
      "citizenship": [
        "U.S. citizens or U.S. nationals; permanent residents alone are not eligible.",
        "Pending naturalization: FAQ allows an applicant expecting naturalization before the abroad program begins to apply, but funds require proof of U.S. citizenship (naturalization certificate or passport)."
      ],
      "eligibility": [
        "Undergraduate in good standing at an accredited two- or four-year U.S. institution; receive a Pell Grant during application or the abroad term; propose a credit-bearing study/internship program and provide acceptance before disbursement.",
        "Destination and all program areas must satisfy State Department Level 1/2 travel rules; Level 3/4 areas and applicable NDAA Section 1286-listed overseas institutions are excluded.",
        "Gilman funding can be received only once; a previous award decline does not prevent reapplication if otherwise eligible.",
        "STEM supplement: Applicants do not need to major in a STEM field to seek the STEM supplemental award, but must describe the STEM-related coursework abroad, demonstrate a strong interest in that work and explain its connection to future academic and career goals."
      ]
    },
    "expected": {
      "academicLevels": [
        "Undergraduate"
      ],
      "disciplines": [
        "STEM",
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
    "cohort": "goldwater",
    "id": "4a2c1160-d5bc-41db-b645-d51030585275",
    "facts": {
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
      "eligibility": [
        "Currently or previously matriculated sophomore or junior at an accredited two- or four-year U.S. institution; full-time matriculation during funded academic terms; GPA at least 3.00 on a 4.00 scale; an eligible research career.",
        "Medicine, veterinary medicine and engineering qualify only when research is central to career goals. Clinical medical practice, engineering design and social/behavioral psychology research are not supported; translational research and neuroscience research are supported.",
        "Every applicant must be nominated through their Campus Representative; the campus deadline comes before the national nomination deadline."
      ]
    },
    "expected": {
      "academicLevels": [
        "Undergraduate"
      ],
      "disciplines": [
        "STEM",
        "Engineering",
        "Computing & data",
        "Mathematics",
        "Natural sciences",
        "Environment & earth sciences",
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
    "cohort": "hertz",
    "id": "4d2f6a7f-024e-4194-be31-1b9f63e497bc",
    "facts": {
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
      "eligibility": [
        "Normally first- or second-year PhD students in fall 2027, pursuing a full-time, in-person U.S. PhD in applied physical/biological sciences, mathematics or engineering and work addressing major near-term societal problems.",
        "Only the PhD portion of an MD/PhD can be funded; professional degrees alone are not eligible.",
        "Beyond the standard PhD window: Applicants already beyond the first PhD year may apply in rare cases, but must explain the circumstances justifying the nonstandard timing and how the fellowship would provide exceptional leverage for their graduate work."
      ]
    },
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
        "Environment & earth sciences",
        "Health & medicine"
      ],
      "citizenship": [
        "U.S. citizens",
        "U.S. permanent residents"
      ]
    }
  },
  {
    "cohort": "james_madison",
    "id": "592d1ab0-7eff-402a-82ba-90d19559aa7f",
    "facts": {
      "academicLevels": [
        "Master’s degree"
      ],
      "disciplines": [
        "MA in American history, political science or government; MAT in history, political science or government; or MEd permitting a concentration in American history, American government, social studies or political science. The degree must include at least 12 semester credits (18 quarter credits) of approved U.S. constitutional study."
      ],
      "citizenship": [
        "U.S. citizens"
      ],
      "eligibility": [
        "U.S. citizens committed to teaching U.S. constitutional topics full-time in grades 7–12; see official guidance for degree and teaching obligations.",
        "Hold a bachelor’s degree or receive it by August 31 of the application year.",
        "After the master’s degree, teach American history, American government, social studies or political science in grades 7–12 in person for one full year for each academic year of fellowship funding.",
        "For a second master’s degree, the previous master’s must have been completed at least three years before fellowship study begins."
      ]
    },
    "expected": {
      "academicLevels": [
        "Graduate",
        "Master's"
      ],
      "disciplines": [
        "Social sciences & policy",
        "Arts",
        "Education"
      ],
      "citizenship": [
        "U.S. citizens"
      ]
    }
  },
  {
    "cohort": "knight_hennessy",
    "id": "141944a8-fd04-4433-b0e4-8990fae56764",
    "facts": {
      "academicLevels": [
        "Graduate"
      ],
      "disciplines": [
        "All fields of study"
      ],
      "citizenship": [
        "No citizenship restriction. Stanford admission requirements and location/residency restrictions still apply.",
        "Applicants with DACA status, no formal citizenship or undocumented status are also eligible."
      ],
      "eligibility": [
        "New Stanford degree applicants apply separately to KHS and an eligible full-time Stanford graduate program, starting both in the same year. Current students adding a new degree must also align its start with KHS. Already-deferred admits and eligible current first-year Stanford PhD students starting KHS in year two submit only the KHS application, without a new graduate-program application.",
        "For the 2027 cohort, earn the first bachelor’s degree or equivalent in January 2020 or later, or January 2018 or later for applicants who served in the military. Current undergraduates must finish that first degree by September 2027; a later graduate degree does not reset the first-degree eligibility window.",
        "Listed ineligible KHS routes include the Honors Cooperative Program, Master of Liberal Arts and JSD. Adding an MA/MS in a current Stanford PhD student’s PhD discipline is not an eligible KHS route. Coterminal degrees do not qualify; current coterminal students may qualify by applying externally to a new full-time Stanford degree and starting it in the same year as KHS.",
        "There is no KHS age restriction. The current eligibility page notes that Stanford cannot process applications from people currently in Iran or ordinarily resident there; applicants should check Stanford’s current restrictions."
      ]
    },
    "expected": {
      "academicLevels": [
        "Undergraduate",
        "Degree holder",
        "Graduate",
        "Master's",
        "Doctoral",
        "Professional"
      ],
      "disciplines": [
        "No field restriction"
      ],
      "citizenship": [
        "DACA / undocumented",
        "All nationalities"
      ]
    }
  },
  {
    "cohort": "luce",
    "id": "a643d94e-216b-4449-bf2f-99d8503793d7",
    "facts": {
      "academicLevels": [
        "Graduating seniors, recent graduates and young professionals, with at least a bachelor’s degree by program start."
      ],
      "disciplines": [
        "Wide-ranging fields, including arts, journalism, law, medicine, public health, science, business, environmental studies and international relations. Asian Studies majors are not excluded."
      ],
      "citizenship": [
        "U.S. citizens or permanent residents."
      ],
      "eligibility": [
        "Be at least 18 with a bachelor’s degree or equivalent by orientation in late June, and under 33 when departing for Asia.",
        "Recent Asia exposure matters: six consecutive months or more than one cumulative year in the past five years in one placement country does not prevent application, but placement will be in a different country. Reaching those thresholds in more than one placement country makes an applicant ineligible."
      ]
    },
    "expected": {
      "academicLevels": [
        "Undergraduate",
        "Recent graduate",
        "Degree holder"
      ],
      "disciplines": [
        "STEM",
        "Engineering",
        "Computing & data",
        "Mathematics",
        "Natural sciences",
        "Environment & earth sciences",
        "Social sciences & policy",
        "Arts",
        "Business & law",
        "Health & medicine",
        "Education",
        "Multiple fields (check courses)"
      ],
      "citizenship": [
        "U.S. citizens",
        "U.S. permanent residents"
      ]
    }
  },
  {
    "cohort": "marshall",
    "id": "4c02307f-5928-4066-8f97-bd704b372184",
    "facts": {
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
      "eligibility": [
        "Undergraduate GPA must be at least 3.7/4.0 at application; rounded GPAs are not accepted.",
        "Applicants must not have studied for or held a British university degree or degree-equivalent qualification, or undertaken GCSEs or A-levels in the UK. Undergraduate junior-year-abroad or similar study without a British degree does not by itself make an applicant ineligible."
      ]
    },
    "expected": {
      "academicLevels": [
        "Undergraduate",
        "Recent graduate",
        "Degree holder"
      ],
      "disciplines": [
        "STEM",
        "Engineering",
        "Computing & data",
        "Mathematics",
        "Natural sciences",
        "Environment & earth sciences",
        "Social sciences & policy",
        "Arts",
        "Business & law",
        "Health & medicine",
        "Education",
        "Multiple fields (check courses)"
      ],
      "citizenship": [
        "U.S. citizens"
      ]
    }
  },
  {
    "cohort": "mccall_macbain",
    "id": "109337e6-5309-4ac8-8647-1bb6c67e9b38",
    "facts": {
      "academicLevels": [
        "Eligible master’s or second-entry professional degrees; bachelor’s-degree timing rules apply."
      ],
      "disciplines": [],
      "citizenship": [
        "Canadian and international candidates are eligible, with different endorsement rules."
      ],
      "eligibility": [
        "Meet one condition: current student on track to earn a first bachelor’s degree by August 2027; first degree earned January 2021 or later; or an older first degree and age 30 or younger on January 1, 2026.",
        "Apply separately to and gain admission to an eligible full-time McGill program, normally at least 45 credits.",
        "University endorsement depends on citizenship, institution and graduation year; some earlier graduates apply directly.",
        "The separate McGill program application fee is not covered."
      ]
    },
    "expected": {
      "academicLevels": [
        "Undergraduate",
        "Degree holder",
        "Graduate",
        "Master's",
        "Professional"
      ],
      "disciplines": [
        "STEM",
        "Engineering",
        "Computing & data",
        "Mathematics",
        "Natural sciences",
        "Environment & earth sciences",
        "Social sciences & policy",
        "Arts",
        "Business & law",
        "Health & medicine",
        "Education",
        "Multiple fields (check courses)"
      ],
      "citizenship": [
        "All nationalities",
        "Country-specific criteria"
      ]
    }
  },
  {
    "cohort": "ndseg",
    "id": "e776ca2f-4b2c-431e-a3f9-248ad78c30e8",
    "facts": {
      "academicLevels": [
        "Bachelor's degree completed by 2026 for the fall 2027 fellowship; new entrants or early graduate students within the first two years, with at least three degree years remaining.",
        "The fellowship supports pursuit of a doctoral degree at a U.S. institution, with research aligned to the DoD services’ Broad Agency Announcements."
      ],
      "disciplines": [
        "Science and engineering research in designated defense-relevant disciplines. Proposed research must align with specific DoD Broad Agency Announcement topics; current tri-service BAAs govern the relevant research areas."
      ],
      "citizenship": [
        "U.S. citizens, U.S. dual citizens and U.S. nationals. Permanent residents and people merely awaiting citizenship are ineligible."
      ],
      "eligibility": [
        "U.S. citizen, dual citizen or national; bachelor's degree earned by the application year (by 2026 for fall 2027 funding); applying to/accepted/enrolled at an accredited U.S. graduate institution, within the first two graduate years if enrolled, with at least three years remaining and DoD-aligned research.",
        "Permanent residents and applicants pursuing only a medical degree are not eligible."
      ]
    },
    "expected": {
      "academicLevels": [
        "Degree holder",
        "Graduate",
        "Doctoral"
      ],
      "disciplines": [
        "STEM",
        "Engineering",
        "Computing & data",
        "Mathematics",
        "Natural sciences",
        "Environment & earth sciences",
        "Social sciences & policy",
        "Health & medicine",
        "Multiple fields (check courses)"
      ],
      "citizenship": [
        "U.S. citizens",
        "U.S. nationals"
      ]
    }
  },
  {
    "cohort": "nih_oxcam",
    "id": "dc1674f0-0bd2-4546-afc8-1034ea213274",
    "facts": {
      "academicLevels": [
        "Bachelor’s degree holders entering doctoral research."
      ],
      "disciplines": [
        "Biomedical research."
      ],
      "citizenship": [
        "U.S. citizens or permanent residents."
      ],
      "eligibility": [
        "U.S. citizens or permanent residents with a bachelor’s degree by the program start.",
        "The NIH GPP application has no fee; the Oxford or Cambridge application may have a separate fee."
      ]
    },
    "expected": {
      "academicLevels": [
        "Degree holder",
        "Graduate",
        "Doctoral"
      ],
      "disciplines": [
        "STEM",
        "Natural sciences",
        "Health & medicine"
      ],
      "citizenship": [
        "U.S. citizens",
        "U.S. permanent residents"
      ]
    }
  },
  {
    "cohort": "noaa_hollings",
    "id": "a9b42e3f-6d7e-4b0d-8132-77c2042b311d",
    "facts": {
      "academicLevels": [
        "At application, be a full-time second-year student in a four-year undergraduate programme, a third-year student in a five-year programme, or a community-college/transfer applicant to a four-year institution in the U.S. or its territories. Transfer applicants need proof of application and, if selected, acceptance before September 15.",
        "For the 2027 cycle, the anticipated bachelor’s graduation date must fall between December 2028 and August 2029. Graduation date determines eligibility even where AP/IB credits change class standing; students classified as graduate students in dual-degree programmes are ineligible."
      ],
      "disciplines": [
        "A declared NOAA-mission major, including oceanic, environmental, biological or atmospheric sciences; mathematics; engineering; remote sensing; computer/information science; relevant physical/social sciences; or teacher education. The list is not exhaustive."
      ],
      "citizenship": [
        "U.S. citizenship is required at the time of application."
      ],
      "eligibility": [
        "Earn and maintain at least a 3.0 cumulative GPA on a 4.0 scale or equivalent and full-time status between application and award. Applicants with documented extenuating circumstances for a part-time term may contact programme staff for review.",
        "Federal employees, including Pathways student interns, cannot receive the scholarship. Other awards must not conflict with programme requirements or provide overlapping federal funding."
      ]
    },
    "expected": {
      "academicLevels": [
        "Undergraduate"
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
    "id": "d955a846-cee1-4c01-932e-e3cb7215f3fb",
    "facts": {
      "academicLevels": [
        "Level 1: bachelor's seniors or bachelor's holders with no prior graduate-degree enrollment. Level 2: joint bachelor's/master's students in the final undergraduate or first graduate year, or first-year students in their first graduate degree program.",
        "One application per annual competition; after graduate-degree enrollment, only one application is allowed in the first year of the first graduate program."
      ],
      "disciplines": [
        "Only Major Fields of Study and subfields listed in the current NSF GRFP Notice of Funding Opportunity are eligible. Select the field closest to the proposed graduate program and research plan; first-year fellowship enrollment must remain consistent with that field."
      ],
      "citizenship": [
        "U.S. citizens, U.S. nationals and permanent residents at the application deadline and, if offered, at fellowship acceptance. Student-visa holders and applicants awaiting green cards are not eligible."
      ],
      "eligibility": [
        "U.S. citizen, national or permanent resident at the application deadline and, if offered, at acceptance; eligible full-time research master's/doctoral STEM study; less than one completed academic year in a graduate degree program and no previously accepted GRFP.",
        "Applicants who previously applied to GRFP while enrolled in a degree-granting graduate programme, master's/doctoral/terminal degree holders, current NSF employees and professional or joint professional-research degree students are ineligible."
      ]
    },
    "expected": {
      "academicLevels": [
        "Undergraduate",
        "Degree holder",
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
        "Environment & earth sciences",
        "Social sciences & policy",
        "Health & medicine",
        "Multiple fields (check courses)"
      ],
      "citizenship": [
        "U.S. citizens",
        "U.S. nationals",
        "U.S. permanent residents"
      ]
    }
  },
  {
    "cohort": "pickering",
    "id": "06b39341-8489-4c72-a555-dfd96d336f4b",
    "facts": {
      "academicLevels": [
        "Master’s degree"
      ],
      "disciplines": [
        "Approved fields relevant to the Foreign Service"
      ],
      "citizenship": [
        "U.S. citizens"
      ],
      "eligibility": [
        "U.S. citizens with at least a 3.2 cumulative undergraduate GPA, seeking an approved full-time master’s programme in the Washington, D.C. area. Applicants must be graduates or seniors completing their degree by June 2027. See official guidance for conditional 2027 testing rules and other requirements."
      ]
    },
    "expected": {
      "academicLevels": [
        "Undergraduate",
        "Degree holder",
        "Graduate",
        "Master's"
      ],
      "disciplines": [
        "Social sciences & policy",
        "Business & law"
      ],
      "citizenship": [
        "U.S. citizens"
      ]
    }
  },
  {
    "cohort": "ppia_jsi",
    "id": "874d043a-3819-4032-a7c4-bb9582a1d51f",
    "facts": {
      "academicLevels": [
        "Undergraduate juniors"
      ],
      "disciplines": [
        "Graduate-level coursework in policy, economics, statistics, leadership and related areas."
      ],
      "citizenship": [],
      "eligibility": [
        "College juniors graduating in December 2027 or May–August 2028."
      ]
    },
    "expected": {
      "academicLevels": [
        "Undergraduate"
      ],
      "disciplines": [
        "STEM",
        "Mathematics",
        "Social sciences & policy"
      ],
      "citizenship": [
        "Other / not listed"
      ]
    }
  },
  {
    "cohort": "princeton_africa",
    "id": "ecc92ab9-beac-4771-8bd4-c7e305519dfc",
    "facts": {
      "academicLevels": [
        "Bachelor’s, master’s or Ph.D. holders and current undergraduates graduating by June 2027, subject to the program’s institution and applicant-group rules."
      ],
      "disciplines": [],
      "citizenship": [
        "Citizens of any country may apply if they meet the full eligibility rules; host-country visa eligibility can affect placement.",
        "Nexus applicants: Nexus applicants must be citizens of an African country, reside in Africa and have a qualifying African-university degree."
      ],
      "eligibility": [
        "Young professionals or undergraduates graduating by June 2027, with a qualifying bachelor’s, master’s or Ph.D. Applicants must be no older than 35 throughout the fellowship year and cannot enroll in advanced study during it.",
        "General applicants need a four-year undergraduate or graduate degree from a U.S.-accredited university. Nexus applicants need a qualifying degree from a locally accredited African university, African citizenship and residence on the African continent.",
        "Professional English proficiency at CEFR C1 or above is required; other language needs vary by post.",
        "There is no application fee, but accepting an offer requires a $350 placement fee. Fellows may also pay airfare, pre-departure medical costs and part of visa costs; need-based financial aid is available after placement."
      ]
    },
    "expected": {
      "academicLevels": [
        "Undergraduate",
        "Degree holder"
      ],
      "disciplines": [
        "STEM",
        "Environment & earth sciences",
        "Social sciences & policy",
        "Business & law",
        "Health & medicine",
        "Education",
        "Multiple fields (check courses)"
      ],
      "citizenship": [
        "All nationalities",
        "Country-specific criteria"
      ]
    }
  },
  {
    "cohort": "princeton_asia",
    "id": "d80105aa-41c2-454d-9afa-a8639d63ce0a",
    "facts": {
      "academicLevels": [
        "College seniors and graduates with a bachelor’s degree by the fellowship start; master’s degree holders may also apply."
      ],
      "disciplines": [],
      "citizenship": [
        "Any nationality. Non-U.S. citizens must have lived in the U.S. for at least a year or graduated from a U.S.-accredited institution; host-country visa rules can limit available placements."
      ],
      "eligibility": [
        "A bachelor’s degree is required by the fellowship start; some positions need additional experience or credentials. Master’s degree holders are eligible, but Ph.D., M.D. and J.D. holders are not.",
        "Professional English is required; teaching posts require native or near-native English. Language and skills requirements vary by post.",
        "There is no application fee. Fellows generally pay pre-departure vaccination costs and round-trip airfare, although travel grants or host support may help."
      ]
    },
    "expected": {
      "academicLevels": [
        "Undergraduate",
        "Degree holder"
      ],
      "disciplines": [
        "Environment & earth sciences",
        "Social sciences & policy",
        "Arts",
        "Business & law",
        "Health & medicine",
        "Education",
        "Multiple fields (check courses)"
      ],
      "citizenship": [
        "All nationalities",
        "Country-specific criteria"
      ]
    }
  },
  {
    "cohort": "rales",
    "id": "56f2136d-1ecf-44e3-be75-61e49c93f571",
    "facts": {
      "academicLevels": [
        "Selected master’s and doctoral programs."
      ],
      "disciplines": [
        "Eligible STEM programs in the listed CMU colleges and schools."
      ],
      "citizenship": [
        "U.S. citizens, permanent residents or DACA recipients."
      ],
      "eligibility": [
        "U.S. citizens, permanent residents or DACA recipients applying to eligible full-time, in-person graduate STEM programs on CMU’s Pittsburgh campus.",
        "Undergraduate Pell/need-based aid or first-generation criteria apply.",
        "Incoming students receive priority; current master’s students may apply if at least a full academic year of coursework remains.",
        "Separate graduate-program application deadlines and requirements still apply."
      ]
    },
    "expected": {
      "academicLevels": [
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
        "U.S. citizens",
        "U.S. permanent residents",
        "DACA / undocumented"
      ]
    }
  },
  {
    "cohort": "rangel",
    "id": "e6ebd346-0567-4464-85b1-92a555036992",
    "facts": {
      "academicLevels": [
        "Master’s degree"
      ],
      "disciplines": [
        "Approved fields relevant to the Foreign Service"
      ],
      "citizenship": [
        "U.S. citizens"
      ],
      "eligibility": [
        "U.S. citizens with at least a 3.2 cumulative undergraduate GPA, seeking an approved full-time master’s programme in the Washington, D.C. area. Applicants must be graduates or seniors completing their degree by June 2027. See official guidance for the 2027 testing rules and other requirements."
      ]
    },
    "expected": {
      "academicLevels": [
        "Undergraduate",
        "Degree holder",
        "Graduate",
        "Master's"
      ],
      "disciplines": [
        "Social sciences & policy",
        "Business & law"
      ],
      "citizenship": [
        "U.S. citizens"
      ]
    }
  },
  {
    "cohort": "rhodes_us",
    "id": "3e0c02fe-70cc-4933-81c4-b58ac4036bff",
    "facts": {
      "academicLevels": [
        "Postgraduate"
      ],
      "disciplines": [
        "Multiple fields (check courses)"
      ],
      "citizenship": [
        "U.S. citizens, lawful permanent residents who have maintained and expect to maintain that status, and people with active (unexpired) DACA status may apply if they meet the other criteria.",
        "DACA applicants are responsible for assessing travel to the UK and return to the United States; the Rhodes Trust does not provide support or representations about those travel permissions.",
        "Applicants with strong connections to two or more Rhodes constituencies who do not meet the nationality or citizenship criteria may qualify through separate Inter-Jurisdictional Consideration; age, English-language and academic criteria still apply."
      ],
      "eligibility": [
        "For the 2027 U.S. competition, be aged 18–23 on October 1, 2026; or, if you completed your first undergraduate degree later than usual, be under 27 on that date and have completed that degree on or after October 1, 2025. Degree-completion dates follow university policy; the National Secretary decides ambiguous cases.",
        "Complete an undergraduate degree (normally a bachelor’s) by July 2027 and meet or exceed the entry requirements for the chosen full-time Oxford course.",
        "A GPA of 3.70/4.0 or higher, without rounding, improves prospects for Oxford admission. For a GPA below 3.70, a special exception request must come from the university president or a designated senior administrator, with a transcript and résumé; requests should reach the American Secretary by September 15, 2026.",
        "If English is not your first language, check that you meet Oxford’s higher-level English-language requirements for the Oxford application. Evidence of language proficiency is not required as part of the Rhodes application.",
        "Choose a U.S. state or territory based on at least two years of college training and a bachelor’s degree there before October 1 of the admission year, or legal residence there on April 15 of the application year. U.S. citizens abroad who do not meet those routes may use their closest state connection; consult the National Secretary where ties are ambiguous.",
        "Applying simultaneously to more than one U.S. district or more than one Rhodes constituency disqualifies an applicant.",
        "Current Oxford postgraduate students may apply only to start a new course; the scholarship cannot fund the remaining years of an existing course."
      ]
    },
    "expected": {
      "academicLevels": [
        "Undergraduate",
        "Degree holder",
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
        "Environment & earth sciences",
        "Social sciences & policy",
        "Arts",
        "Business & law",
        "Health & medicine",
        "Education",
        "Multiple fields (check courses)"
      ],
      "citizenship": [
        "U.S. citizens",
        "U.S. permanent residents",
        "DACA / undocumented",
        "Country-specific criteria"
      ]
    }
  },
  {
    "cohort": "rotary_peace",
    "id": "4f66e3fa-3924-4d0d-a04d-a32989f74c2e",
    "facts": {
      "academicLevels": [
        "Master’s degree",
        "Postgraduate professional development certificate"
      ],
      "disciplines": [],
      "citizenship": [],
      "eligibility": [
        "Master’s degree: Bachelor’s degree, English proficiency and at least three years of full-time peace or development experience. At least three years must separate the latest degree and fellowship start; current or upcoming degree enrollment is ineligible. See official guidance for other restrictions.",
        "Professional development certificate: Bachelor’s degree, English proficiency and at least five years of full-time peace or development experience. Current or upcoming degree enrollment is ineligible; regional and other centre-specific criteria apply.",
        "Active Rotary members and employees of a Rotary club, Rotary International or another Rotary entity are ineligible. Rotaract members may apply if they are not also Rotary club members."
      ]
    },
    "expected": {
      "academicLevels": [
        "Degree holder",
        "Graduate",
        "Master's",
        "Professional"
      ],
      "disciplines": [
        "Social sciences & policy"
      ],
      "citizenship": [
        "Other / not listed"
      ]
    }
  },
  {
    "cohort": "samvid",
    "id": "406c12bc-49f3-4d4c-b90d-9ba7e4e0f70e",
    "facts": {
      "academicLevels": [
        "Incoming first-year graduate students; qualifying dual degrees and a master’s portion of a master’s/PhD lasting at least two years may qualify."
      ],
      "disciplines": [],
      "citizenship": [
        "U.S. citizens or DACA recipients; permanent residents are not eligible."
      ],
      "eligibility": [
        "For 2027 selection, enter the first year of a full-time U.S. graduate program lasting at least two years in 2027–2028. Eligible programs are MD, MBA, JD, MPP/MPA, MPH, and MA/MS programs in STEM or the social sciences.",
        "Have an undergraduate GPA of at least 3.50 without rounding; graduate or other degree GPAs cannot substitute.",
        "DO, MSW, DPT and MSN degree programs are not eligible.",
        "Applicants may apply while graduate admissions decisions are pending; selected scholars must confirm enrollment in a qualifying program."
      ]
    },
    "expected": {
      "academicLevels": [
        "Graduate",
        "Master's",
        "Professional"
      ],
      "disciplines": [
        "STEM",
        "Engineering",
        "Computing & data",
        "Mathematics",
        "Natural sciences",
        "Environment & earth sciences",
        "Social sciences & policy",
        "Business & law",
        "Health & medicine"
      ],
      "citizenship": [
        "U.S. citizens",
        "DACA / undocumented"
      ]
    }
  },
  {
    "cohort": "schwarzman",
    "id": "dd23afbb-299e-489f-8a0b-e4d7506848de",
    "facts": {
      "academicLevels": [
        "Class of 2028–2029: Applicants may be completing undergraduate study or already hold undergraduate/graduate degrees; the required undergraduate degree must be conferred by August 1, 2028. The funded course is a master’s degree."
      ],
      "disciplines": [
        "All undergraduate fields are welcome; applicants should explain how Schwarzman develops their leadership potential in their field."
      ],
      "citizenship": [
        "U.S./Global applicants must be non-Chinese citizens with an ordinary passport from a country other than China. Chinese citizens from mainland China, Hong Kong, Macau and Taiwan use the separate China application route.",
        "Class of 2028–2029 U.S./Global applicants born in China who were formerly resident in mainland China, Hong Kong, Macau or Taiwan, emigrated and acquired foreign nationality must have held a foreign passport or nationality document by April 30, 2022.",
        "U.S./Global applicants with a parent who was Chinese at their birth must document that each such parent held foreign permanent residence or nationality in the birth country at that time, or document renunciation of Chinese nationality, cancellation of hukou and the parents’ status at enrollment. The application passport must match the citizenship used for the China student visa."
      ],
      "eligibility": [
        "Class of 2028–2029 — published general criteria: The current admissions page requires an undergraduate degree by August 1, 2028 and age at least 18 but not yet 29 on that date.",
        "Teaching is in English. Non-native speakers need official scores unless they studied at least two years in an English-medium undergraduate programme, or two or more years at master’s level or higher. Minimum scores: TOEFL 5/6 or 100/120, IELTS 7, Cambridge C 1/C 2 185, or Duolingo 130. China-system applicants should follow that system’s guidance."
      ]
    },
    "expected": {
      "academicLevels": [
        "Undergraduate",
        "Degree holder",
        "Graduate",
        "Master's"
      ],
      "disciplines": [
        "No field restriction"
      ],
      "citizenship": [
        "All nationalities",
        "Country-specific criteria"
      ]
    }
  },
  {
    "cohort": "smart",
    "id": "d7d4d117-f312-456f-a75c-3dbd5d372c99",
    "facts": {
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
      "citizenship": [
        "Citizens of the United States, Australia, Canada, New Zealand or the United Kingdom may apply; permanent residents alone are ineligible."
      ],
      "eligibility": [
        "For funding beginning August 2027, be at least 18 by January 1, 2028; maintain a cumulative GPA of at least 3.0/4.0; and enroll at a regionally accredited U.S. college or university by August 1, 2027. High-school seniors and incoming freshmen pursuing a bachelor’s in fall 2027 may apply.",
        "Be able to obtain and maintain a security clearance; the sponsoring facility initiates it after award. Active-duty military applicants must separate or be on terminal leave by August 1, 2027. Reserve and National Guard members may apply; ROTC participants with a future service commitment are ineligible."
      ]
    },
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
        "U.S. citizens",
        "Country-specific criteria"
      ]
    }
  },
  {
    "cohort": "soros",
    "id": "3cf7c610-0246-4dfb-b26c-289254e40ce6",
    "facts": {
      "academicLevels": [
        "A bachelor’s degree must be completed by fall 2027; applicants may already hold a previous graduate or professional degree.",
        "Applicants may be applying to graduate school or continuing a degree, but must not have started the third year of the degree for which funding is sought by the application deadline. Joint or dual degrees must satisfy that rule for the program funded in 2027–28."
      ],
      "disciplines": [
        "All fields of eligible graduate or professional study are considered."
      ],
      "citizenship": [
        "U.S.-citizen-by-birth applicants: U.S.-citizen-by-birth applicants generally need both birth parents born abroad as non-U.S. citizens and not eligible for U.S. citizenship at birth. The page allows a single-birth-parent exception when that immigrant parent raised the applicant and the other parent was absent with no contact. Parent location/current status does not decide eligibility.",
        "Immigrant pathways: Applicants born abroad as non-U.S. citizens may qualify through naturalized citizenship, citizenship following adoption by American parents, a valid green card, or granted U.S. refugee/asylee status.",
        "U.S.-high-school-and-college pathway: If no other listed immigrant pathway applies, a person born abroad must have graduated from both high school and college in the United States; this includes current/past DACA recipients. An American high school located abroad does not satisfy that U.S.-schooling route."
      ],
      "eligibility": [
        "2027 Fellowship: All eligibility requirements must hold by the application deadline. Applicants must be 30 or younger, meet the programme’s New American definition and plan eligible full-time U.S. graduate/professional study in 2027–2028. There is no minimum age and no age exceptions.",
        "Executive graduate programs, simultaneous bachelor’s/master’s programs, certificates, post-baccalaureate programs, programs outside the United States and programs without full accreditation are ineligible."
      ]
    },
    "expected": {
      "academicLevels": [
        "Degree holder",
        "Graduate",
        "Professional"
      ],
      "disciplines": [
        "No field restriction"
      ],
      "citizenship": [
        "U.S. citizens",
        "U.S. permanent residents",
        "DACA / undocumented",
        "New American criteria"
      ]
    }
  },
  {
    "cohort": "suli",
    "id": "5a47fc09-4d3a-47b5-8a9a-6fd4a4031a56",
    "facts": {
      "academicLevels": [
        "Undergraduates, including community college students, and eligible recent graduates."
      ],
      "disciplines": [
        "Science, technology, engineering, mathematics and science policy."
      ],
      "citizenship": [
        "U.S. citizens or lawful permanent residents at the time of application."
      ],
      "eligibility": [
        "Full-time undergraduates at accredited community colleges, two-year or four-year institutions, or eligible recent graduates. Applicants must be U.S. citizens or lawful permanent residents, and age 18 by the internship start.",
        "At least one matriculated undergraduate semester, six STEM credits and twelve total undergraduate credits are required by the deadline. The current GPA minimum is 3.0 on a 4.0 scale; pre-matriculation credits do not meet the stated credit requirement.",
        "Recent bachelor’s graduates, and associate’s graduates not continuing to a bachelor’s degree, must start within two years of receiving their degree. Site-access approval applies, and participation is limited to two SULI internships."
      ]
    },
    "expected": {
      "academicLevels": [
        "Undergraduate",
        "Recent graduate"
      ],
      "disciplines": [
        "STEM",
        "Engineering",
        "Computing & data",
        "Mathematics",
        "Natural sciences",
        "Environment & earth sciences",
        "Social sciences & policy"
      ],
      "citizenship": [
        "U.S. citizens",
        "U.S. permanent residents"
      ]
    }
  },
  {
    "cohort": "tillman",
    "id": "cb8740aa-4585-4e1c-a939-35fc854cb12b",
    "facts": {
      "academicLevels": [
        "Bachelor’s, graduate or professional degree"
      ],
      "disciplines": [],
      "citizenship": [],
      "eligibility": [
        "Eligible U.S. military service members, veterans and current or surviving military spouses planning full-time study at an accredited U.S.-based institution.",
        "Associate degrees, certificates and trade certifications are not eligible; eligible programs include bachelor’s, master’s and professional degrees at accredited U.S.-based institutions.",
        "Child dependents and cadets/current ROTC participants with a future service commitment are not eligible.",
        "There is no minimum GPA to apply. Selected scholars must maintain at least a 3.0 GPA to be considered for scholarship renewal."
      ]
    },
    "expected": {
      "academicLevels": [
        "Undergraduate",
        "Graduate",
        "Master's",
        "Professional"
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
    "cohort": "truman",
    "id": "bf04d4c1-4db3-4f4e-bf1b-e4dbca7bb7d3",
    "facts": {
      "academicLevels": [
        "Full-time junior-level undergraduates at four-year institutions in 2026–2027: normally graduating between December 2027 and August 2028, or third-year students graduating during 2026–2027."
      ],
      "disciplines": [
        "Any graduate/professional degree with a credible path to public service, including policy, law, education, health, sciences and other fields; domestic and overseas study can be funded. MBA support is rare and requires a clear public-service connection."
      ],
      "citizenship": [
        "U.S. citizens or U.S. nationals from American Samoa; permanent residents alone are not eligible. Applicants awaiting U.S. citizenship must become citizens before the award date."
      ],
      "eligibility": [
        "Be a full-time junior-level student pursuing a bachelor’s degree during the 2026–2027 academic year, with a record of public and community service and a commitment to a career in public service.",
        "Students completing a degree in three or fewer years apply in their final full year; those taking four or more years apply in their penultimate year. Off-campus students may apply if their institution is willing to nominate them.",
        "Nominees must be nominated by their institution’s Truman Faculty Representative and be in the upper quarter of their class."
      ]
    },
    "expected": {
      "academicLevels": [
        "Undergraduate"
      ],
      "disciplines": [
        "STEM",
        "Engineering",
        "Computing & data",
        "Mathematics",
        "Natural sciences",
        "Environment & earth sciences",
        "Social sciences & policy",
        "Arts",
        "Business & law",
        "Health & medicine",
        "Education",
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
    "cohort": "udall_undergraduate",
    "id": "ef4c98ad-ffaa-4f15-9771-d9a94487bf0d",
    "facts": {
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
      "eligibility": [
        "Environment: U.S. citizens, nationals and lawful permanent residents who are sophomore- or junior-level students at accredited higher-education institutions and intend to pursue careers related to the environment; the published criteria also retain other appropriate Foundation eligibility requirements.",
        "Tribal Policy: Native American or Alaska Native college sophomores or juniors pursuing Tribal public policy careers, with the U.S. status and enrolled federally recognized tribal membership specified in the 2027 criteria. The provider asks about commitment and service to Indian country.",
        "Native Health Care: Native American or Alaska Native college sophomores or juniors pursuing Native health-related careers, with the U.S. status and enrolled federally recognized tribal membership specified in the 2027 criteria. The category includes health-care practice/delivery or policy/research serving Indian country."
      ]
    },
    "expected": {
      "academicLevels": [
        "Undergraduate"
      ],
      "disciplines": [
        "STEM",
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
    "cohort": "voyager",
    "id": "10dda818-c922-47ac-8b56-55494c2c889f",
    "facts": {
      "academicLevels": [
        "2026–2028 published cohort: Undergraduate junior and senior years"
      ],
      "disciplines": [
        "2026–2028 published cohort: No restriction to a particular area of study or degree program; funding is for undergraduate study only."
      ],
      "citizenship": [
        "2026–2028 published cohort: U.S. citizens, U.S. nationals, U.S. permanent residents and DACA recipients"
      ],
      "eligibility": [
        "2026–2028 published cohort: The latest published cohort required rising juniors at an accredited U.S. four-year institution in Fall 2026, demonstrated financial need and public service commitment, and at least a 3.0 GPA. These dates are historical cohort requirements.",
        "2026–2028 published cohort: Senior-year renewal requires at least a 2.5 GPA and active participation in required monthly programming."
      ]
    },
    "expected": {
      "academicLevels": [
        "Undergraduate"
      ],
      "disciplines": [
        "No field restriction"
      ],
      "citizenship": [
        "U.S. citizens",
        "U.S. nationals",
        "U.S. permanent residents",
        "DACA / undocumented"
      ]
    }
  },
  {
    "cohort": "watson",
    "id": "80424f3b-1b94-4cb1-977c-b6cfdd5a8381",
    "facts": {
      "academicLevels": [
        "Graduating bachelor’s students."
      ],
      "disciplines": [
        "All majors and fields of inquiry."
      ],
      "citizenship": [
        "U.S. citizens and international students at partner institutions."
      ],
      "eligibility": [
        "Apply in the academic year you receive your bachelor’s degree and obtain nomination from a partner college. No at-large applications.",
        "Fellows remain outside the U.S. and, if different, their home country for 12 consecutive months. Formal employment and academic affiliation are excluded."
      ]
    },
    "expected": {
      "academicLevels": [
        "Undergraduate"
      ],
      "disciplines": [
        "No field restriction"
      ],
      "citizenship": [
        "U.S. citizens",
        "All nationalities"
      ]
    }
  },
  {
    "cohort": "yenching",
    "id": "2da1b35d-fe8b-46cd-bc4b-b099e0fd1363",
    "facts": {
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
      "eligibility": [
        "Bachelor's degree in any field, or completion by August of the intended enrollment year; strong academics, interest in interdisciplinary China Studies, extracurricular/community achievement, leadership potential and English proficiency.",
        "No concurrent enrollment in another degree program."
      ]
    },
    "expected": {
      "academicLevels": [
        "Undergraduate",
        "Degree holder",
        "Graduate",
        "Master's"
      ],
      "disciplines": [
        "No field restriction"
      ],
      "citizenship": [
        "Country-specific criteria"
      ]
    }
  }
];

describe("current 50-award directory category review", () => {
 it("reviews exactly 50 distinct identities and relevant-field bindings", () => { expect(cases).toHaveLength(50); expect(new Set(cases.map(r => r.id)).size).toBe(50); expect(new Set(cases.map(r => directoryCategoryReviewKey(r.id, r.facts))).size).toBe(50); });
 it.each(cases)("returns every supported $cohort category without changing source facts", row => { const before = structuredClone(row.facts); const reviewed = getReviewedAwardDirectoryCategories(row.id, row.facts); expect(reviewed).toEqual(row.expected); expect(getAwardDirectoryCategories({ ...row.facts, reviewedCategories: reviewed })).toEqual(row.expected); expect(row.facts).toEqual(before); });
 it.each(cases)("expires $cohort review for a different award or changed eligibility/audience", row => { expect(getReviewedAwardDirectoryCategories("wrong-award", row.facts)).toBeUndefined(); for (const field of ["academicLevels", "disciplines", "citizenship", "eligibility"] as const) expect(getReviewedAwardDirectoryCategories(row.id, { ...row.facts, [field]: [...row.facts[field], "Changed official rule"] })).toBeUndefined(); });
 it("preserves review after unrelated deadline and funding updates", () => { const row = cases.find(r => r.cohort === "noaa_hollings")!; const facts = { ...row.facts, deadline: "An unrelated new date", awardAmount: "$5,000" }; expect(getReviewedAwardDirectoryCategories(row.id, facts)).toEqual(row.expected); });
 it("fixes the combined Undergraduate plus STEM search for NOAA", () => { const row = cases.find(r => r.cohort === "noaa_hollings")!; expect(matchesDirectorySelections(row.expected, { academicLevels: ["Undergraduate"], disciplines: ["STEM"], citizenship: [] })).toBe(true); expect(row.expected.academicLevels).not.toContain("Graduate"); });
 it.each(["amgen_us", "astronaut", "daad_rise", "doe_csgf", "ellison_graduate", "gem", "rales", "suli", "samvid", "nsf_grfp"])("restores STEM discovery for %s", cohort => { const row = cases.find(r => r.cohort === cohort)!; expect(row.expected.disciplines).toContain("STEM"); });
 it("includes no-field-restriction programs in STEM and arts searches", () => { for (const row of cases.filter(r => r.expected.disciplines.includes("No field restriction"))) for (const discipline of ["STEM", "Arts"]) expect(matchesDirectorySelections(row.expected, { academicLevels: [], disciplines: [discipline], citizenship: [] })).toBe(true); });
 it("keeps the four unconfirmed citizenship fields explicitly unclassified", () => { expect(cases.filter(r => r.expected.citizenship.includes("Other / not listed")).map(r => r.cohort)).toEqual(["ellison_graduate", "ppia_jsi", "rotary_peace", "tillman"]); });
 it("does not accept malformed or unknown server categories", () => { const row = cases[0]; expect(getAwardDirectoryCategories({ ...row.facts, reviewedCategories: { academicLevels: ["Invented"], disciplines: ["STEM"], citizenship: ["U.S. citizens"] } }).academicLevels).toEqual(["Other / not listed"]); });
 it("returns independent arrays rather than exposing mutable shared review state", () => { const row=cases[0]; const first=getReviewedAwardDirectoryCategories(row.id,row.facts)!; first.disciplines.length=0; expect(getReviewedAwardDirectoryCategories(row.id,row.facts)).toEqual(row.expected); });
});
