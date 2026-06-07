import type { AwardPageType } from "@/lib/award-discovery-types";

export type AwardSourceOverride = {
  awardName: string;
  sources: Array<{
    url: string;
    title: string;
    pageType: AwardPageType;
    confidence: number;
    reason: string;
  }>;
};

function officialHomepageOverride(
  awardName: string,
  url: string,
  title = awardName,
): AwardSourceOverride {
  return {
    awardName,
    sources: [
      {
        url,
        title,
        pageType: "homepage",
        confidence: 0.92,
        reason: "Official organization source page.",
      },
    ],
  };
}

export const awardSourceOverrides: AwardSourceOverride[] = [
  officialHomepageOverride("Truman Scholarship", "https://www.truman.gov/"),
  officialHomepageOverride("Goldwater Scholarship", "https://goldwaterscholarship.gov/"),
  officialHomepageOverride(
    "NSF Graduate Research Fellowship Program",
    "https://www.nsfgrfp.org/",
  ),
  officialHomepageOverride("Fulbright U.S. Student Program", "https://us.fulbrightonline.org/"),
  officialHomepageOverride(
    "Fulbright Foreign Student Program",
    "https://foreign.fulbrightonline.org/",
  ),
  officialHomepageOverride(
    "Rhodes Scholarship",
    "https://www.rhodeshouse.ox.ac.uk/scholarships/the-rhodes-scholarship/",
  ),
  officialHomepageOverride("Marshall Scholarship", "https://www.marshallscholarship.org/"),
  officialHomepageOverride(
    "Gates Cambridge Scholarship",
    "https://www.gatescambridge.org/programme/the-scholarship/",
  ),
  officialHomepageOverride("Knight-Hennessy Scholars", "https://knight-hennessy.stanford.edu/"),
  officialHomepageOverride(
    "Knight-Hennessy Scholars Program",
    "https://knight-hennessy.stanford.edu/",
  ),
  officialHomepageOverride("Schwarzman Scholars", "https://www.schwarzmanscholars.org/"),
  officialHomepageOverride("Schwarzman Scholarship", "https://www.schwarzmanscholars.org/"),
  officialHomepageOverride("Boren Awards", "https://www.borenawards.org/"),
  officialHomepageOverride(
    "Boren Awards for International Study",
    "https://www.borenawards.org/",
  ),
  officialHomepageOverride("Gilman Scholarship", "https://www.gilmanscholarship.org/"),
  officialHomepageOverride("Critical Language Scholarship", "https://clscholarship.org/"),
  officialHomepageOverride("Critical Languages Scholarship", "https://clscholarship.org/"),
  officialHomepageOverride("Pickering Fellowship", "https://pickeringfellowship.org/"),
  officialHomepageOverride(
    "Rangel Fellowship",
    "https://rangelprogram.org/graduate-fellowship-program/",
  ),
  officialHomepageOverride(
    "Charles B. Rangel International Affairs Fellowship",
    "https://rangelprogram.org/graduate-fellowship-program/",
  ),
  officialHomepageOverride("Payne Fellowship", "https://www.paynefellows.org/"),
  officialHomepageOverride(
    "Hollings Scholarship",
    "https://www.noaa.gov/office-education/hollings-scholarship",
  ),
  officialHomepageOverride(
    "NOAA Hollings Scholarship",
    "https://www.noaa.gov/office-education/hollings-scholarship",
  ),
  officialHomepageOverride("Beinecke Scholarship", "https://beineckescholarship.org/"),
  officialHomepageOverride("Soros Fellowship for New Americans", "https://www.pdsoros.org/"),
  officialHomepageOverride("Soros Fellowships for New Americans", "https://www.pdsoros.org/"),
  officialHomepageOverride("Churchill Scholarship", "https://www.churchillscholarship.org/"),
  officialHomepageOverride(
    "Tillman Scholars Program",
    "https://pattillmanfoundation.org/apply-to-be-a-scholar/",
  ),
  {
    awardName: "Udall Scholarship",
    sources: [
      {
        url: "https://www.udall.gov/OurPrograms/Scholarship/Scholarship",
        title: "Udall Undergraduate Scholarship",
        pageType: "homepage",
        confidence: 0.95,
        reason: "Official Udall Scholarship landing page.",
      },
      {
        url: "https://www.udall.gov/OurPrograms/Scholarship/AboutScholarship",
        title: "About the Scholarship",
        pageType: "other",
        confidence: 0.9,
        reason: "Official Udall Scholarship overview page.",
      },
      {
        url: "https://www.udall.gov/OurPrograms/Scholarship/WhoShouldApply",
        title: "Who Should Apply",
        pageType: "eligibility",
        confidence: 0.95,
        reason: "Official Udall Scholarship eligibility guidance.",
      },
      {
        url: "https://www.udall.gov/OurPrograms/Scholarship/Apply",
        title: "Apply",
        pageType: "application",
        confidence: 0.95,
        reason: "Official Udall Scholarship application page.",
      },
      {
        url: "https://www.udall.gov/OurPrograms/Scholarship/HowToApply",
        title: "How to Apply",
        pageType: "application",
        confidence: 0.95,
        reason: "Official Udall Scholarship application instructions.",
      },
      {
        url: "https://www.udall.gov/OurPrograms/Scholarship/FacultyReps",
        title: "Udall Faculty Reps",
        pageType: "application",
        confidence: 0.9,
        reason: "Official Udall Scholarship faculty representative instructions.",
      },
      {
        url: "https://www.udall.gov/OurPrograms/Scholarship/AdviceGuidance",
        title: "Advice and Guidance",
        pageType: "application",
        confidence: 0.9,
        reason: "Official Udall Scholarship applicant guidance page.",
      },
      {
        url: "https://www.udall.gov/OurPrograms/Scholarship/InformationForReferences",
        title: "Information For References",
        pageType: "application",
        confidence: 0.9,
        reason: "Official Udall Scholarship reference instructions.",
      },
      {
        url: "https://www.udall.gov/documents/pdf/2026%20Eligibility%20Criteria.pdf",
        title: "2026 Eligibility Criteria",
        pageType: "pdf",
        confidence: 0.95,
        reason: "Official Udall Scholarship eligibility criteria PDF.",
      },
      {
        url: "https://www.udall.gov/OurPrograms/Scholarship/ImportantDates",
        title: "Important Dates",
        pageType: "deadline",
        confidence: 0.95,
        reason: "Official Udall Scholarship dates and deadline page.",
      },
      {
        url: "https://www.udall.gov/OurPrograms/Scholarship/FAQs",
        title: "FAQs",
        pageType: "faq",
        confidence: 0.9,
        reason: "Official Udall Scholarship FAQ page.",
      },
      {
        url: "https://www.udall.gov/OurPrograms/Scholarship/MeetScholars",
        title: "Meet our Scholars",
        pageType: "other",
        confidence: 0.82,
        reason: "Official Udall Scholarship scholar information page.",
      },
      {
        url: "https://www.udall.gov/OurPrograms/Scholarship/AlumniNetwork",
        title: "Alumni",
        pageType: "other",
        confidence: 0.8,
        reason: "Official Udall Scholarship alumni page.",
      },
    ],
  },
  {
    awardName: "Mitchell Scholarship",
    sources: [
      {
        url: "https://us-irelandalliance.org/mitchellscholarship",
        title: "The US-Ireland Alliance Scholarship",
        pageType: "homepage",
        confidence: 0.95,
        reason: "Official US-Ireland Alliance scholarship landing page.",
      },
      {
        url: "https://us-irelandalliance.org/mitchellscholarship/announcement",
        title: "Announcement",
        pageType: "other",
        confidence: 0.86,
        reason: "Official program announcement page.",
      },
      {
        url: "https://us-irelandalliance.org/mitchellscholarship/applicants",
        title: "Applicants",
        pageType: "application",
        confidence: 0.92,
        reason: "Official applicant information page.",
      },
      {
        url: "https://us-irelandalliance.org/mitchellscholarship/applicants/eligibility",
        title: "Am I Eligible?",
        pageType: "eligibility",
        confidence: 0.95,
        reason: "Official eligibility page.",
      },
      {
        url: "https://us-irelandalliance.org/mitchellscholarship/applicants/process",
        title: "Application Process",
        pageType: "application",
        confidence: 0.95,
        reason: "Official application process page.",
      },
      {
        url: "https://us-irelandalliance.org/mitchellscholarship/applicants/completion",
        title: "Completing the Application",
        pageType: "application",
        confidence: 0.95,
        reason: "Official application completion instructions.",
      },
      {
        url: "https://us-irelandalliance.org/mitchellscholarship/applicants/questions",
        title: "Frequently Asked Questions",
        pageType: "faq",
        confidence: 0.95,
        reason: "Official FAQ page.",
      },
      {
        url: "https://us-irelandalliance.org/mitchellscholarship/applicants/institutions",
        title: "N.I. and Ireland Institutions",
        pageType: "other",
        confidence: 0.85,
        reason: "Official participating institution information.",
      },
      {
        url: "https://us-irelandalliance.org/mitchellscholarship/applicants/resources",
        title: "Other Resources",
        pageType: "requirements",
        confidence: 0.84,
        reason: "Official applicant resource page.",
      },
      {
        url: "https://us-irelandalliance.org/mitchellscholarship/applicants/endorsers",
        title: "Recommenders and Endorsers",
        pageType: "application",
        confidence: 0.9,
        reason: "Official recommender and endorser instructions.",
      },
      {
        url: "https://us-irelandalliance.org/mitchellscholarship/application",
        title: "Application",
        pageType: "application",
        confidence: 0.9,
        reason: "Official application page.",
      },
      {
        url: "https://mitchell.us-irelandalliance.org/",
        title: "Application System",
        pageType: "application",
        confidence: 0.86,
        reason: "Official application system linked from the program site.",
      },
    ],
  },
];
