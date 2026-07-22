// Shared checks applied to every MOA type, per Mo_Rule_Checklist_Spec.md section 0.

const PLACEHOLDER_STRINGS = [
  "FULL COMPANY NAME",
  "SHORT COMPANY NAME",
  "NAME OF REPRESENTATIVE",
  "COMPANY ADDRESS",
  "MONTH YEAR",
  "ACTIVITY NAME",
  "EVENT NAME",
  "NAME OF EVENT",
  "ACTIVITY/EVENT NAME",
  "START DATE OF PARTNERSHIP",
  "END DATE OF PARTNERSHIP",
  "ONLINE VENUE & ADDRESS",
  "NAME OF PRESIDENT",
  "FULL NAME OF ORGANIZATION",
  "FULL ORGANIZATION NAME",
];

const REQUIRED_SECTIONS = [
  "GENERAL TERMS AND CONDITIONS",
  "TERMINATION OF THE MEMORANDUM OF AGREEMENT",
  "ENTIRE AGREEMENT",
  "DISPUTE RESOLUTION AND VENUE OF ACTIONS",
  "IN WITNESS WHEREOF",
];

// Matches "Month DD, YYYY" e.g. "October 20, 2024"
const VALID_DATE_RE = /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4}\b/;

export function checkPlaceholders(fullText) {
  const issues = [];
  for (const placeholder of PLACEHOLDER_STRINGS) {
    if (fullText.includes(placeholder)) {
      issues.push({
        type: "unfilled_placeholder",
        text: placeholder,
        message: `"${placeholder}" is still a placeholder — this field needs to be filled in.`,
      });
    }
  }
  return issues;
}

export function checkRequiredSections(fullText) {
  const issues = [];
  for (const section of REQUIRED_SECTIONS) {
    if (!fullText.toUpperCase().includes(section)) {
      issues.push({
        type: "missing_required_section",
        text: section,
        message: `Required section "${section}" was not found. This clause must be present in every MOA.`,
      });
    }
  }
  return issues;
}

export function checkPayeeClause(fullText) {
  const issues = [];
  if (fullText.includes("DE LA SALLE UNIVERSITY") && !fullText.includes("DE LA SALLE UNIVERSITY INC.")) {
    issues.push({
      type: "incomplete_payee_name",
      text: "DE LA SALLE UNIVERSITY",
      message: `"DE LA SALLE UNIVERSITY INC." must always appear complete — found an incomplete reference.`,
    });
  }
  return issues;
}

/**
 * Extracts the signing date ("made and entered on ___ of MONTH YEAR")
 * and the event start date (first date after "Witnesseth that:" for
 * Internal, or "UNDERTAKING" for Sponsorship/Partnership).
 * Returns { signingDate, eventStartDate } as JS Date objects, or nulls
 * if not confidently parsed.
 */
export function extractLeadTimeDates(fullText, moaType) {
  const signingMatch = fullText.match(
    /made and entered on[^,]*?(\d{1,2})(?:st|nd|rd|th)?\s+of\s+(\w+)\s+(\d{4})/i
  );
  let signingDate = null;
  if (signingMatch) {
    const [, day, month, year] = signingMatch;
    signingDate = safeDate(`${month} ${day}, ${year}`);
  }

  const anchor = moaType === "internal" ? "Witnesseth that:" : "UNDERTAKING";
  const anchorIdx = fullText.indexOf(anchor);
  let eventStartDate = null;

  if (anchorIdx !== -1) {
    const window = fullText.slice(anchorIdx, anchorIdx + 800);
    const dateMatch = window.match(VALID_DATE_RE);
    if (dateMatch) {
      eventStartDate = safeDate(dateMatch[0]);
    }
  }

  return { signingDate, eventStartDate };
}

function safeDate(str) {
  const d = new Date(str);
  return isNaN(d.getTime()) ? null : d;
}

const LEAD_TIME_REQUIREMENTS = {
  internal: 7,
  sponsorship: 10,
  partnership: 14,
};

export function checkLeadTime(fullText, moaType) {
  const requiredDays = LEAD_TIME_REQUIREMENTS[moaType];
  const { signingDate, eventStartDate } = extractLeadTimeDates(fullText, moaType);

  if (!signingDate || !eventStartDate) {
    return {
      leadTimeOk: null, // unknown — couldn't confidently parse dates
      leadTimeDays: null,
      requiredLeadTimeDays: requiredDays,
      note: "Could not confidently parse signing date and/or event start date — please verify lead time manually.",
    };
  }

  const diffMs = eventStartDate.getTime() - signingDate.getTime();
  const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24));

  return {
    leadTimeOk: diffDays >= requiredDays,
    leadTimeDays: diffDays,
    requiredLeadTimeDays: requiredDays,
  };
}

export function runSharedChecks(fullText) {
  return [
    ...checkPlaceholders(fullText),
    ...checkRequiredSections(fullText),
    ...checkPayeeClause(fullText),
  ];
}
