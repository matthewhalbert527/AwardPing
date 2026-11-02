export type DirectoryFilterField = "academicLevels" | "disciplines" | "citizenship";
export type DirectoryFilterInput = {
  academicLevels: readonly string[];
  disciplines: readonly string[];
  citizenship: readonly string[];
  reviewedCategories?: Record<DirectoryFilterField, readonly string[]>;
};

const OTHER = "Other / not listed";
const categoryOrder: Record<DirectoryFilterField, readonly string[]> = {
  academicLevels: ["High school", "Undergraduate", "Recent graduate", "Degree holder", "Graduate", "Master's", "Doctoral", "Professional", OTHER],
  disciplines: ["STEM", "Engineering", "Computing & data", "Mathematics", "Natural sciences", "Environment & earth sciences", "Social sciences & policy", "Arts", "Business & law", "Health & medicine", "Education", "No field restriction", "Multiple fields (check courses)", OTHER],
  citizenship: ["U.S. citizens", "U.S. nationals", "U.S. permanent residents", "DACA / undocumented", "All nationalities", "Country-specific criteria", "New American criteria", "Work authorization", OTHER],
};
const labels = new Map([
  ["Arts", "Arts & humanities"],
  ["Environment & earth sciences", "Environment & earth"],
  ["Social sciences & policy", "Society & policy"],
  ["Multiple fields (check courses)", "Multiple fields"],
  ["Country-specific criteria", "Country-specific"],
  ["U.S. permanent residents", "U.S. green card"],
]);

function key(value: string) {
  return value.trim().replace(/\s+/g, " ").replace(/[’‘]/g, "'").replace(/\.$/, "").toLowerCase();
}

const registry: Record<DirectoryFilterField, Map<string, readonly string[]>> = {
  academicLevels: new Map(), disciplines: new Map(), citizenship: new Map(),
};
function register(field: DirectoryFilterField, categories: readonly string[], values: readonly string[]) {
  for (const value of values) registry[field].set(key(value), categories);
}
for (const field of Object.keys(categoryOrder) as DirectoryFilterField[]) {
  for (const category of categoryOrder[field]) register(field, [category], [category]);
}

// Whole reviewed phrases from the public 25-award directory (2026-09-08), plus
// ordinary exact aliases. These are browse categories, not eligibility rules.
// No substring matching, cross-field inference, or modification of source facts.
register("academicLevels", ["High school"], ["High school senior"]);
register("academicLevels", ["Undergraduate"], [
  "College junior pursuing a bachelor's degree expecting graduation between December 2026 and August 2027",
  "College senior", "College seniors", "Graduating senior", "Graduating seniors",
  "Junior", "Juniors", "Senior", "Seniors", "Sophomore", "Sophomores",
  "Second-year undergraduate (sophomore)", "Third-year undergraduate in a five-year program",
  "Undergraduates", "Undergraduate (associate, bachelor's)",
  "Undergraduate student (two-year and four-year institutions)",
]);
register("academicLevels", ["Recent graduate"], [
  "Recent graduates", "Individuals who have graduated during the previous academic year",
  "Recent graduates (within 12 months prior to the deadline)",
]);
register("academicLevels", ["Graduate"], [
  "Postgraduate", "First-year graduate student", "First-year graduate student (2027–2028 academic year)",
]);
register("academicLevels", ["Graduate", "Recent graduate"], ["Postgraduate / Recent graduate"]);
register("academicLevels", ["Graduate", "Master's"], ["Master's", "Master's student"]);
register("academicLevels", ["Graduate", "Doctoral"], ["Doctoral", "Doctoral student (early stage)"]);
register("academicLevels", ["Graduate", "Professional"], ["Professional school"]);
register("academicLevels", ["Graduate", "Master's", "Doctoral", "Professional"], ["Graduate (master's, doctoral, professional)"]);
register("academicLevels", ["Graduate", "Master's", "Doctoral"], [
  "Graduate students pursuing full-time research-based master's and doctoral degrees",
  "Postgraduate (PhD, MLitt, or one-year postgraduate course)",
]);
register("academicLevels", ["Undergraduate", "Graduate", "Master's"], [
  "Undergraduate senior, bachelor's degree-holder with no graduate degree enrollment, joint bachelor's-master's student with at least three undergraduate years completed, or first-year graduate student in their first graduate degree program",
]);
// Preparing for graduate school does not establish a recent graduation.
register("academicLevels", [OTHER], ["Gap year preparing for graduate school"]);

