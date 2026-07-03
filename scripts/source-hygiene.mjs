export function classifySourceHygiene(sourceLike = {}, failure = {}) {
  const url = String(sourceLike.url || sourceLike.source_url || "");
  const title = String(sourceLike.display_title || sourceLike.title || sourceLike.source_title || "");
  const awardName = String(sourceLike.award_name || sourceLike.awardName || "");
  const reason = String(sourceLike.reason || "");
  const pageType = String(sourceLike.page_type || "");
  const failureType = String(failure.failure_type || failure.failureType || "");
  const message = String(failure.message || failure.error_message || failure.last_error || "");
  const statusCode = Number(failure.status_code || failure.statusCode || 0) || null;
  const directHaystack = [url, title, pageType].filter(Boolean).join(" ").toLowerCase();
  const haystack = [url, title, awardName, reason, pageType, failureType, message]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  const parsed = safeUrl(url);
  const host = parsed?.hostname.replace(/^www\./i, "").toLowerCase() || "";
  const path = parsed?.pathname.toLowerCase() || "";

  if (!url || !parsed) {
    return review("invalid_url", "Invalid or missing URL");
  }

  if (isSocialOrShareUrl(host, path, haystack)) {
    return review("social_or_share_link", "Social/share URL is not a monitorable award source");
  }

  if (isMediaOrArchiveUrl(path)) {
    return review("media_or_archive_file", "Media/archive file is not useful for daily award monitoring");
  }

  if (isRecursiveOrCyclicUrl(path)) {
    return review("recursive_or_cyclic_url", "URL repeats the same path segment and is likely crawler recursion");
  }

  if (isGenericListingOrSearchShape(parsed, directHaystack)) {
    return review("generic_source_shape", "Generic listing or search page is not specific enough for award monitoring");
  }

  if (isOpenDataPortalSpilloverUrl(parsed, host, path, directHaystack, reason, awardName)) {
    return review("generic_source_shape", "Open-data listing, search, or facet page is not a specific award source");
  }

  if (isSoftwareDownloadUrl(host, path)) {
    return review("software_download", "Software download page is not an award source");
  }

  if (isDuplicatePdfExportUrl(host, path)) {
    return review("duplicate_pdf_export", "Synthetic PDF export duplicates the canonical award database page");
  }

  if (isNspiresRosesSpillover(host, path, directHaystack, awardName)) {
    return review("cross_program_source", "NSPIRES source belongs to a sibling ROSES program or broad ROSES table");
  }

  if (isBroadAcademicPdfSpillover(host, path, [url, title, reason].join(" "), awardName)) {
    return review(
      "cross_program_source",
      "Broad academic policy or support PDF is not specific enough for this award",
    );
  }

  if (isBroadScholarshipBrochurePdf(host, path)) {
    return review("cross_program_source", "Broad scholarship brochure is not specific enough for this award");
  }

  if (isGenericNonAwardDiscoveryUrl(parsed, host, path, directHaystack)) {
    return review("non_award_source", "Generic site page is not specific enough for award monitoring");
  }

  if (isKnownBadAwardSourceAssociation(parsed, host, path, directHaystack, awardName)) {
    return review(
      "cross_program_source",
      "Source appears to describe a different award, calendar, archive, or broad listing",
    );
  }

  if (isOfficialDomainSpilloverSource(parsed, host, path, directHaystack, reason, awardName)) {
    return review(
      "official_domain_spillover",
      "Official-domain page appears to belong to a broad agency site or sibling program, not this award",
    );
  }

  if (isKnownBoilerplateUrl(host, path, directHaystack)) {
    return review("boilerplate_or_policy_link", "Boilerplate, policy, news, event, or generic resource link");
  }

  if (isCrossProgramOrBroadListingSource(directHaystack, awardName)) {
    return review(
      "cross_program_source",
      "Source appears to describe a different award or broad program listing",
    );
  }

  if (isOversizedFailure(message, failureType)) {
    return review("oversized_file", "File is too large for daily monitoring");
  }

  if (isPrivateDocumentUrl(host, path, haystack) && isPrivateFailure(statusCode, failureType, message)) {
    return review("private_document", "Private or gated document cannot be monitored automatically");
  }

  if (isPermanentHttpFailure(statusCode, failureType, message)) {
    return review("permanent_http_failure", "Source returns a permanent HTTP failure");
  }

  if (isSoft404Failure(failureType, message)) {
    return review("soft_404", "Source appears to be a page-not-found or wrong destination");
  }

  if (isBlockedThirdPartyUrl(host, haystack) && isBlockedFailure(statusCode, failureType, message)) {
    return review("blocked_third_party", "Third-party source blocks automated monitoring");
  }

  if (isBlockedFailure(statusCode, failureType, message)) {
    return review("blocked_by_source", "Source blocks automated monitoring");
  }

  return { action: "keep", reason: null, note: null };
}

export function shouldRejectDiscoveredSource(sourceLike = {}) {
  const hygiene = classifySourceHygiene(sourceLike, {});
  return hygiene.action === "review_later" ? hygiene : { action: "keep", reason: null, note: null };
}

export function shouldAutoReviewLaterFailure(sourceLike = {}, failure = {}) {
  const hygiene = classifySourceHygiene(sourceLike, failure);
  return hygiene.action === "review_later" ? hygiene : { action: "keep", reason: null, note: null };
}

function review(reason, note) {
  return { action: "review_later", reason, note };
}

function safeUrl(value) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function isSocialOrShareUrl(host, path, haystack) {
  return (
    /(^|\.)facebook\.com$/.test(host) ||
    /(^|\.)twitter\.com$/.test(host) ||
    /(^|\.)x\.com$/.test(host) ||
    /(^|\.)linkedin\.com$/.test(host) ||
    /(^|\.)reddit\.com$/.test(host) ||
    /(^|\.)pinterest\.com$/.test(host) ||
    /(^|\.)addthis\.com$/.test(host) ||
    /(^|\.)sharethis\.com$/.test(host) ||
    /\b(sharer\.php|share\?|intent\/tweet|addtoany|mailto:|social share|facebook|twitter|linkedin|instagram|youtube)\b/.test(
      haystack,
    ) ||
    /\/share(?:\/|$)/.test(path)
  );
}

function isMediaOrArchiveUrl(path) {
  return /\.(?:mp4|mov|avi|webm|mp3|wav|zip|rar|7z|tar|gz|jpg|jpeg|png|gif|webp|svg|ics)(?:$|[?#])/i.test(
    path,
  );
}

function isRecursiveOrCyclicUrl(path) {
  const segments = path
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean);
  const counts = new Map();
  for (const segment of segments) {
    if (segment.length < 4) continue;
    const count = (counts.get(segment) || 0) + 1;
    counts.set(segment, count);
    if (count >= 3) return true;
  }
  return false;
}

