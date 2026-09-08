export type DirectoryFilterField = "academicLevels" | "disciplines" | "citizenship";
export type DirectoryFilterInput = {
  academicLevels: readonly string[];
  disciplines: readonly string[];
  citizenship: readonly string[];
};

const OTHER = "Other / not listed";
const categoryOrder: Record<DirectoryFilterField, readonly string[]> = {
  academicLevels: ["High school", "Undergraduate", "Recent graduate", "Graduate", "Master's", "Doctoral", "Professional", OTHER],
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
register("citizenship", ["DACA / undocumented"], ["DACA Recipient", "Undocumented students and applicants with DACA status"]);
register("citizenship", ["All nationalities"], ["Citizens and residents of all countries are eligible"]);
register("citizenship", ["U.S. citizens", "Country-specific criteria"], ["U.S. Dual Citizen"]);
// Country names alone and qualified nationality conditions are not treated
// as unrestricted citizenship statuses, including negated U.S. requirements.
register("citizenship", ["Country-specific criteria"], [
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