register("disciplines", ["STEM", "Engineering"], [
  "Engineering", "Aeronautical and Astronautical Engineering", "Aerospace and Aeronautical Engineering",
  "Biomedical Engineering", "Chemical Engineering", "Civil Engineering", "Electrical Engineering",
  "Industrial and Systems Engineering", "Materials Science and Engineering", "Mechanical Engineering",
  "Naval Architecture and Ocean Engineering", "Naval Architecture and Ocean Engineering (Includes Undersea Systems)",
  "Nuclear Engineering",
]);
register("disciplines", ["STEM", "Engineering", "Computing & data"], ["Computer Science and Engineering", "Software Engineering"]);
register("disciplines", ["STEM", "Computing & data"], [
  "Artificial Intelligence and Machine Learning", "Computer and Computational Sciences",
  "Cyber Sciences (to include “hard” networks, cybersecurity, disinformation)",
  "Data Science and Analytics", "Information Sciences", "Computer science",
]);
register("disciplines", ["STEM", "Mathematics"], ["Mathematics", "Operations Research"]);
register("disciplines", ["STEM", "Natural sciences"], [
  "Natural sciences", "Applied physical sciences", "Astrodynamics", "Biological sciences", "Biosciences",
  "Biosciences (includes toxicology)", "Biotechnology (separate from Biosciences)", "Chemistry",
  "Cognitive, Neural, and Behavioral Sciences", "Physics", "Physics (Including Optics)", "Quantum Science", "Space Physics",
]);
register("disciplines", ["STEM", "Environment & earth sciences"], [
  "Geosciences", "Oceanography", "Oceanography (Includes Ocean Acoustics, Remote Sensing, And Marine Meteorology)",
]);
register("disciplines", ["Arts"], ["Humanities", "Arts & humanities"]);
register("disciplines", ["Business & law"], ["Business Administration (MBA)", "Law (JD)"]);
register("disciplines", ["Health & medicine"], ["Medicine (MD)", "Public Health (MPH)"]);
register("disciplines", ["Social sciences & policy"], [
  "Social sciences", "Social sciences (excluding neuroscience and clinical psychology)", "Social Sciences (MS/MA)",
  "Political, Economic, and Sociocultural Sciences", "Public Policy / Public Administration (MPP/MPA)",
  "Global Affairs", "Africa Program", "American Statecraft", "Asia Program", "Democracy, Conflict, and Governance",
  "Europe", "Global Order and Institutions", "International Security and Political Economy", "Middle East",
  "Nuclear Policy", "Russia and Eurasia", "Technology and International Affairs",
]);
register("disciplines", ["Environment & earth sciences", "Social sciences & policy"], ["Sustainability, Climate and Geopolitics"]);
register("disciplines", ["Environment & earth sciences", "Social sciences & policy", "Health & medicine"], ["Environmental, Tribal public policy, and health care fields"]);
register("disciplines", ["STEM"], ["STEM fields (MS/MA)", "Science and engineering disciplines of Department of Defense relevance"]);
register("disciplines", ["STEM", "Engineering", "Mathematics"], ["Science, mathematics, and engineering"]);
register("disciplines", ["STEM", "Engineering", "Mathematics", "Education"], [
  "Science, technology, engineering, and mathematics (STEM) fields, including STEM education",
]);
register("disciplines", ["STEM", "Education"], ["STEM, including STEM education"]);
register("disciplines", ["STEM", "Engineering", "Computing & data", "Mathematics", "Natural sciences", "Environment & earth sciences", "Social sciences & policy", "Education"], [
  "Oceanic, environmental, biological, and atmospheric sciences, mathematics, engineering, remote sensing technology, computer and information science, physical and social sciences (including geography, physics, hydrology, geomatics), or teacher education supporting NOAA programs and mission.",
]);
// Broad wording remains its own category; it is not a subject wildcard.
register("disciplines", ["No field restriction"], [
  "All fields of study", "All fields of study (no restrictions based on field of study or career aspiration)",
]);
register("disciplines", ["Multiple fields (check courses)"], [
  "Almost any discipline at graduate level leading to the award of a British university degree",
  "Any postgraduate subject available at the University of Cambridge",
]);