function isGenericNonAwardDiscoveryUrl(parsed, host, path, directHaystack) {
  const cleanPath = path.toLowerCase();
  const cleanSearch = String(parsed?.search || "").toLowerCase();
  const hasAwardSignal =
    /\b(apply|application|applicant|eligib|deadline|due date|requirements?|materials?|guidelines?|nomination|portal|faq|fellowships?|scholarships?|grants?|awards?)\b/.test(
      directHaystack,
    );

  if (
    host === "nlm.nih.gov" &&
    /^\/about\/training\/(?:associate|postgraduate)(?:\/|$)/.test(cleanPath) &&
    /\b(?:associate fellowship|postgraduate fellowship|fellowship program|librarians?)\b/.test(directHaystack)
  ) {
    return false;
  }
  if (
    host === "nia.nih.gov" &&
    /^\/research\/training\/r36-aging-research-dissertation-awards-(?:increase|promote)-diversity\/?$/.test(cleanPath)
  ) {
    return false;
  }

  if (
    /\/(?:recipes?|cooking-school|nutrition|foodservice|manufacturers?|professionals?|professional-resources|certification|get-certified|recertification|technical-resources|on-demand|courses?|course-catalog|training|learning|ceu|webinars?|podcasts?|sunnyside-up)(?:\/|$)/.test(
      cleanPath,
    )
  ) {
    return true;
  }

  if (
    (/(?:^|\.)iie\.org$/.test(host) && /^(?:\/|\/connect\/?|\/connect\/students\/?)$/.test(cleanPath)) ||
    /\/connect\/students\/participant-tax-service-information(?:\/|$)/.test(cleanPath)
  ) {
    return true;
  }

  if (
    /(?:^|\.)mainsheet\.mysticseaport\.org$/.test(host) ||
    (/(?:^|\.)hbswk\.hbs\.edu$/.test(host) && /\/item\//.test(cleanPath)) ||
    (/^catalog\./.test(host) && /\/discovery\/collectiondiscovery/.test(cleanPath)) ||
    (/(?:^|\.)studentaid\.alberta\.ca$/.test(host) && /\/policy\/student-aid-policy-manual\//.test(cleanPath)) ||
    (/(?:^|\.)home\.treasury\.gov$/.test(host) && /\/system\/files\/131\//.test(cleanPath) && !/\b(junior fellowship|international affairs|application|apply|eligib|deadline|fellowship)\b/.test(directHaystack)) ||
    (/(?:^|\.)home\.treasury\.gov$/.test(host) && /\/services\/the-multiemployer-pension-reform-act-of-2014\//.test(cleanPath)) ||
    (/(?:^|\.)lung\.org$/.test(host) && /^(?:\/|\/research\/?)$/.test(cleanPath) && !/\b(grant|award|application|eligib|deadline|fellowship)\b/.test(directHaystack)) ||
    (/(?:^|\.)jpf\.go\.jp$/.test(host) && /\/e\/(?:about\/citizen|project\/japanese\/teach\/support)\//.test(cleanPath)) ||
    (/(?:^|\.)acf\.gov$/.test(host) && /\/(?:css\/outreach-material|css\/employers\/child-support-portal)(?:\/|$)/.test(cleanPath)) ||
    (/(?:^|\.)getty\.edu$/.test(host) && /\/(?:calendar|projects|publications)\//.test(cleanPath) && !hasAwardSignal)
  ) {
    return true;
  }

  if (
    /\/(?:people|person|faculty|staff|board|alumni|testimonials?|success-stories|recipient|recipients?|fellows-directory|meet-our-[^/]*fellows|meet-[^/]*scholars|scholars-housing|center-associate|housing|mission-areas|science\/mission-areas|activities-and-networking|lectures|summer-alumni|equal-opportunities|innovation-techtransfer|nccr-spinoff|startups?)(?:\/|$)/.test(
      cleanPath,
    )
  ) {
    return true;
  }

  if (/\/(?:room|reese-house-room)-?\d{2,4}(?:\/|$)/.test(cleanPath)) {
    return true;
  }

  if (
    /\/(?:grantee|grantees|awardee|awardees|recipient|recipients?|fellows-directory|faculty\/research\/publications|faculty\/pages\/item\.aspx|university-ad)(?:\/|$)/.test(
      cleanPath,
    )
  ) {
    return true;
  }

  if (
    /\/(?:privacy-policy|cookie-policy|ferpa|subject-index|subject-indexing|calendar-conferences|announcements?)(?:\/|$)/.test(
      cleanPath,
    )
  ) {
    return true;
  }

  if (/\/news(?:\/|$)/.test(cleanPath) && !hasAwardSignal) {
    return true;
  }

  if (/\/(?:contact|contact-us|about\/contact)(?:\/|\.html?|$)/.test(cleanPath) && !hasAwardSignal) {
    return true;
  }

  if (/\bcalendar\b|ev_calendar_day/.test(cleanPath) && !hasAwardSignal) {
    return true;
  }

  if (/\boption=com_jevents\b/.test(cleanSearch) || /\btask=month\.calendar\b/.test(cleanSearch)) {
    return true;
  }

  if (
    /\b(ferpa for students|subject index terms|submit your news|calendar of conferences|cookie policy|privacy policy|fellowship privacy statement|selection committees?|staff directory|committee members?)\b/.test(
      directHaystack,
    )
  ) {
    return true;
  }

  if (/^\s*(read more|more|learn more|lire plus|email)\s*$/i.test(directHaystack.replace(/^https?:\/\/\S+\s+/i, "")) && !hasAwardSignal) {
    return true;
  }

  if (
    /\b(content marketing|mobile marketing|marketing automation|influencer marketing|overview of marketing|egg nutrition|nutrition facts|egg safety|food safety|foodservice|manufacturers overview|recertification|certification faqs?|professional resources|participant tax service|filing your tax return|tax liability for foreign recipients|sprintax|nonresident alien income tax|form 8843|form 1042-s|room \d{2,4}|meet our fellows|recent fellows|fellows directory|grant recipients?|award recipients?|alumni|testimonials|success stories|authorization letter|withdrawal letter|initial approval letter|final approval letter|notification letter|pension fund|local \d{2,4})\b/.test(
      directHaystack,
    )
  ) {
    return true;
  }

  if (
    /\b(transcripts?|panel discussion|nonprofit leader panel|educational stakeholders panel|digital collections?|exhibition sources?|collection discovery|special collections?|history of science|inside one startup|hiring barriers|policy manual|educator wellness day|concrete art|conservation workshop|submit to the getty research journal|prizes for global citizenship|japanese-language education|child support portal|countries accepting payments)\b/.test(
      directHaystack,
    )
  ) {
    return true;
  }

  if (/(?:^|\.)incredibleegg\.org$/.test(host) && !/\b(award|grant|fellow|scholar|young investigator|application)\b/.test(directHaystack)) {
    return true;
  }

  return false;
}

function isKnownBadAwardSourceAssociation(parsed, host, path, directHaystack, awardName) {
  const cleanPath = path.toLowerCase();
  const cleanSearch = String(parsed?.search || "").toLowerCase();
  const awardSignal = wordSignal(awardName);
  const sourceSignal = wordSignal(`${directHaystack} ${cleanPath} ${cleanSearch}`);

  if (host === "fields.utoronto.ca" && cleanPath === "/activities/thematic") return true;
  if (host === "postdocs.ubc.ca" && cleanPath === "/awards-funding") return true;
  if (isAlbertaCareerOrStudentAidSpillover(host, cleanPath, cleanSearch, directHaystack, awardName)) {
    return true;
  }
  if (isAlbertaKillamNotleyInstitutionalSpillover(host, cleanPath, cleanSearch, directHaystack, awardName)) {
    return true;
  }
  if (isMarquetteMitchemInstitutionalSpillover(host, cleanPath, cleanSearch, directHaystack, awardName)) {
    return true;
  }
  if (isRochesterFrederickDouglassInstitutionalSpillover(host, cleanPath, cleanSearch, directHaystack, awardName)) {
    return true;
  }
  if (isOxfordPershingSquareSpillover(host, cleanPath, cleanSearch, directHaystack, awardName)) {
    return true;
  }
  if (isSshrcPostdoctoralFellowshipSpillover(host, cleanPath, cleanSearch, directHaystack, awardName)) {
    return true;
  }
  if (isNihNiaR36AgingDissertationSpillover(host, cleanPath, cleanSearch, directHaystack, awardName)) {
    return true;
  }
  if (isNsfEarthSciencesPostdoctoralSpillover(host, cleanPath, cleanSearch, directHaystack, awardName)) {
    return true;
  }
  if (host === "ncbi.nlm.nih.gov" && /^\/books(?:\/|$)/.test(cleanPath)) return true;
  if (host === "ncbi.nlm.nih.gov" && /^\/medline\/publisherportal(?:\/|$)/.test(cleanPath)) return true;
  if (isNationalAcademiesSpillover(host, cleanPath, cleanSearch)) return true;
  if (host === "fastlane.nsf.gov" && cleanPath === "/fastlane.jsp") return true;
  if (host === "research.gov" && /^\/common\/attachment\/desktop\/nsfprojectreporttemplate\.docx$/i.test(cleanPath)) {
    return true;
  }
  if (host === "nsf.gov" && cleanPath === "/funding/programs.jsp" && /\borg=sbe\b/.test(cleanSearch)) {
    return true;
  }
  if ((host === "nsf.gov" || host === "beta.nsf.gov") && /^\/geo\/(?:ags|ear)(?:\/|$)/.test(cleanPath)) {
    return true;
  }
  if (host === "materialsinspace.nasa.gov") return true;
  if (host === "science.nasa.gov" && /^\/oss-guidance\/?$/.test(cleanPath)) return true;
  if (host === "nasa.gov" && /^\/open\/data(?:\.html)?\/?$/.test(cleanPath)) return true;
  if (host === "croucher.org.hk" && /croucher-science-communication-studentships/.test(cleanPath)) {
    return !/\bscience communication\b/.test(awardSignal);
  }
  if (host === "usascholarships.com" && /\/barbizon-college-tuition-scholarship-program(?:\/|$)/.test(cleanPath)) {
    return true;
  }
  if (host === "gerda-henkel-stiftung.de" && cleanPath === "/en/prize") return true;
  if (host === "aotf.org" && cleanPath === "/funding/") return true;
  if (host === "apf.apa.org" && cleanPath === "/" && !/\bapf\b.*\b(?:fellowship|scholarship|grant)\b/.test(sourceSignal)) {
    return true;
  }
  if (host === "gsa.gov" && /^\/reference\/(?:civil-rights-programs|freedom-of-information-act-foia)(?:\/|$)/.test(cleanPath)) {
    return true;
  }
  if (host === "lung.org" && /^\/get-involved\/ways-to-give(?:\/|$)/.test(cleanPath)) return true;
  if (host === "seg.org" && /\/programs\/student-programs\/seg-evolve(?:\/|$)/.test(cleanPath)) {
    return /\bscholarships?\b/.test(awardSignal);
  }
  if (/(^|\.)shafr\.org$/.test(host) && (/\boption=com_jevents\b/.test(cleanSearch) || /\btask=month\.calendar\b/.test(cleanSearch))) {
    return true;
  }
  if (host === "dowjonesnewsfund.org" && /\/news\/students-can-apply-for-2019-internships(?:\/|$)/.test(cleanPath)) {
    return true;
  }
  if (host === "pgfusa.org" && /\/2022-awards-program(?:\/|$)/.test(cleanPath)) return true;
  if (
    host === "costumesocietyamerica.com" &&
    /\bstella\b.*\bblum\b/.test(awardSignal) &&
    !/stella|travel-research-grant/.test(cleanPath)
  ) {
    return true;
  }

  return false;
}

function isNationalAcademiesSpillover(host, path, search = "") {
  if (host === "www8.nationalacademies.org") {
    return /^\/pa\/(?:managerequest|feedback)\.aspx$/.test(path);
  }

  if (host !== "nationalacademies.org") return false;

  if (
    path === "/" ||
    /^\/(?:current-operating-status|members|myacademies-accounts|advancing-a-robust-us-economy)(?:\/|$)/.test(path)
  ) {
    return true;
  }

  if (/^\/projects(?:\/|$)/.test(path)) return true;
  if (/^\/programs\/[^/]+\/updates$/.test(path) && /\bsort=/.test(search)) return true;
  return false;
}

function isAlbertaCareerOrStudentAidSpillover(host, path, search, directSignal, awardName) {
  const signal = `${directSignal} ${path} ${search}`;
  const matchesAward = hasDistinctiveAwardSourceMatch(signal, awardName);

  if (/(^|\.)alis\.alberta\.ca$/.test(host)) return true;
  if (host === "adultlearning.alberta.ca" && /^\/pcc\/provider\/?$/i.test(path)) return true;
  if (/archive\.org$/.test(host) && /\/internationaltrade\d{4}\/internationaltrade\d{4}\.pdf$/i.test(path)) {
    return true;
  }

  if (
    /(^|\.)studentaid\.alberta\.ca$/.test(host) &&
    /^\/scholarships\/[^/]+\/?$/i.test(path) &&
    !matchesAward
  ) {
    return true;
  }

  if (
    /(^|\.)studentaid\.alberta\.ca$/.test(host) &&
    /^\/(?:student-aid-funding-guide|policy|types-of-funding|repayment|resources\/upload-documents-instructions|eligibility)(?:\/|$)/i.test(
      path,
    ) &&
    !matchesAward
  ) {
    return true;
  }

  if (
    /(^|\.)alberta\.ca$/.test(host) &&
    /^\/(?:alberta-ca-account|apply-career-training-licence|career-training|eligibility-for-student-aid|fr\/eligibility-for-student-aid|id-requirements-for-identification-cards|private-career-colleges|registry-services|student-complaints|tuition-refunds)(?:[./-]|\/|$)/i.test(
      path,
    ) &&
    !matchesAward
  ) {
    return true;
  }

  return false;
}

function isAlbertaKillamNotleyInstitutionalSpillover(host, path, search, directSignal, awardName) {
  const awardSignal = wordSignal(awardName);
  if (!/\buniversity(?: of)? alberta\b/.test(awardSignal)) return false;
  if (!/\b(?:killam|notley)\b/.test(awardSignal)) return false;
  if (!/\bpostdoctoral\b/.test(awardSignal)) return false;

  const sourceSignal = wordSignal(`${directSignal} ${path} ${search}`);
  if (/\b(?:killam|notley)\b/.test(sourceSignal)) return false;
  if (/\/research\/research-support\/post-doctoral-office\/awards-funding\/u-of-a-fellowships(?:\/|$)/.test(path)) {
    return false;
  }

  if (
    [
      "apply.ualberta.ca",
      "calendar.ualberta.ca",
      "docs.google.com",
      "beartracks.ualberta.ca",
      "coned.ualberta.ca",
      "myccid.ualberta.ca",
      "mobile.ualberta.ca",
      "eclass.srv.ualberta.ca",
      "policiesonline.ualberta.ca",
      "graduate-studies-apply.ualberta.ca",
      "gradapply.ualberta.ca",
      "registrar.ualberta.ca",
      "support.ctl.ualberta.ca",
      "xray.chem.ualberta.ca",
    ].includes(host)
  ) {
    return true;
  }

  if (host === "ualberta.ca" || host.endsWith(".ualberta.ca")) {
    return !/\b(?:post doctoral office|postdoctoral office|awards funding|u of a fellowships)\b/.test(sourceSignal);
  }

  return false;
}

function isMarquetteMitchemInstitutionalSpillover(host, path, search, directSignal, awardName) {
  const awardSignal = wordSignal(awardName);
  if (!/\bmarquette\b/.test(awardSignal)) return false;
  if (!/\bmitchem\b/.test(awardSignal)) return false;
  if (!/\bdissertation\b/.test(awardSignal)) return false;

  const sourceSignal = wordSignal(`${directSignal} ${path} ${search}`);
  if (/\bmitchem\b/.test(sourceSignal)) return false;
  if (/\/provost\/mitchem-dissertation-program\.shtml$/.test(path)) return false;

  if (
    host === "marquette.edu" ||
    host.endsWith(".marquette.edu") ||
    [
      "studentaid.gov",
      "irs.gov",
      "michigan.bank",
      "scottishritemilwaukee.com",
    ].includes(host)
  ) {
    return true;
  }

  return false;
}

function isRochesterFrederickDouglassInstitutionalSpillover(host, path, search, directSignal, awardName) {
  const awardSignal = wordSignal(awardName);
  if (!/\brochester\b/.test(awardSignal)) return false;
  if (!/\bfrederick douglass\b/.test(awardSignal)) return false;
  if (!/\bpostdoctoral\b/.test(awardSignal)) return false;

  const sourceSignal = wordSignal(`${directSignal} ${path} ${search}`);
  if (/\/aas\/fellowships\/postdoctoral\.html$/.test(path)) return false;
  if (/\bfrederick douglass\b/.test(sourceSignal) && /\bpostdoctoral\b/.test(sourceSignal)) {
    return false;
  }

  if (
    host === "rochester.edu" ||
    host.endsWith(".rochester.edu") ||
    [
      "docs.google.com",
      "help.liaisonedu.com",
      "irs.gov",
      "nasfaa.org",
    ].includes(host)
  ) {
    return true;
  }

  return false;
}

function isOxfordPershingSquareSpillover(host, path, search, directSignal, awardName) {
  const awardSignal = wordSignal(awardName);
  if (!/\boxford\b/.test(awardSignal)) return false;
  if (!/\bpershing square\b/.test(awardSignal)) return false;

  const sourceSignal = wordSignal(`${directSignal} ${path} ${search}`);
  const isSaidHost = host === "sbs.ox.ac.uk" || host === "sbs.oxford.edu";
  const isOxfordHost = host === "ox.ac.uk" || host.endsWith(".ox.ac.uk") || host === "sbs.oxford.edu";

  if (!isOxfordHost) return false;
  if (/\/oxford-pershing-square-[^/]*profiles(?:\/|$)/.test(path)) return true;

  if (
    isSaidHost &&
    (
      path === "/1plus1" ||
      /^\/programmes\/degrees\/1plus1\/pershing-square-scholarship\/?$/.test(path) ||
      /^\/oxford-experience\/scholarships-and-funding\/oxford-pershing-square-(?:graduate-scholarships|scholarship)\/?$/.test(path)
    )
  ) {
    return false;
  }

  if (isSaidHost && /\bpershing square\b/.test(sourceSignal) && !/\bprofiles?\b/.test(sourceSignal)) {
    return false;
  }

  return true;
}

function isSshrcPostdoctoralFellowshipSpillover(host, path, search, directSignal, awardName) {
  const awardSignal = wordSignal(awardName);
  const isSshrcPostdoctoralAward =
    /\b(?:sshrc|social science humanities research council|social sciences humanities research council)\b/.test(
      awardSignal,
    ) && /\bpostdoctoral\b/.test(awardSignal);
  if (!isSshrcPostdoctoralAward) return false;

  const sourceSignal = wordSignal(`${directSignal} ${path} ${search}`);
  const isSshrcHost =
    host === "sshrc-crsh.gc.ca" ||
    host === "sshrcdevnew.sshrc-crsh.gc.ca" ||
    host === "portal-portail.sshrc-crsh.gc.ca";

  if (/\/funding-financement\/programs-programmes\/fellowships\/postdoctoral-postdoctorale-eng\.aspx$/.test(path)) {
    return false;
  }
  if (/\/funding-financement\/apply-demande\/guides\/doctoral_postdoctoral_edi_guide-doctorat_postdoctorales_guide_edi-eng\.aspx$/.test(path)) {
    return false;
  }

  if (
    isSshrcHost &&
    /\bpostdoctor(?:al|ale|ales)\b/.test(sourceSignal) &&
    !/\b(?:nfrf|fnfr|cbrf|frbc|canada graduate|graduate research scholarship|forms online application tools|policy|policies|portal|contact|storytellers|partnership grant)\b/.test(
      sourceSignal,
    )
  ) {
    return false;
  }

  if (isSshrcHost) return true;
  if (
    [
      "nserc-crsng.gc.ca",
      "innovation.ca",
      "snf.ch",
      "dawncanada.net",
      "chairs-chaires.gc.ca",
      "science.gc.ca",
      "achh.ca",
      "criaw-icref.ca",
      "nce-rce.gc.ca",
    ].some((blockedHost) => host === blockedHost || host.endsWith(`.${blockedHost}`))
  ) {
    return true;
  }

  return false;
}

function isNihNiaR36AgingDissertationSpillover(host, path, search, directSignal, awardName) {
  const awardSignal = wordSignal(awardName);
  const isR36AgingDissertationAward =
    /\baging research dissertation awards?\b/.test(awardSignal) ||
    (/\bnia\b/.test(awardSignal) && /\br36\b/.test(awardSignal) && /\bdiversity\b/.test(awardSignal));
  if (!isR36AgingDissertationAward) return false;

  const sourceSignal = wordSignal(`${directSignal} ${path} ${search}`);
  if (/^\/research\/training\/r36-aging-research-dissertation-awards-(?:increase|promote)-diversity\/?$/.test(path)) {
    return false;
  }
  if (
    host === "grants.nih.gov" &&
    /^\/grants\/guide\/(?:pa-files|par-files|rfa-files)\//.test(path) &&
    /\b(?:aging research dissertation|r36)\b/.test(sourceSignal)
  ) {
    return false;
  }

  if (host === "nia.nih.gov" || host.endsWith(".nia.nih.gov")) return true;
  if (
    [
      "grants.nih.gov",
      "era.nih.gov",
      "reporter.nih.gov",
      "projectreporter.nih.gov",
      "clinicaltrials.gov",
      "cdn.clinicaltrials.gov",
      "sciencemag.org",
      "gpo.gov",
    ].some((blockedHost) => host === blockedHost || host.endsWith(`.${blockedHost}`))
  ) {
    return true;
  }

  return false;
}

function isNsfEarthSciencesPostdoctoralSpillover(host, path, search, directSignal, awardName) {
  const awardSignal = wordSignal(awardName);
  const isEarPostdoctoralAward =
    /\b(?:earth sciences|ear)\b/.test(awardSignal) &&
    /\bpostdoctoral\b/.test(awardSignal) &&
    /\b(?:nsf|national science foundation)\b/.test(awardSignal);
  if (!isEarPostdoctoralAward) return false;

  const sourceSignal = wordSignal(`${directSignal} ${path} ${search}`);
  const isNsfHost = host === "nsf.gov" || host === "beta.nsf.gov";

  if (
    isNsfHost &&
    /^\/funding\/opportunities\/(?:ear-postdoctoral-fellowships-ear-pf|ear-pf-earth-sciences-postdoctoral-fellowships)(?:\/|$)/.test(
      path,
    )
  ) {
    return false;
  }

  if (
    isNsfHost &&
    /\b(?:ear pf|earth sciences postdoctoral fellowships?|postdoctoral fellowships ear)\b/.test(sourceSignal) &&
    !/\b(?:dmref|dmr|materials research|seed fund|rui|roa|pui|cmmt|cssi|frontier research earth sciences|data policy|realignment)\b/.test(
      sourceSignal,
    )
  ) {
    return false;
  }

  if (isNsfHost) return true;
  if (
    [
      "research.gov",
      "resources.research.gov",
      "fastlane.nsf.gov",
      "seedfund.nsf.gov",
      "whitehouse.gov",
    ].some((blockedHost) => host === blockedHost || host.endsWith(`.${blockedHost}`))
  ) {
    return true;
  }

  return false;
}

function isOfficialDomainSpilloverSource(parsed, host, path, directHaystack, reason, awardName) {
  const cleanPath = path.toLowerCase();
  const search = String(parsed?.search || "").toLowerCase();
  const directSignal = wordSignal([directHaystack, cleanPath, search].join(" "));
  const combinedSignal = wordSignal([directHaystack, cleanPath, search, reason].join(" "));
  const awardSignal = wordSignal(awardName);

  if (isDoeAgencySpillover(host, cleanPath, directSignal, combinedSignal, awardSignal)) return true;
  if (isOfficeOfScienceSiblingSpillover(host, cleanPath, directSignal, awardSignal)) return true;
  if (isDoeExternalDiscoverySpillover(host, directSignal, combinedSignal, awardSignal)) return true;
  if (isSahrTravelGrantSpillover(host, cleanPath, search, directSignal, awardSignal)) return true;
  if (isNlmNcbiFellowshipSpillover(host, cleanPath, directSignal, awardSignal)) return true;
  if (isCampusHelpdeskSpillover(host, cleanPath, directSignal, awardSignal)) return true;
  if (isSshrcImmigrationSpillover(host, cleanPath, directSignal, awardSignal)) return true;
  if (isNasaAerospaceHistoryFellowshipSpillover(host, cleanPath, search, directSignal, awardSignal)) return true;
  if (isRhodesScholarshipOxfordSpillover(host, cleanPath, search, directSignal, awardSignal)) return true;
  if (isHighVolumeAwardCrawlerSpillover(host, cleanPath, search, directSignal, awardSignal)) return true;

  return false;
}

function isRhodesScholarshipOxfordSpillover(host, path, search, directSignal, awardSignal) {
  const isRhodesScholarship =
    /\brhodes scholarships?\b/.test(awardSignal) && !/\brhodes university\b/.test(awardSignal);
  if (!isRhodesScholarship) return false;

  if (host === "rhodeshouse.ox.ac.uk" || host === "rhodesscholar.org") {
    return false;
  }

  if (
    host === "ox.ac.uk" ||
    host.endsWith(".ox.ac.uk") ||
    [
      "assets.publishing.service.gov.uk",
      "becomecharity.org.uk",
      "euchems.eu",
      "uni-of-oxford.custhelp.com",
    ].includes(host)
  ) {
    return true;
  }

  const sourceSignal = wordSignal(`${directSignal} ${path} ${search}`);
  return /\b(?:graduate application guide|undergraduate applying|student self service|student visa|graduate admissions|college listing|student appeal|course handbook|uniq|crankstart|access oxford|disability advisory service|academic technology approval scheme)\b/.test(
    sourceSignal,
  );
}

function isNasaAerospaceHistoryFellowshipSpillover(host, path, search, directSignal, awardSignal) {
  const isAward =
    /\bnasa\b/.test(awardSignal) &&
    /\baerospace history\b/.test(awardSignal) &&
    /\bfellowships?\b/.test(awardSignal);
  if (!isAward) return false;

  const sourceSignal = wordSignal(`${directSignal} ${path} ${search}`);

  if (host === "nasa.gov" && /^\/history\/history-office\/fellowships\/?$/.test(path)) {
    return false;
  }
  if (host === "historians.org" && /^\/award-grant\/fellowships-in-aerospace-history\/?$/.test(path)) {
    return false;
  }
  if (
    host === "historyoftechnology.org" &&
    /^\/awards\/nasa-fellowship-in-the-history-of-space-technology\/?$/.test(path)
  ) {
    return false;
  }
  if (host === "hssonline.org" && /^\/page\/nasafellowship\/?$/.test(path)) {
    return false;
  }

  if (
    host === "nasa.gov" ||
    host.endsWith(".nasa.gov") ||
    [
      "data.nasa.gov",
      "intern.nasa.gov",
      "nasa.sharepoint.com",
      "pds.mcp.nasa.gov",
      "stemgateway.nasa.gov",
    ].includes(host)
  ) {
    return true;
  }

  if (
    [
      "federalregister.gov",
      "forum.earthdata.nasa.gov",
      "gcc02.safelinks.protection.outlook.com",
      "github.com",
      "ieeexplore.ieee.org",
      "issnationallab.org",
      "opendap.org",
    ].includes(host)
  ) {
    return true;
  }

  if (
    /\b(?:international space station|iss|artemis|earthdata|planetary data|app?eears|opendap|ntrs|pathways|internship|astronaut|brand|media usage|merchandise|grant cooperative agreement|public access|pubspace|science data|station benefits|smd information policy|deia executive orders)\b/.test(
      sourceSignal,
    )
  ) {
    return true;
  }

  return false;
}

function isSahrTravelGrantSpillover(host, path, search, directSignal, awardSignal) {
  if (host !== "sahr.org.uk") return false;
  if (!/\b(?:society army historical|university travel grants?|university research travel grants?)\b/.test(awardSignal)) {
    return false;
  }

  const sourceSignal = `${directSignal} ${path} ${search}`;
  if (
    /\b(?:university research grants?|university research travel grants?|urg rules?|urg)\b/.test(sourceSignal) ||
    /^\/(?:university-research-grants|urg-rules)\.php$/.test(path)
  ) {
    return false;
  }

  return (
    /\bsid=/.test(search) ||
    /^\/(?:electronic-journal-faq|essay-prize-competition|publications|news|events?|login|membership)(?:\.php|\/|$)/.test(path) ||
    !/\b(?:travel grants?|university research)\b/.test(sourceSignal)
  );
}

function isNlmNcbiFellowshipSpillover(host, path, directSignal, awardSignal) {
  const isNlmFellowshipAward =
    /\b(?:national library medicine|nlm|postgraduate librarians?|associate fellowship)\b/.test(awardSignal) &&
    /\b(?:fellowship|fellowships|postgraduate|associate)\b/.test(awardSignal);
  if (!isNlmFellowshipAward) return false;

  const sourceSignal = `${directSignal} ${path}`;
  if (/\b(?:associate fellowship|postgraduate fellowship|nlm associate|librarians fellowship)\b/.test(sourceSignal)) {
    return false;
  }

  if (host === "pubmed.ncbi.nlm.nih.gov" || host === "pmc.ncbi.nlm.nih.gov") return true;
  if (host === "pubchem.ncbi.nlm.nih.gov" || host === "submit.ncbi.nlm.nih.gov") return true;
  if (host === "ftp.ncbi.nlm.nih.gov" || host === "ftp.ncbi.nih.gov" || host === "support.nlm.nih.gov") return true;
  if (host === "catalog.nlm.nih.gov" || host === "cde.nlm.nih.gov") return true;
  if (host === "techbull.nlm.nih.gov") return true;
  if (host === "acmg.net" || host === "icmje.org") return true;
  if (
    [
      "cms.gov",
      "fda.gov",
      "genome.gov",
      "imago.indiana.edu",
      "equator-network.org",
      "ceur-ws.org",
    ].includes(host)
  ) {
    return true;
  }
  if (host === "github.com" && /^\/ncbi(?:\/|$)/.test(path)) return true;

  if (host === "ncbi.nlm.nih.gov") {
    return /^\/(?:portal|mesh|books|gene|nuccore|protein|snp|pmc|clinvar|taxonomy|genome|structure|pubmed|refseq|core|home|datasets|cdd|account|sites|sra|genbank|sutils|projects|biosample|medgen|nlmcatalog|gtr|mailman|assembly|entrez|gquery|tools|viewvc|websub|bioproject|nucleotide|\d{6,})(?:\/|$)/.test(
      path,
    );
  }

  if (host === "nlm.nih.gov") {
    return (
      /^\/(?:bsd|databases|research|pubs|web_policies|about\/collection-development|mesh|training|services|portals|medline|listserv|medlineplus|psd|docline)(?:\/|$)/.test(
        path,
      ) && !/\b(?:associate fellowship|postgraduate fellowship|fellowship program)\b/.test(sourceSignal)
    );
  }

  return false;
}

function isCampusHelpdeskSpillover(host, path, directSignal, awardSignal) {
  const isAtlasAward = /\b(?:accessible teaching learning assessment systems|atlas)\b/.test(awardSignal);
  if (isAtlasAward) {
    const sourceSignal = `${directSignal} ${path}`;
    if (/\batlas\b.*\bresearch fellowship\b/.test(sourceSignal)) return false;
    if (host === "atlas.ku.edu") return false;
    if (host === "services.ku.edu" && /^\/tdclient\//.test(path)) return true;
    if (host === "humanresources.ku.edu") return true;
    if (host === "policy.ku.edu" || host === "admin.ks.gov") return true;
    if (host === "ku.edu" || /(^|\.)ku\.edu$/.test(host) || /(^|\.)kumc\.edu$/.test(host)) return true;
    if (/sharepoint\.com$/.test(host) && /(?:kansas|kumed|ku)/.test(host)) return true;
    if (
      [
        "cisa.gov",
        "dol.gov",
        "gpo.gov",
        "acq.osd.mil",
        "cdc.gov",
        "nvlpubs.nist.gov",
        "google.com",
        "lawrenceks.org",
        "kansasregents.org",
        "aphis.usda.gov",
        "docs.google.com",
        "grants.nih.gov",
        "csrc.nist.gov",
        "nam10.safelinks.protection.outlook.com",
        "kuendowment.org",
        "irs.gov",
      ].includes(host)
    ) {
      return true;
    }
  }

  const isFauHuntingtonAward = /\b(?:florida atlantic|huntington library|doctoral candidates?)\b/.test(awardSignal);
  if (isFauHuntingtonAward) {
    const sourceSignal = `${directSignal} ${path}`;
    if (/\b(?:huntington library|short term fellowship|doctoral candidates?)\b/.test(sourceSignal)) return false;
    if (host === "helpdesk.fau.edu" && /^\/tdclient\//.test(path)) return true;
    if (host === "helpdesk.fau.edu") return true;
  }

  return false;
}

function isSshrcImmigrationSpillover(host, path, directSignal, awardSignal) {
  const isSshrcAward = /\b(?:sshrc|social science humanities research council|doctoral fellowships?)\b/.test(
    awardSignal,
  );
  if (!isSshrcAward) return false;

  const sourceSignal = `${directSignal} ${path}`;
  if (/\b(?:sshrc|crsh|doctoral fellowships?|talent program|graduate scholarships?)\b/.test(sourceSignal)) {
    return false;
  }

  if (host === "sshrc-crsh.canada.ca") return false;
  if (host === "ircc.canada.ca" || host === "cic.gc.ca" || host === "ircc-services.canada.ca") return true;
  if (host === "canada.ca") return true;
  if (host === "nserc-crsng.canada.ca" || host === "cihr-irsc.gc.ca" || host === "sin-nas.canada.ca") return true;
  if (host === "helpx.adobe.com") return true;

  return false;
}

function isHighVolumeAwardCrawlerSpillover(host, path, search, directSignal, awardSignal) {
  const sourceSignal = `${directSignal} ${path} ${search}`;

  if (isErasmusMundusCrawlerSpillover(host, path, search, sourceSignal, awardSignal)) return true;
  if (isArcePreDissertationTravelGrantSpillover(host, path, search, sourceSignal, awardSignal)) return true;
  if (isNstgroCrawlerSpillover(host, path, search, sourceSignal, awardSignal)) return true;
  if (isPlanetaryScienceSummerSchoolSpillover(host, path, search, sourceSignal, awardSignal)) return true;
  if (isMarcUndergraduateTrainingSpillover(host, path, search, sourceSignal, awardSignal)) return true;
  if (isWilsonKennanShortTermGrantSpillover(host, path, search, sourceSignal, awardSignal)) return true;
  if (isSallieMaeBridgingDreamGraduateSpillover(host, path, search, sourceSignal, awardSignal)) return true;
  if (isAafcsGraduateFellowshipSpillover(host, path, search, sourceSignal, awardSignal)) return true;

  if (/\bertegun\b/.test(awardSignal) && (host === "portal.sds.ox.ac.uk" || host === "ox.ac.uk" || host.endsWith(".ox.ac.uk"))) {
    return !/\bertegun\b/.test(sourceSignal);
  }

  if (
    /\bhealth psychology\b/.test(awardSignal) &&
    /\bgraduate student research\b/.test(awardSignal) &&
    host === "societyforhealthpsychology.org" &&
    /^\/(?:read\/articles-resources|articles-resources\/student-advisory-council|job|membership|equicare|get-involved|wp-content\/uploads)(?:\/|$)/.test(
      path,
    )
  ) {
    return !/\b(?:graduate student research|student research awards?|research awards?|award applications?)\b/.test(
      sourceSignal,
    );
  }

  if (/\b(?:afri|agriculture and food research initiative|agriculture food research initiative)\b/.test(awardSignal)) {
    if ((host === "usda.gov" || host === "nifa.usda.gov") && /^\/(?:guidance|resources)\/?$/.test(path)) {
      return /\bf%5b|f\[|topic%3a|resource_type%3a/.test(search);
    }
    if (host === "nrcs.usda.gov") return true;
    if (
      host === "usda.gov" &&
      /^\/(?:sites\/default\/files\/guidance-documents|guidance)(?:\/|$)/.test(path) &&
      !/\b(?:afri|agriculture food research initiative|dissertation|postdoctoral|fellowships?)\b/.test(sourceSignal)
    ) {
      return true;
    }
  }

  if (
    /\b(?:nist|standards technology|summer undergraduate research|surf)\b/.test(awardSignal) &&
    /\b(?:summer undergraduate research|surf)\b/.test(awardSignal)
  ) {
    if (/\b(?:summer undergraduate research|surf)\b/.test(sourceSignal)) return false;
    if (
      (host === "nist.gov" || host === "mgi.nist.gov") &&
      /^\/(?:webform|document|mml|news-events|image|video|programs-projects|publications|nist-organizations|new%20materials)(?:\/|$)/.test(
        path,
      )
    ) {
      return true;
    }
    if (host === "nvlpubs.nist.gov" || host === "tsapps.nist.gov") return true;
  }

  if (/\bamerican library association\b|\bala\b/.test(awardSignal) && /\bscholarships?\b/.test(awardSignal)) {
    if (/\b(?:scholarships?|spectrum scholarship|apply for scholarships?|financial assistance|spectrum)\b/.test(sourceSignal) || /scholarship/i.test(path)) {
      return false;
    }
    if (host === "ala.org" && /^\/(?:cite|acrl\/(?:standards|sites|aboutacrl)|ala\/mgrps|advocacy|aboutala|tools|rusa|yalsa|content-controls|sites\/default\/files)(?:\/|$)/.test(path)) {
      return true;
    }
    if (
      [
        "journals.ala.org",
        "ifla.org",
        "senate.gov",
        "highwire.stanford.edu",
        "pdfs.semanticscholar.org",
        "groups.niso.org",
      ].includes(host)
    ) {
      return true;
    }
  }

  if (/\bberlin program\b|\badvanced german\b|\beuropean studies\b/.test(awardSignal)) {
    if (/\b(?:berlin program|advanced german|european studies)\b/.test(sourceSignal)) return false;
    if (host === "portal.zedat.fu-berlin.de" && /^\/idp-fub\/profile\/saml2\//.test(path)) return true;
    if (
      (host === "fu-berlin.de" || host === "identity.fu-berlin.de") &&
      /^\/(?:sites\/corporate-design|themen\/e-research|(?:en\/)?studium\/bewerbung|(?:en\/)?studium\/international\/studium_ausland\/(?:promos|erasmus2|direkt))(?:\/|$)/.test(
        path,
      )
    ) {
      return true;
    }
  }

  if (/\bexeter\b/.test(awardSignal) && /\bglobal excellence\b/.test(awardSignal)) {
    if (/\b(?:global excellence|exeter excellence scholarships?|award\?id=5612)\b/.test(sourceSignal)) return false;
    if (
      (host === "exeter.ac.uk" || host.endsWith(".exeter.ac.uk")) &&
      /^\/(?:our-campuses|study\/(?:accommodation|cornwall-accommodation)|accommodation|careers|open-days|students\/(?:finance|wellbeing|wp-support|mature)|study\/postgraduate|undergraduate\/applications|v8media\/(?:specificsites\/accommodation|currentstudents|recruitmentsites|universityofexeter\/aboutusresponsive)|postgraduate\/fees)(?:\/|$)/.test(
        path,
      )
    ) {
      return true;
    }
    if (host === "funding.exeter.ac.uk" && !/\baward=5612\b/.test(search)) return true;
    if (["apps.apple.com", "play.google.com", "vacancies.exeter.ac.uk", "codebox.exeter.ac.uk"].includes(host)) {
      return true;
    }
  }

  if (/\bnij\b/.test(awardSignal) && /\b(?:graduate research fellowship|research assistantship)\b/.test(awardSignal)) {
    if (/\b(?:graduate research fellowship|research assistantship|grf|nij rap)\b/.test(sourceSignal)) return false;
    if (
      (host === "nij.ojp.gov" || host === "ojp.gov") &&
      /^\/(?:funding\/(?:opportunities|awards|o-nij[^/]*|docs|explore|financialguidedoj|part200uniformrequirements)|conference-cost|library\/publications|ncjrs)(?:\/|$)/.test(
        path,
      )
    ) {
      return true;
    }
    if (host === "bja.ojp.gov" || host === "it.ojp.gov") return true;
  }

  if (
    /\bflorida atlantic\b/.test(awardSignal) &&
    /\bhuntington library\b/.test(awardSignal) &&
    !/\b(?:huntington library|short term fellowship|doctoral candidates?)\b/.test(sourceSignal)
  ) {
    if (
      (host === "fau.edu" || host.endsWith(".fau.edu") || host === "forms.fau.edu") &&
      /^\/(?:admissions|graduate|registrar|controllers-office|successnetwork|global|ugstudies|careers|news-events|documents|ssoq|uas|facilities|canvas|jobs|regulations)(?:\/|$)/.test(
        path,
      )
    ) {
      return true;
    }
    if (
      [
        "flbog.edu",
        "wordpress.fau.edu",
        "irs.gov",
        "workday.fau.edu",
        "coe.fau.edu",
        "sacscoc.org",
        "fauf.fau.edu",
        "web.respondus.com",
      ].includes(host)
    ) {
      return true;
    }
  }

  return false;
}

function isErasmusMundusCrawlerSpillover(host, path, search, sourceSignal, awardSignal) {
  if (!(/\berasmus mundus\b/.test(awardSignal) || /\bjoint masters\b/.test(awardSignal))) return false;

  if (host === "eacea.ec.europa.eu") {
    if (/^\/scholarships\/erasmus-mundus-catalogue_en\/?$/.test(path)) return false;
    if (/^\/scholarships_en\/?$/.test(path)) return false;
    return true;
  }

  if (host === "erasmus-plus.ec.europa.eu") {
    if (
      /^\/opportunities\/(?:opportunities-for-individuals\/)?(?:individuals\/)?students\/erasmus-mundus-joint-masters(?:-scholarships)?\/?$/.test(
        path,
      )
    ) {
      return false;
    }
    if (/\berasmus mundus joint masters\b/.test(sourceSignal) && !/^\/[a-z]{2}\//.test(path)) {
      return false;
    }
    return true;
  }

  if (
    [
      "ec.europa.eu",
      "webgate.ec.europa.eu",
      "commission.europa.eu",
      "economy-finance.ec.europa.eu",
      "europa.eu",
      "oecd.org",
    ].includes(host)
  ) {
    return true;
  }

  return false;
}

function isArcePreDissertationTravelGrantSpillover(host, path, search, sourceSignal, awardSignal) {
  const isArceAward =
    /\barce\b/.test(awardSignal) &&
    (/\bpre dissertation\b/.test(awardSignal) || /\bcaorc\b/.test(awardSignal));
  if (!isArceAward) return false;

  if (host === "library.arce.org") return true;

  if (host !== "arce.org") return false;
  if (/^\/fellowship\/arce-caorc-research-fellowships\/?$/.test(path)) return false;
  if (/^\/(?:fellowships-landing|for-students-grants)\/?$/.test(path)) return false;

  if (/\b(?:arce caorc|caorc research fellowships?|pre dissertation)\b/.test(sourceSignal)) return false;

  return (
    /^\/(?:annual-meeting|arce-annual-meeting-student-access-grant|arce-archaeological-field-research-grant-research-supporting-members|arce-member-tour-egypt|arce-statement-protection-cultural-heritage|archive|financial-information|for-students-institutions-granting-degrees|for-students-internship-opportunities|grants|programs-fieldwork|research-supporting-members-rsm-projects)(?:\/|$)/.test(
      path,
    ) ||
    /^\/wp-content\/uploads\//.test(path) ||
    !/\b(?:fellowships?|pre dissertation|caorc)\b/.test(sourceSignal)
  );
}

function isNstgroCrawlerSpillover(host, path, search, sourceSignal, awardSignal) {
  const isNstgroAward =
    /\bnstgro\b/.test(awardSignal) ||
    (/\bspace technology\b/.test(awardSignal) && /\bgraduate research\b/.test(awardSignal));
  if (!isNstgroAward) return false;

  if (host === "nasa.gov") {
    if (/^\/directorates\/spacetech\/strg\/nstgro\/?$/.test(path)) return false;
    if (/^\/nasa-space-technology-graduate-research-opportunities-nstgro\/?$/.test(path)) return false;
    return true;
  }

  if (host === "nspires.nasaprs.com" && /\bnstgro\b/.test(sourceSignal)) return false;

  if (
    host.endsWith(".nasa.gov") ||
    [
      "data.nasa.gov",
      "earthdata.nasa.gov",
      "chrome-extension",
      "federalregister.gov",
      "forum.earthdata.nasa.gov",
      "gcc02.safelinks.protection.outlook.com",
      "github.com",
      "issnationallab.org",
      "nasa.sharepoint.com",
      "ntrs.nasa.gov",
      "pds.mcp.nasa.gov",
      "science.nasa.gov",
      "sti.nasa.gov",
      "technology.nasa.gov",
      "ieeexplore.ieee.org",
    ].includes(host)
  ) {
    return true;
  }

  return /\b(?:planetary data system|earthdata|ntrs|pubspace|open science and data management|station|technology transfer|patent|roses|viking mission|webb reveals|whats up|grants policy|cooperative agreement manual|film documentary|merchandising|media guidelines|space technology research grants?)\b/.test(
    sourceSignal,
  );
}

function isPlanetaryScienceSummerSchoolSpillover(host, path, search, sourceSignal, awardSignal) {
  const isPlanetaryScienceSummerSchool =
    /\bplanetary science summer school\b/.test(awardSignal) &&
    /\b(?:nasa|jpl|jet propulsion)\b/.test(awardSignal);
  if (!isPlanetaryScienceSummerSchool) return false;

  if (host === "jpl.nasa.gov") {
    return !/^\/edu\/(?:intern|internships)\/apply\/nasa-science-mission-design-schools\/?$/.test(path);
  }

  if (host === "d2pn8kiwq2w21t.cloudfront.net") {
    return !/^\/documents\/(?:nasa_smds_faq|smds_(?:financialsupport|learninggoals)[^/]*)\.pdf$/.test(path);
  }

  if (host.endsWith(".jpl.nasa.gov")) return true;

  return true;
}

function isMarcUndergraduateTrainingSpillover(host, path, search, sourceSignal, awardSignal) {
  const isMarcAward =
    /\bmaximizing access to research careers\b/.test(awardSignal) ||
    (/\bmarc\b/.test(awardSignal) && /\bundergraduate\b/.test(awardSignal) && /\bresearch\b/.test(awardSignal));
  if (!isMarcAward) return false;

  if (host === "grants.gov" && /^\/search-results-detail\/353267\/?$/.test(path)) return false;
  if (host === "grants.nih.gov" && /^\/grants\/guide\/pa-files\/par-24-138\.html$/.test(path)) return false;
  if (host === "grants.nih.gov" && /^\/grants\/guide\/notice-files\/not-gm-24-033\.html$/.test(path)) {
    return false;
  }
  if (
    host === "nigms.nih.gov" &&
    /^\/loop\/2024\/04\/new-u-rise-and-marc-funding-opportunities-and-upcoming-webinar\/?$/.test(path)
  ) {
    return false;
  }
  if (
    host === "nigms.nih.gov" &&
    /\b(?:marc|maximizing access to research careers|u rise)\b/.test(sourceSignal)
  ) {
    return false;
  }

  if (
    [
      "grants.nih.gov",
      "search.grants.nih.gov",
      "grants1.nih.gov",
      "grants2.nih.gov",
      "era.nih.gov",
      "enhancing-peer-review.nih.gov",
      "public.csr.nih.gov",
      "report.nih.gov",
      "dpcpsi.nih.gov",
      "nih.gov",
      "cdn.clinicaltrials.gov",
      "clinicaltrials.gov",
      "cfo.gov",
      "gpo.gov",
      "frwebgate.access.gpo.gov",
      "edocket.access.gpo.gov",
      "obamawhitehouse.archives.gov",
      "aphis.usda.gov",
      "commed.vcu.edu",
    ].includes(host)
  ) {
    return true;
  }

  if (host === "grants.gov" && !/\b(?:par 24 138|par-24-138|marc|maximizing access to research careers)\b/.test(sourceSignal)) {
    return true;
  }

  return /\b(?:nih guide|weekly index|uniform administrative requirements|grants process|policy compliance|application guide|sf424|assist user guide|peer review|federal funding accountability|clinical trial|biosketch|forms-i|continuous submission|modular budget|submissionschedule|parent announcements|small business application)\b/.test(
    sourceSignal,
  );
}

function isWilsonKennanShortTermGrantSpillover(host, path, search, sourceSignal, awardSignal) {
  const isKennanShortTermGrant =
    /\bkennan\b/.test(awardSignal) &&
    /\bshort term\b/.test(awardSignal) &&
    /\b(?:travel grants?|title viii|russia|former soviet)\b/.test(awardSignal);
  if (!isKennanShortTermGrant) return false;

  if (host === "wilsoncenter.org") {
    if (/^\/opportunity\/kennan-institute(?:-title-viii-supported)?-short-term-grant\/?$/.test(path)) {
      return false;
    }
    return true;
  }

  if (host === "kennaninstitute.org") {
    return !/\b(?:short term grant|short-term grant|title viii)\b/.test(sourceSignal);
  }

  return true;
}

function isSallieMaeBridgingDreamGraduateSpillover(host, path, search, sourceSignal, awardSignal) {
  const isBridgingDreamGraduateAward =
    /\bbridging the dream\b/.test(awardSignal) &&
    /\bgraduate\b/.test(awardSignal) &&
    /\b(?:sallie mae|tmcf|thurgood marshall)\b/.test(awardSignal);
  if (!isBridgingDreamGraduateAward) return false;

  if (host === "salliemae.com") {
    if (/^\/landing\/bridging-the-dream-for-graduates\/?$/.test(path)) return false;
    if (
      /^\/content\/dam\/slm\/writtencontent\/corporate\/(?:20\d{2}-20\d{2}_)?btd_grad_official_rules\.pdf$/.test(
        path,
      )
    ) {
      return false;
    }
    return true;
  }

  if (host === "tmcf.org" || host.endsWith(".tmcf.org")) {
    return !/\b(?:bridging the dream|graduate scholarship)\b/.test(sourceSignal);
  }

  return true;
}

function isAafcsGraduateFellowshipSpillover(host, path, search, sourceSignal, awardSignal) {
  const isAafcsGraduateFellowship =
    (/\baafcs\b/.test(awardSignal) || /\bamerican association of family and consumer sciences\b/.test(awardSignal)) &&
    /\bgraduate fellowships?\b/.test(awardSignal);
  if (!isAafcsGraduateFellowship) return false;

  const pageSignal = `${sourceSignal} ${search}`;
  if (host === "aafcs.org") {
    if (/^\/resources\/recognition\/fellowships\/?$/.test(path)) return false;
    if (/^\/resources\/recognition(?:\/|$)/.test(path) && /\bgraduate fellowships?\b/.test(pageSignal)) {
      return false;
    }
    return true;
  }

  if (host.endsWith(".aafcs.org")) return true;
  if (host === "higherlogicdownload.s3.amazonaws.com") return true;

  return true;
}

function isOfficeOfScienceSiblingSpillover(host, path, directSignal, awardSignal) {
  if (host !== "science.osti.gov") return false;
  if (!/\b(?:science undergraduate laboratory|suli|graduate student research|scgsr)\b/.test(awardSignal)) {
    return false;
  }
  if (hasDoeAwardSpecificSignal(directSignal, awardSignal)) return false;

  return (
    /^\/(?:sbir|user-facilities|leaving-office-of-science)(?:\/|$)/.test(path) ||
    /^\/-\/media\/_\/pdf\/user-facilities(?:\/|$)/.test(path)
  );
}

function isDoeAgencySpillover(host, path, directSignal, combinedSignal, awardSignal) {
  const isDoeHost =
    /(^|\.)energy\.gov$/.test(host) ||
    host === "eere-exchange.energy.gov" ||
    host === "infrastructure-exchange.energy.gov" ||
    host === "fossil.energy.gov" ||
    host === "science.osti.gov";
  if (!isDoeHost) return false;

  const directSourceSignal = `${directSignal} ${path}`;
  const sourceSignal = `${combinedSignal} ${path}`;
  if (hasDoeAwardSpecificSignal(directSourceSignal, awardSignal)) return false;
  if (isDoeFellowshipCollectionPage(path, directSourceSignal, awardSignal)) return false;

  if (
    (host === "eere-exchange.energy.gov" || host === "infrastructure-exchange.energy.gov") &&
    /\/(?:default|faq|filecontent)\.aspx$/i.test(path)
  ) {
    return true;
  }

  if (
    host === "arpa-e.energy.gov" &&
    /\/programs-and-initiatives\/(?:view-all-programs|search-all-projects)(?:\/|$)/.test(path)
  ) {
    return true;
  }

  if (host === "science.osti.gov" && /\/grants\/pdf\/foas\//.test(path)) {
    return true;
  }

  if (
    hasDoeSpilloverParentSignal(sourceSignal) &&
    (
      /\/sites\/(?:default|prod)\/files\//.test(path) ||
      /^\/node\/\d+(?:\/|$)/.test(path) ||
      /^\/(?:science-innovation\/innovation\/hubs|eere\/ammto)(?:\/|$)/.test(path) ||
      /\b(?:oig|fe 746r|lng snapshot|portal faqs|strategy for plastics innovation|conductivity enhanced materials|energy innovation hub|funding selections|large wind turbine materials|advanced manufacturing)\b/.test(
        sourceSignal,
      )
    )
  ) {
    return true;
  }

  if (
    /\/(?:articles?|news|events?|calendar|press|budget-performance|mission|national-laboratories|doe-affiliated-nobel-prize-laureates|work-us-department-energy|energy-program-offices|office-inspector-general|freedom-information-act|submitting-electronic-payment|application-fee|apprenticeships-workforce-development|careers|documents\/faqs-transit-gas-reportingpdf)(?:\/|$)/.test(
      path,
    )
  ) {
    return true;
  }

  if (
    /^\/(?:cio|gc|ig|hgeo|fe|fecm|cmei|cmm)(?:\/|$)/.test(path)
  ) {
    return true;
  }

  return /\b(?:nofo|notice of funding opportunity|critical minerals?|critical materials?|lng export|electronic payments?|filing fee|foia|information quality|vulnerability disclosure|nobel prize|national laboratories|budget performance|budget in brief|mission|careers?|whistleblower|fact sheet|coal plants?|hydrocarbons?|geothermal|advanced manufacturing|workshops?|court order|temporary restraining order|docket room|monthly import exports?|natural gas|import export|e filing|blanket authorization|federal resume|federal register|code of federal regulations|fedconnect|geological survey|mineral commodity summaries|life insurance election|health benefits election|adoption and foster care|apprenticeship|application for federal assistance|sf 424|budget justification|data sheet and workbook|filecontent aspx|faq log|roadmap|project descriptions?|portal user manual|points of entry|application for rehearing|request for rehearing|motion for contempt|motion to intervene|preliminary injunction|frontline advocates?|american petroleum|policy statement)\b/.test(
    sourceSignal,
  );
}

function isDoeExternalDiscoverySpillover(host, directSignal, combinedSignal, awardSignal) {
  if (!/\b(?:doe|department energy|orise|oak ridge|eere|energy efficiency|science undergraduate laboratory|suli|postdoctoral|fellowship|internship)\b/.test(awardSignal)) {
    return false;
  }
  if (hasDoeAwardSpecificSignal(directSignal, awardSignal)) return false;
  if (!hasDoeSpilloverParentSignal(combinedSignal)) return false;

  const externalHosts = [
    /(^|\.)whitehouse\.gov$/,
    /(^|\.)usajobs\.gov$/,
    /(^|\.)dol\.gov$/,
    /(^|\.)gpo\.gov$/,
    /^frwebgate\.access\.gpo\.gov$/,
    /(^|\.)justice\.gov$/,
    /(^|\.)usgs\.gov$/,
    /(^|\.)opm\.gov$/,
    /(^|\.)fedconnect\.net$/,
    /(^|\.)arpa-e\.energy\.gov$/,
    /(^|\.)nrel\.gov$/,
    /(^|\.)science\.osti\.gov$/,
    /(^|\.)docs\.google\.com$/,
    /(^|\.)obamawhitehouse\.archives\.gov$/,
    /(^|\.)trumpwhitehouse\.archives\.gov$/,
  ];

  if (externalHosts.some((pattern) => pattern.test(host))) return true;

  return /\b(?:federal resume|federal register|code of federal regulations|fedconnect|geological survey|mineral commodity summaries|life insurance election|health benefits election|adoption and foster care|apprenticeship|foia|open government act|application for federal assistance|sf 424|budget justification|data sheet and workbook|faq log|portal user manual|motion for contempt|request for rehearing|motion to intervene)\b/.test(
    directSignal,
  );
}

function hasDoeSpilloverParentSignal(signal) {
  return /\b(?:energy gov apprenticeships workforce development|energy gov cmei|energy gov cmm|energy gov hgeo|energy gov gc|energy gov fe|energy gov fecm|fossil energy gov|energy gov ig|energy gov cio|energy gov careers benefits working energy|energy gov work us department energy|energy gov articles energy department|energy gov articles fact sheet|energy gov node|energy gov documents faqs transit gas|energy gov notice court orders|energy gov science innovation innovation hubs|arpa e energy gov programs and initiatives|infrastructure exchange energy gov default aspx|eere exchange energy gov default aspx|eere exchange energy gov faq aspx)\b/.test(
    signal,
  );
}

function hasDoeAwardSpecificSignal(signal, awardSignal = "") {
  if (
    /\b(?:science undergraduate laboratory|suli)\b/.test(awardSignal) &&
    /\b(?:science undergraduate laboratory|suli|wdts suli)\b/.test(signal)
  ) {
    return true;
  }

  if (
    /\b(?:graduate student research|scgsr)\b/.test(awardSignal) &&
    /\b(?:graduate student research|scgsr|wdts scgsr)\b/.test(signal)
  ) {
    return true;
  }

  if (
    /\b(?:orise|oak ridge)\b/.test(awardSignal) &&
    /\b(?:orise|oak ridge|science education|research participation program)\b/.test(signal)
  ) {
    return true;
  }

  return /\b(?:internships?\s+(?:and\s+)?fellowships?|internships?-fellowships?|postdoctoral fellowships?|graduate fellowships?)\b/.test(
    signal,
  );
}

function isDoeFellowshipCollectionPage(path, signal, awardSignal) {
  if (!/\b(?:orise|fellowships?|internships?|postdoctoral|graduate)\b/.test(awardSignal)) return false;
  return path === "/internships-fellowships" || /\binternships?\s+(?:and\s+)?fellowships?\b/.test(signal);
}

function isDuplicatePdfExportUrl(host, path) {
  return (
    /(^|\.)daad\.de$/.test(host) &&
    /\/deutschland\/stipendium\/datenbank\/[^/]+\/21148-scholarship-database\.pdf$/i.test(path)
  );
}

function isSoftwareDownloadUrl(host, path) {
  return host === "get.adobe.com" && /^\/reader\/?$/i.test(path);
}

function isNspiresRosesSpillover(host, path, directSignal, awardName) {
  if (host !== "nspires.nasaprs.com") return false;
  if (!/^\/external\/(?:viewrepositorydocument|solicitations\/summary(?:!init)?\.do)/i.test(path)) {
    return false;
  }

  const signal = wordSignal(directSignal);
  const awardTokens = distinctiveAwardTokens(awardName);
  const tokenMatches = awardTokens.filter((token) => tokenAppears(signal, token));
  if (tokenMatches.length >= Math.min(2, awardTokens.length)) return false;
  if (awardTokens.length >= 2) return true;

  if (
    /\b(?:complete\s+roses|full\s+roses|roses[-\s]?\d{2,4}|summary\s+of\s+solicitation|due\s+dates?|table\s+[23]|guidebook\s+for\s+proposers)\b/i.test(
      signal,
    )
  ) {
    return true;
  }

  if (
    /\b(?:not\s+solicited|program\s+overview|research\s+program\s+overview|research\s+announcement|announcement\s+for\s+proposals|proposer'?s?\s+telecon)\b/i.test(
      signal,
    )
  ) {
    return true;
  }

  if (/^\/external\/solicitations\/summary(?:!init)?\.do/i.test(path)) return true;

  return /^[a-f]\s?\d{1,2}\b/i.test(signal);
}

function isBroadAcademicPdfSpillover(host, path, signal, awardName) {
  if (!/\.pdf(?:$|[?#])/i.test(path)) return false;
  if (host === "static.daad.de" && hasAwardTokenMatch(signal, awardName, 1)) return false;
  if (hasAwardTokenMatch(signal, awardName)) return false;

  return (
    (host === "static.daad.de" && /\/media\/daad_de\/pdfs_nicht_barrierefrei\//.test(path)) ||
    (/(^|\.)kmk\.org$/.test(host) && /\/(?:hochschulzugang|zab)\/|baccalaureate/i.test(path)) ||
    (host === "humboldt-foundation.de" && /\/fileadmin\/bewerben\/programme\/.*list_of_countries\.pdf$/i.test(path)) ||
    (host === "hrk.de" && /\/fileadmin\/redaktion\/hrk\/.*auslandstitel/i.test(path))
  );
}

function isBroadScholarshipBrochurePdf(host, path) {
  return (
    host === "studieren-weltweit.de" &&
    /\/content\/uploads\/\d{4}\/\d{2}\/mit-stipendium-ins-ausland\.pdf$/i.test(path)
  );
}

function hasAwardTokenMatch(signal, awardName, minimum = 2) {
  const sourceSignal = wordSignal(signal);
  const tokens = distinctiveAwardTokens(awardName);
  if (tokens.length === 0) return false;
  const matches = tokens.filter((token) => tokenAppears(sourceSignal, token));
  return matches.length >= Math.min(minimum, tokens.length);
}

function hasDistinctiveAwardSourceMatch(signal, awardName, minimum = 1) {
  const sourceSignal = wordSignal(signal);
  const tokens = distinctiveAwardTokens(awardName).filter(
    (token) => !["alberta", "government", "student", "students", "award", "awards"].includes(token),
  );
  if (tokens.length === 0) return false;
  const matches = tokens.filter((token) => tokenAppears(sourceSignal, token));
  return matches.length >= Math.min(minimum, tokens.length);
}

function isGenericListingOrSearchShape(url, directHaystack) {
  const path = String(url?.pathname || "").toLowerCase();

  return (
    /\/(?:tag|tags|category|categories)(?:\/|$)/.test(path) ||
    /\/(?:search|search-results?|site-search|search-results-page)(?:\/|\.html?|\.aspx?|$)/.test(path) ||
    /\/(?:guidelinesearch|sitesearch|search|searchresults?)\.(?:html?|aspx?|php)$/.test(path) ||
    hasGenericSearchQuery(url, directHaystack)
  );
}

function isOpenDataPortalSpilloverUrl(url, host, path, directHaystack, reason, awardName) {
  if (!/(^|\.)open\.alberta\.ca$/.test(host)) return false;
  if (isOpenAlbertaBoilerplatePath(path)) return true;
  if (/^\/opendata(?:\/|$)/i.test(path)) return true;
  if (/^\/dataset\/[^/]+\/resource\/[^/]+\/download(?:\/|$)/i.test(path)) return true;
  if (isOpenDataListingOrFacetUrl(url, path)) return true;

  const parentSignal = String(reason || "").toLowerCase();
  const awardTokens = distinctiveAwardTokens(awardName).filter(
    (token) => !["alberta", "government", "student"].includes(token),
  );
  const sourceSignal = [directHaystack, url?.toString?.() || "", reason].join(" ");
  if (
    /^\/(?:publications|dataset)\/[^/]+/i.test(path) &&
    awardTokens.length > 0 &&
    !awardTokens.some((token) => tokenAppears(wordSignal(sourceSignal), token)) &&
    (
      /parent source:\s*https?:\/\/(?:[^/\s]+\.)?open\.alberta\.ca\/(?:dataset|publications|opendata)?(?:[/?]|\s|$)/i.test(
        parentSignal,
      ) ||
      /found by the visual snapshot worker after expanding page content/i.test(parentSignal)
    )
  ) {
    return true;
  }

  return false;
}

function isOpenAlbertaBoilerplatePath(path) {
  return /^\/(?:documentation|licence|policy|suggest|dataset|publications)?\/?$/i.test(path);
}

function isOpenDataListingOrFacetUrl(url, path) {
  if (!/^\/(?:publications|dataset|opendata)\/?$/i.test(path)) return false;

  const listingKeys = new Set([
    "audience",
    "dataset_type",
    "organization",
    "page",
    "pubtype",
    "q",
    "res_format",
    "rows",
    "sort",
    "start",
    "tags",
    "topic",
  ]);

  for (const key of url?.searchParams?.keys?.() || []) {
    if (listingKeys.has(key.toLowerCase())) return true;
  }

  return false;
}

function hasGenericSearchQuery(url, directHaystack) {
  if (isSpecificAwardDetailSignal(directHaystack)) return false;

  const path = String(url?.pathname || "").toLowerCase().replace(/\/+$/g, "") || "/";
  const titleSearchSignal = /\b(search results?|site search|back to search|results for)\b/i.test(
    directHaystack,
  );

  for (const [rawKey, rawValue] of url?.searchParams?.entries?.() || []) {
    const key = rawKey.toLowerCase();
    const value = String(rawValue || "").trim();
    if (!value) continue;
    if (["search", "keyword", "keywords", "keys", "search_api_fulltext"].includes(key)) return true;
    if (key === "q" && (titleSearchSignal || path === "/" || /\/(?:search|site-search|search-results?)$/.test(path))) {
      return true;
    }
    if (key === "s" && (titleSearchSignal || path === "/" || path === "/index.php")) return true;
    if (key === "query" && titleSearchSignal) return true;
  }

  return false;
}

function isSpecificAwardDetailSignal(value) {
  return /\b(how to apply|application process|application requirements?|eligibility requirements?|program requirements?|deadline|due date|faq|frequently asked questions?)\b/i.test(
    value,
  );
}

function isKnownBoilerplateUrl(host, path, haystack) {
  const hasAwardSignal =
    /\b(apply|application|applicant|eligib|deadline|due date|requirements?|materials?|guidelines?|nomination|portal|faq|fellowships?|scholarships?|grants?|awards?)\b/.test(
      haystack,
    );
  const hasApplicationSignal =
    /\b(apply|application|applicant|eligib|deadline|due date|nomination|portal|faq|how to apply|application process|application tips)\b/.test(
      haystack,
    );
  if (
    /\b(privacy|terms|accessibility|copyright|cookie|subscribe|newsletter|donate|cart|checkout|login|sign in|log in)\b/.test(
      haystack,
    )
  ) {
    return true;
  }
  if (
    /\b(annual report|bylaws?|board of directors|staff directory|media kit|press kit|sponsorship|advertising|code of conduct|anti-discrimination|anti-harassment|emergency contacts?)\b/.test(
      haystack,
    )
  ) {
    return true;
  }
  if (
    /\b(news|press release|blog|events?|calendar|webinar|podcast|story|stories|recipient profile|past recipients?)\b/.test(
      haystack,
    ) &&
    !hasAwardSignal
  ) {
    return true;
  }
  if (/\/(?:news|blog|events?|calendar|press)(?:\/|$)/.test(path) && !hasApplicationSignal) {
    return true;
  }
  if (/\/(?:privacy|terms|accessibility)(?:\/|$)/.test(path)) {
    return true;
  }
  return /(?:^|\.)youtube\.com$/.test(host) || /(?:^|\.)youtu\.be$/.test(host) || /(?:^|\.)vimeo\.com$/.test(host);
}

function isCrossProgramOrBroadListingSource(directHaystack, awardName) {
  const awardTokens = distinctiveAwardTokens(awardName);
  if (awardTokens.length < 2) return false;

  const normalizedSignal = wordSignal(directHaystack);
  const matchingTokens = awardTokens.filter((token) => tokenAppears(normalizedSignal, token));
  const hasEnoughAwardMatch = matchingTokens.length >= Math.min(2, awardTokens.length);
  if (hasEnoughAwardMatch) return false;

  return (
    /\b(request for applications?|funding opportunities?|policies and procedures|award instructions?|sam faqs?|simons award manager|brand portal|job board|available grants?)\b/.test(
      normalizedSignal,
    ) ||
    /\b(fellows? to faculty|shenoy undergraduate research fellowship|surfin|quantum materials?|graduate scholars program|plasticity and the aging brain|scpab|sfari|neuroscience)\b/.test(
      normalizedSignal,
    ) ||
    /\b(iie heiskell awards?|heiskell awards?|eligibility nomination)\b/.test(
      normalizedSignal,
    )
  );
}

function distinctiveAwardTokens(value) {
  const stop = new Set([
    "award",
    "awards",
    "academic",
    "akademischer",
    "austauschdienst",
    "daad",
    "deutscher",
    "earth",
    "exchange",
    "fellow",
    "fellowship",
    "fellowships",
    "foundation",
    "foundations",
    "grant",
    "grants",
    "graduate",
    "german",
    "international",
    "nasa",
    "national",
    "postdoctoral",
    "program",
    "programs",
    "research",
    "scholar",
    "scholars",
    "scholarship",
    "scholarships",
    "science",
    "sciences",
    "space",
    "student",
    "students",
    "technology",
    "service",
    "undergraduate",
  ]);

  const tokens = String(value || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter((token) => token.length >= 4 && !stop.has(token));

  return [...new Set(tokens)].slice(0, 12);
}

function wordSignal(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenAppears(signal, token) {
  return new RegExp(`\\b${token}\\b`, "i").test(signal);
}

function isOversizedFailure(message, failureType) {
  return /too large|limit \d+ bytes|oversized/i.test(message) || failureType === "too_large";
}

function isPrivateDocumentUrl(host, path, haystack) {
  return (
    /(?:^|\.)docs\.google\.com$/.test(host) ||
    /(?:^|\.)drive\.google\.com$/.test(host) ||
    /\bgoogle docs?|drive\.google|private document|gated document\b/.test(haystack) ||
    /\/document\/d\//.test(path)
  );
}

function isPrivateFailure(statusCode, failureType, message) {
  return statusCode === 401 || failureType === "http_401" || /\bhttp 401\b|unauthorized|permission/i.test(message);
}

function isPermanentHttpFailure(statusCode, failureType, message) {
  if ([400, 401, 404, 405, 410, 409].includes(statusCode || 0)) return true;
  return /\bhttp_(?:400|401|404|405|409|410)\b/.test(failureType) || /\bHTTP (?:400|401|404|405|409|410)\b/i.test(message);
}

function isSoft404Failure(failureType, message) {
  return failureType === "soft_404" || /soft_404|page not found|404 not found/i.test(message);
}

function isBlockedThirdPartyUrl(host, haystack) {
  return (
    /(?:^|\.)studocu\.com$/.test(host) ||
    /(?:^|\.)oxfordbibliographies\.com$/.test(host) ||
    /(?:^|\.)socialstudies\.org$/.test(host) ||
    /(?:^|\.)osti\.gov$/.test(host) ||
    /(?:^|\.)s3\.amazonaws\.com$/.test(host) ||
    /\bthird-party|external reading|reading list|recommended reading\b/.test(haystack)
  );
}

function isBlockedFailure(statusCode, failureType, message) {
  return (
    statusCode === 403 ||
    failureType === "http_403" ||
    failureType === "security_challenge" ||
    failureType === "access_blocked" ||
    /\bHTTP 403\b|forbidden|access denied|security_challenge|robot challenge/i.test(message)
  );
}
