import { describe, expect, it } from "vitest";
import { buildSourceTree } from "@/lib/source-tree";

describe("source tree grouping", () => {
  it("groups CMS upload PDFs as files instead of exposing wp-content date folders", () => {
    const tree = buildSourceTree([
      {
        id: "home",
        title: "Schwarzman Scholarship",
        url: "https://www.schwarzmanscholars.org/",
        pageType: "homepage",
      },
      {
        id: "pdf",
        title: "View an overview of Schwarzman Scholars. DOWNLOAD",
        url: "https://www.schwarzmanscholars.org/wp-content/uploads/2025/08/Schwarzman_Admission_Bro_August2025_RGB.pdf",
        pageType: "pdf",
      },
    ]);

    expect(tree.map((node) => node.label)).toEqual(["Overview", "Files and PDFs"]);

    const files = tree.find((node) => node.label === "Files and PDFs");
    expect(files?.children[0].label).toBe("View an overview of Schwarzman Scholars");
    const renderedLabels = [
      ...tree.map((node) => node.label),
      ...(files?.children.map((node) => node.label) || []),
    ].join(" ");
    expect(renderedLabels).not.toMatch(/wp content|uploads|2025|08/i);
  });

  it("groups application pages under an application branch", () => {
    const tree = buildSourceTree([
      {
        id: "admissions",
        title: "Admissions",
        url: "https://www.schwarzmanscholars.org/admissions/",
        pageType: "application",
      },
      {
        id: "experience",
        title: "Program Experience",
        url: "https://www.schwarzmanscholars.org/program-experience/",
        pageType: "other",
      },
    ]);

    const application = tree.find((node) => node.label === "Application");
    expect(application?.children[0].label).toBe("Admissions");
    expect(tree.some((node) => node.label === "Program Experience")).toBe(true);
  });

  it("drops generic award container path segments", () => {
    const tree = buildSourceTree([
      {
        id: "faculty-reps",
        title: "Faculty Reps",
        url: "https://www.udall.gov/OurPrograms/Scholarship/FacultyReps",
        pageType: "other",
      },
    ]);

    expect(tree.map((node) => node.label)).toEqual(["Faculty Reps"]);
  });

  it("uses readable titles for raw path labels and hides generic resource folders", () => {
    const tree = buildSourceTree([
      {
        id: "faq",
        title: "/faq/",
        url: "https://pickeringfellowship.org/faq/",
        pageType: "faq",
      },
      {
        id: "resource",
        title: "/resources/view/asa-rise-applications-open-for-cohort-6-fellows",
        url: "https://example.org/resources/view/asa-rise-applications-open-for-cohort-6-fellows",
        pageType: "other",
      },
    ]);

    const labels = [
      ...tree.map((node) => node.label),
      ...tree.flatMap((node) => node.children.map((child) => child.label)),
    ];
    expect(labels).toContain("FAQ");
    expect(labels).toContain("Asa Rise Applications Open For Cohort 6 Fellows");
    expect(labels).not.toContain("/faq/");
    expect(labels).not.toContain("Resources");
    expect(labels).not.toContain("View");
  });

  it("uses URL-specific labels instead of repeated generic action titles", () => {
    const tree = buildSourceTree([
      {
        id: "education-training",
        title: "learn more",
        url: "https://www.airforce.com/frequently-asked-questions/education-training",
        pageType: "faq",
      },
      {
        id: "information-for-families",
        title: "learn more",
        url: "https://www.airforce.com/frequently-asked-questions/information-for-families",
        pageType: "faq",
      },
      {
        id: "paths-processes",
        title: "learn more",
        url: "https://www.airforce.com/frequently-asked-questions/paths-processes",
        pageType: "faq",
      },
    ]);

    const faq = tree.find((node) => node.label === "FAQ");
    expect(faq?.children.map((node) => node.label)).toEqual([
      "Education Training",
      "Information For Families",
      "Paths Processes",
    ]);
  });

  it("uses application context instead of repeated apply labels", () => {
    const tree = buildSourceTree([
      {
        id: "mass-media",
        title: "Apply",
        url: "https://www.aaas.org/fellowships/mass-media/apply",
        pageType: "application",
      },
      {
        id: "root-apply",
        title: "APPLY",
        url: "http://www.aaas.org/page/apply",
        pageType: "application",
      },
      {
        id: "diverse-voices",
        title: "Apply",
        url: "https://www.aaas.org/programs/diverse-voices-science-journalism-internship/apply",
        pageType: "application",
      },
      {
        id: "tips",
        title: "tips here.",
        url: "https://www.aaas.org/page/application-tips-mass-media-science-engineering-fellowship",
        pageType: "application",
      },
    ]);

    const application = tree.find((node) => node.label === "Application");
    expect(application?.children.map((node) => node.label)).toEqual([
      "Application Page",
      "Diverse Voices Science Journalism Internship Application",
      "Mass Media Application",
      "Mass Media Science Engineering Fellowship Application Tips",
    ]);
  });

  it("uses PDF filenames instead of repeated generic document titles", () => {
    const tree = buildSourceTree([
      {
        id: "parent-guidelines",
        title: "Guidelines",
        url: "https://agbell.org/wp-content/uploads/2025/06/Guidelines-Parent-Infant-2025-1.pdf",
        pageType: "pdf",
      },
      {
        id: "school-guidelines",
        title: "Guidelines",
        url: "https://agbell.org/wp-content/uploads/2026/03/2026_School-age_Guidelines.pdf",
        pageType: "pdf",
      },
      {
        id: "registration",
        title: "here",
        url: "https://agbell.org/wp-content/uploads/2026/01/AG-Bell-Global-LSL-Symposium-2026-Registration-Form-English.pdf",
        pageType: "pdf",
      },
    ]);

    const files = tree.find((node) => node.label === "Files and PDFs");
    expect(files?.children.map((node) => node.label)).toEqual([
      "2026 School Age Guidelines",
      "AG Bell Global LSL Symposium 2026 Registration Form English",
      "Guidelines Parent Infant 2025 1",
    ]);
  });

  it("uses extracted display titles instead of noisy URL path leaves", () => {
    const tree = buildSourceTree([
      {
        id: "hench",
        title: "hench.htm",
        displayTitle: "Hench Postdoctoral Fellowship",
        url: "http://www.americanantiquarian.org/hench.htm",
        pageType: "other",
      },
    ]);

    expect(tree.map((node) => node.label)).toEqual(["Hench Postdoctoral Fellowship"]);
    expect(tree.map((node) => node.label)).not.toContain("Hench Htm");
  });

  it("groups extracted page categories into scholarship concepts", () => {
    const tree = buildSourceTree([
      {
        id: "citizenship",
        title: "Citizenship",
        displayTitle: "Citizenship",
        url: "https://example.edu/scholarship/eligibility/citizenship",
        pageType: "other",
        pageMetadata: {
          baseline_facts: {
            page_category: "Eligibility",
          },
        },
      },
      {
        id: "campus-deadline",
        title: "Campus deadline",
        displayTitle: "Campus deadline",
        url: "https://example.edu/scholarship/dates/campus",
        pageType: "other",
        pageMetadata: {
          baseline_facts: {
            page_category: "Deadlines",
          },
        },
      },
    ]);

    const eligibility = tree.find((node) => node.label === "Eligibility");
    const deadlines = tree.find((node) => node.label === "Deadlines");
    expect(eligibility?.children.map((node) => node.label)).toEqual(["Citizenship"]);
    expect(deadlines?.children.map((node) => node.label)).toEqual(["Campus deadline"]);
  });

  it("does not use rejected baseline metadata for page labels or categories", () => {
    const tree = buildSourceTree([
      {
        id: "rejected",
        title: "Official page",
        url: "https://example.edu/scholarship",
        pageType: "other",
        pageMetadata: {
          baseline_facts_rejected: true,
          baseline_facts: {
            display_title: "Wrong Extracted Title",
            page_category: "Deadlines",
          },
        },
      },
    ]);

    expect(tree.map((node) => node.label)).toEqual(["Official page"]);
    expect(tree.map((node) => node.label)).not.toContain("Deadlines");
    expect(tree.map((node) => node.label)).not.toContain("Wrong Extracted Title");
  });

  it("does not use non-program or archived-cycle metadata for page labels or categories", () => {
    const tree = buildSourceTree([
      {
        id: "not-program",
        title: "Official source page",
        url: "https://example.edu/scholarship/logo",
        pageType: "other",
        pageMetadata: {
          baseline_facts: {
            display_title: "Brand Logo",
            page_category: "Deadlines",
            cycle_relevance: "not_program_page",
          },
        },
      },
      {
        id: "archived",
        title: "Past recipients",
        url: "https://example.edu/scholarship/past",
        pageType: "other",
        pageMetadata: {
          baseline_facts: {
            display_title: "2020 Recipients",
            page_category: "Eligibility",
            cycle_relevance: "archived_or_past",
          },
        },
      },
    ]);

    const labels = treeLabelsText(tree);
    expect(labels).toContain("Official source page");
    expect(labels).toContain("Past recipients");
    expect(labels).not.toContain("Brand Logo");
    expect(labels).not.toContain("2020 Recipients");
    expect(labels).not.toContain("Deadlines");
    expect(labels).not.toContain("Eligibility");
  });
});

function treeLabelsText(tree: ReturnType<typeof buildSourceTree>) {
  const labels: string[] = [];

  function visit(nodes: typeof tree) {
    for (const node of nodes) {
      labels.push(node.label);
      visit(node.children);
    }
  }

  visit(tree);
  return labels.join("\n");
}