register("citizenship", ["U.S. citizens"], [
  "U.S. citizen", "US citizen", "US citizens", "United States citizen", "United States citizens",
  "United States citizen (native-born or naturalized)",
]);
register("citizenship", ["U.S. nationals"], ["U.S. national", "US national", "US nationals", "United States national", "United States nationals"]);
register("citizenship", ["U.S. permanent residents"], [
  "U.S. permanent resident", "US permanent resident", "US permanent residents", "United States permanent resident",
  "United States permanent residents", "U.S. Lawful Permanent Resident", "U.S. lawful permanent residents",
]);
register("citizenship", ["U.S. citizens", "U.S. nationals"], [
  "Citizen or national of the United States", "U.S. citizen or national", "U.S. citizens or nationals",
  "U.S. citizen or U.S. national at the time of application.",
]);
register("citizenship", ["U.S. citizens", "U.S. permanent residents"], ["U.S. citizens or permanent residents"]);
register("citizenship", ["U.S. citizens", "U.S. nationals", "U.S. permanent residents"], [
  "U.S. citizen, national, or permanent resident", "U.S. citizen, U.S. national, or permanent resident of the United States.",
]);
register("citizenship", ["DACA / undocumented"], [
  "DACA Recipient", "Undocumented students and applicants with DACA status",
  "Applicants with DACA status, no formal citizenship or undocumented status are also eligible.",
]);
register("citizenship", ["All nationalities"], [
  "Citizens and residents of all countries are eligible",
  "No citizenship restriction. Stanford admission requirements and location/residency restrictions still apply.",
]);
register("citizenship", ["U.S. citizens", "Country-specific criteria"], ["U.S. Dual Citizen"]);
// Country names alone and qualified nationality conditions are not treated
// as unrestricted citizenship statuses, including negated U.S. requirements.
register("citizenship", ["Country-specific criteria"], [
  "Eligibility is based on enrollment at a university/college in the United States, Canada, United Kingdom or Ireland; applicants of other nationalities can qualify under the conditions below.",
  "Applicants without U.S., Canadian, British or Irish citizenship may apply if they have studied at a university/college in one of those countries for more than twelve months by the application deadline.",
  "German citizens are eligible only with proof of having lived outside Germany for at least six years.",
  "Australia", "Canada", "New Zealand", "United Kingdom", "United States",
  "Citizens of any country outside the United Kingdom", "Dual citizens of the United Kingdom and another country",
  "U.S. citizen or U.S. national from American Samoa or the Commonwealth of the Northern Mariana Islands",
  "United States national from American Samoa",
  "Non-Chinese citizens holding a regular/ordinary passport from a country other than China (for the U.S./Global application)",
  "Applicants must be non-Chinese citizens with a valid passport; former citizens of the Chinese Mainland, Hong Kong, Macao or Taiwan must present a valid passport or citizenship documents dating from before April 30, 2021, along with proof of cancellation of Chinese nationality.",
  "Mainland Chinese applicants holding a P.R.C. passport are eligible if currently enrolled as undergraduates at a Mainland Chinese university.",
  "Must be a U.S. citizen if attending a participating institution located outside the United States.",
]);
register("citizenship", ["New American criteria"], [
  "Naturalized US citizens, green card holders, asylees, refugees, or individuals who graduated from both high school and college in the United States.",
]);
register("citizenship", ["Work authorization"], [
  "U.S. citizenship is not required for applicants attending a U.S. institution if eligible to work in the U.S. for 10–12 months from September 1 through at least June 30 following graduation.",
]);

// Exact reviewed source-verified public copy (2026-10-29). These aliases only
// restore broad browsing; all published qualifications remain unchanged. Unknown
// or changed prose keeps the Other fallback until its whole phrase is reviewed.
register("academicLevels", ["Undergraduate"], [
  "For the 2027 cycle, applicants must be college juniors pursuing a bachelor’s degree during 2026–2027, currently enrolled when applying, planning full-time undergraduate study the following term, and expecting graduation between December 2027 and August 2028. The award supports later master’s or doctoral study.",
  "Undergraduate Scholarships: Associate's or bachelor's students at application; must stay enrolled as undergraduates until the Scholarship is complete. Community-college and transfer students are encouraged.",
  "Undergraduates at accredited U.S. two- or four-year institutions; community-college and transfer students are encouraged. High-school, graduate and postgraduate study are not funded.",
  "Sophomore: Three to four full-time undergraduate semesters remaining, beginning in September of the award year.",
  "Junior: One to two full-time undergraduate semesters remaining, beginning in September of the award year.",
  "Class of 2028–2029: Applicants may be completing undergraduate study or already hold undergraduate/graduate degrees; the required undergraduate degree must be conferred by August 1, 2028. The funded course is a master’s degree.",
  "College sophomores and juniors. The Environment criteria expressly specify accredited higher-education institutions; both Native category pages also address sophomore/junior college students.",
  "Bachelor's degree holders or undergraduates completing their degree by August of the intended enrollment year; prior master's degree holders may apply on international/HMT tracks."
]);
register("disciplines", ["Arts","Social sciences & policy"], [
  "Research- or creative-focused graduate study in the arts, humanities or social sciences. Social-science applicants intending graduate study in neuroscience or clinical psychology should not apply."
]);
register("citizenship", ["U.S. citizens","Country-specific criteria"], [
  "U.S. citizens, or U.S. nationals from American Samoa or the Commonwealth of the Northern Mariana Islands."
]);
register("academicLevels", ["Graduate","Master's","Doctoral","Professional"], [
  "Graduate Fellowships: Graduate students or applicants to eligible U.S. graduate programs; enrollment required by the Fellowship start and through completion. Eligible degrees include master's, JD and doctoral programs; certificates alone are not eligible."
]);
register("disciplines", ["No field restriction"], [
  "Students from any field may apply; listed preferred majors are preferences, not exclusive eligibility. Only undergraduate STEM majors qualify for the shorter summer-only track.",
  "Students in any field of study may apply and must explain the language’s connection to their academic and professional goals.",
  "All undergraduate fields are welcome; applicants should explain how Schwarzman develops their leadership potential in their field.",
  "All fields of eligible graduate or professional study are considered.",
  "Applicants may come from any field. China Studies offers Economics and Management; History and Archaeology; Philosophy and Religion; Politics and International Relations; Law and Society; Literature and Culture."
]);
register("citizenship", ["U.S. citizens"], [
  "U.S. citizens only at the national application deadline; permanent residents and international students are not eligible. Do not propose study in a destination of which you are a citizen.",
  "U.S. citizens, native-born or naturalized; also required for Kanders.",
  "U.S. citizens at application; permanent residents alone are not eligible. Dual citizens must also hold U.S. citizenship.",
  "U.S. citizenship is required at the time of application."
]);
register("academicLevels", ["Undergraduate","Recent graduate"], [
  "Churchill Scholarship: Graduating undergraduates or graduates within 12 months of the deadline.",
  "Graduating seniors and applicants who graduated during the previous academic year; applicants who began graduate studies are excluded except for the stated completed joint-degree exception.",
  "Graduating seniors, recent graduates and young professionals, with at least a bachelor’s degree by program start."
]);
register("disciplines", ["STEM","Engineering","Mathematics"], [
  "Churchill Scholarship: Science, mathematics or engineering in an eligible Cambridge MPhil or MASt."
]);
register("disciplines", ["Social sciences & policy"], [
  "Kanders Churchill: Master’s in Public Policy, with a prior STEM major or minor.",
  "Tribal Policy: An array of policy issues affecting Indian country and careers serving a tribe or Native Americans and Alaska Natives."
]);
register("academicLevels", ["Undergraduate","Graduate","Master's","Doctoral","Professional"], [
  "At application, enrollment in an accredited U.S. degree programme at undergraduate (associate/bachelor’s) or graduate (master’s/doctoral/professional) level is required. Virtual-institute applicants must be undergraduates."
]);
register("citizenship", ["U.S. citizens","U.S. nationals"], [
  "Be a U.S. citizen or national at the time of application; permanent residents and applicants awaiting naturalization are ineligible.",
  "U.S. citizens or U.S. nationals; permanent residents alone are not eligible.",
  "U.S. citizens, U.S. dual citizens and U.S. nationals. Permanent residents and people merely awaiting citizenship are ineligible."
]);
register("citizenship", ["Country-specific criteria"], [
  "Overseas institutes: Overseas participants must enter on a U.S. passport. Dual citizenship/other host-country nationality ties can prevent placement; alternate placements are not guaranteed.",
  "Applicants attending a participating university outside the United States: Applicants attending a participating university outside the United States must be U.S. citizens.",
  "Citizens of countries outside the United Kingdom are eligible; dual citizens of the UK and another country may apply.",
  "International: Non-Chinese citizens with a valid passport. The published page additionally requires former Mainland/Hong Kong/Macao/Taiwan citizens to show passport/citizenship documents dating before April 30, 2021 and proof of cancellation of Chinese nationality.",
  "Hong Kong, Macao and Taiwan: Separate HMT track through Yenching plus a supplementary Peking University Graduate Admissions application.",
  "Mainland Chinese: PRC passport holders from Mainland China use a separate process and must currently be undergraduates at a Mainland Chinese university; this condition does not apply to HMT candidates."
]);
register("disciplines", ["Multiple fields (check courses)"], [
  "Program opportunities span academic disciplines, including creative and performing arts; availability and restrictions depend on the host-country award.",
  "Any subject available at Cambridge within the scholarship’s eligible postgraduate degree types.",
  "Almost any graduate discipline, subject to course restrictions. MBA, MSc/MFE Financial Economics, second undergraduate degrees, PGDip/PGCert, professional qualifying medicine/dentistry/veterinary/law, distance learning and part-time courses are not funded.",
  "Any graduate/professional degree with a credible path to public service, including policy, law, education, health, sciences and other fields; domestic and overseas study can be funded. MBA support is rare and requires a clear public-service connection."
]);
register("citizenship", ["U.S. citizens","U.S. nationals","Country-specific criteria"], [
  "U.S. citizens or U.S. nationals at the deadline; permanent residents are ineligible. Dual-citizen eligibility for the other country depends on that award's rules."
]);
register("citizenship", ["Work authorization"], [
  "Applicants attending a university in the United States: U.S. citizenship is not required for applicants attending a university located in the United States. All applicants still need U.S. work authorization for the stated employment period.",
  "F-1 students: F-1 students may apply if they are eligible to work in the United States for the full year."
]);
register("academicLevels", ["Graduate","Master's","Doctoral"], [
  "Postgraduate only: eligible full-time master’s programmes and full-time or part-time PhDs; no undergraduate degrees."
]);
register("academicLevels", ["Graduate","Master's"], [
  "MS fellowship: Master's-level graduate study.",
  "Standalone master's students/graduates entering a PhD can apply; master's years within an already-accepted PhD program count toward graduate years.",
  "Incoming first-year graduate students; qualifying dual degrees and a master’s portion of a master’s/PhD lasting at least two years may qualify."
]);
register("academicLevels", ["Graduate","Doctoral"], [
  "PhD fellowship: Doctoral graduate study."
]);
register("citizenship", ["U.S. citizens","U.S. permanent residents"], [
  "U.S. citizenship or U.S. permanent residency is required at the time of application.",
  "U.S. citizens or permanent residents."
]);
register("disciplines", ["STEM","Engineering","Mathematics","Natural sciences"], [
  "Natural sciences, mathematics and engineering, with a research-focused career.",
  "Applied physical sciences, applied biological sciences, mathematics and engineering; applicants explain how their work addresses real-world challenges."
]);
register("citizenship", ["U.S. citizens","U.S. nationals","U.S. permanent residents"], [
  "U.S. citizens, U.S. nationals and U.S. permanent residents; permanent residents submit their Permanent Resident Card.",
  "U.S. citizens, U.S. nationals and permanent residents at the application deadline and, if offered, at fellowship acceptance. Student-visa holders and applicants awaiting green cards are not eligible.",
  "The 2027 undergraduate criteria list U.S. citizens, nationals and lawful permanent residents for the Environment category and for the Native American/Alaska Native categories."
]);
register("academicLevels", ["Undergraduate","Graduate"], [
  "College seniors, first-year graduate students and gap-year applicants preparing for PhD study can apply; the standard funded-entry window is PhD year one or two in fall 2027."
]);
register("disciplines", ["STEM","Environment & earth sciences","Social sciences & policy","Arts","Business & law","Health & medicine"], [
  "Wide-ranging fields, including arts, journalism, law, medicine, public health, science, business, environmental studies and international relations. Asian Studies majors are not excluded."
]);
register("academicLevels", ["Graduate"], [
  "Bachelor's degree completed by 2026 for the fall 2027 fellowship; new entrants or early graduate students within the first two years, with at least three degree years remaining."
]);
register("disciplines", ["STEM","Engineering","Computing & data","Mathematics","Natural sciences","Environment & earth sciences","Social sciences & policy","Education"], [
  "A declared NOAA-mission major, including oceanic, environmental, biological or atmospheric sciences; mathematics; engineering; remote sensing; computer/information science; relevant physical/social sciences; or teacher education. The list is not exhaustive."
]);
register("academicLevels", ["Undergraduate","Graduate","Master's"], [
  "Level 1: bachelor's seniors or bachelor's holders with no prior graduate-degree enrollment. Level 2: joint bachelor's/master's students in the final undergraduate or first graduate year, or first-year students in their first graduate degree program."
]);
register("citizenship", ["U.S. citizens","DACA / undocumented"], [
  "U.S. citizens or DACA recipients; permanent residents are not eligible."
]);
register("academicLevels", ["Undergraduate","Graduate","Master's","Doctoral"], [
  "General SMART degree levels: Bachelor’s, master’s and doctoral degree study in supported STEM disciplines."
]);
register("citizenship", ["New American criteria"], [
  "U.S.-citizen-by-birth applicants: U.S.-citizen-by-birth applicants generally need both birth parents born abroad as non-U.S. citizens and not eligible for U.S. citizenship at birth. The page allows a single-birth-parent exception when that immigrant parent raised the applicant and the other parent was absent with no contact. Parent location/current status does not decide eligibility.",
  "Immigrant pathways: Applicants born abroad as non-U.S. citizens may qualify through naturalized citizenship, citizenship following adoption by American parents, a valid green card, or granted U.S. refugee/asylee status.",
  "U.S.-high-school-and-college pathway: If no other listed immigrant pathway applies, a person born abroad must have graduated from both high school and college in the United States; this includes current/past DACA recipients. An American high school located abroad does not satisfy that U.S.-schooling route."
]);
register("disciplines", ["Environment & earth sciences","Social sciences & policy"], [
  "Environment: Conservation, environmental stewardship or environmental policy, with a career addressing environmental issues."
]);
register("disciplines", ["Health & medicine","Social sciences & policy"], [
  "Native Health Care: Health-care practice and delivery in Indian country, or health-care policy and research."
]);

function fieldCategories(field: DirectoryFilterField, values: readonly string[]) {
  const found = new Set<string>();
  for (const value of values) {
    const normalized = key(value);
    if (!normalized) continue;
    for (const category of registry[field].get(normalized) ?? [OTHER]) found.add(category);
  }
  if (!found.size) found.add(OTHER);
  return categoryOrder[field].filter((category) => found.has(category));
}

export function getAwardDirectoryCategories(input: DirectoryFilterInput): Record<DirectoryFilterField, string[]> {
  const reviewed = input.reviewedCategories;
  if (reviewed && (Object.keys(categoryOrder) as DirectoryFilterField[]).every(field =>
    Array.isArray(reviewed[field]) && reviewed[field].length > 0 && reviewed[field].every(value => categoryOrder[field].includes(value)))) {
    return Object.fromEntries((Object.keys(categoryOrder) as DirectoryFilterField[]).map(field =>
      [field, categoryOrder[field].filter(value => reviewed[field].includes(value))])) as Record<DirectoryFilterField, string[]>;
  }
  return {
    academicLevels: fieldCategories("academicLevels", input.academicLevels),
    disciplines: fieldCategories("disciplines", input.disciplines),
    citizenship: fieldCategories("citizenship", input.citizenship),
  };
}

/** Only categories present in the supplied catalog, in stable browse order. */
export function directoryFilterOptions(field: DirectoryFilterField, categories: readonly DirectoryFilterInput[]): { value: string; label: string }[] {
  const present = new Set(categories.flatMap((category) => [...category[field]]));
  return categoryOrder[field]
    .filter((value) => present.has(value))
    .map((value) => ({ value, label: labels.get(value) ?? value }));
}

/** Broad discovery scopes include their specific searches, never extra eligibility. */
export function directoryCategoryMatches(field: DirectoryFilterField, categories: readonly string[], value: string): boolean {
 if (categories.includes(value)) return true;
 if (field === "disciplines" && categories.includes("No field restriction")) {
  return categoryOrder.disciplines.includes(value) && !["No field restriction", "Multiple fields (check courses)", OTHER].includes(value);
 }
 // Nationality-neutral awards include these searches; DACA and work permission
 // need their own reviewed statements and are never inferred from nationality.
 return field === "citizenship" && categories.includes("All nationalities") && ["U.S. citizens", "U.S. nationals", "U.S. permanent residents"].includes(value);
}
