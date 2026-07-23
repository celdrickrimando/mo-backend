// Shared checks applied to every MOA type, per Mo_Rule_Checklist_Spec.md section 0.

import { isTextBold } from "../googleDocs.js";

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

export function checkPayeeClause(fullText, runs) {
  const issues = [];
  if (fullText.includes("DE LA SALLE UNIVERSITY") && !fullText.includes("DE LA SALLE UNIVERSITY INC.")) {
    issues.push({
      type: "incomplete_payee_name",
      text: "DE LA SALLE UNIVERSITY",
      message: `"DE LA SALLE UNIVERSITY INC." must always appear complete — found an incomplete reference.`,
    });
    return issues; // name itself is wrong — bold check would be redundant/misleading
  }

  // Bold check — only meaningful once we know the runs (isTextBold returns
  // null, not false, if the needle can't be located at all).
  if (runs) {
    const bold = isTextBold(runs, "DE LA SALLE UNIVERSITY INC.");
    if (bold === false) {
      issues.push({
        type: "payee_name_not_bold",
        text: "DE LA SALLE UNIVERSITY INC.",
        message: `"DE LA SALLE UNIVERSITY INC." must be bold — found the complete phrase, but it isn't bolded.`,
      });
    }
  }

  return issues;
}

const CANONICAL_FOOTER_TEXT = {
  internal: null, // fallback default — overridden by the "Canonical Text" sheet tab if set
  sponsorship: null,
  partnership: null,
};

// Rough proxy for "fits on one line" given the template's known page width
// and font — Docs API doesn't expose visual line-wrap directly. Tune this
// against a real one-line footer if it starts mis-flagging.
const FOOTER_SINGLE_LINE_CHAR_THRESHOLD = 110;

export function checkFooter(footers, moaType, canonicalOverride) {
  const issues = [];
  if (!footers || footers.length === 0) {
    issues.push({
      type: "missing_footer",
      text: "",
      message: "No footer was found on this document. The required footer text is missing.",
    });
    return issues;
  }

  for (const footer of footers) {
    const text = footer.fullText.trim();
    if (!text) continue;

    // (1) One line only — proxy via paragraph count and char length, since
    // Docs API doesn't expose actual rendered line-wrap state.
    const paragraphCount = footer.fullText.split("\n").filter((l) => l.trim()).length;
    if (paragraphCount > 1 || text.length > FOOTER_SINGLE_LINE_CHAR_THRESHOLD) {
      issues.push({
        type: "footer_not_one_line",
        text,
        message:
          "The footer appears to wrap past one line (or contains multiple paragraphs). The footer must stay to a single line.",
      });
    }

    // (2) Consistency — checked once a canonical string is known, either
    // from the "Canonical Text" sheet tab (preferred, user-editable) or
    // the hardcoded fallback above.
    const canonical = canonicalOverride ?? CANONICAL_FOOTER_TEXT[moaType];
    if (canonical && text !== canonical) {
      issues.push({
        type: "footer_inconsistent",
        text,
        message: `Footer text doesn't match the expected wording for ${moaType} MOAs. Expected: "${canonical}".`,
      });
    }

    // (3) Bold retained — the footer has two distinct pieces that must be
    // judged separately: the "Memorandum of Agreement..." line (must be
    // bold throughout) and the page-number field (must NOT be bold).
    // Lumping both into one uniform check used to flag a correctly-built
    // footer as broken, since the page number is legitimately non-bold.
    const textRuns = footer.runs.filter((r) => r.text.trim() && !r.isPageNumber);
    const pageNumberRuns = footer.runs.filter((r) => r.isPageNumber);

    if (textRuns.length > 0) {
      const boldStates = new Set(textRuns.map((r) => r.bold));
      if (boldStates.size > 1 || boldStates.has(false)) {
        issues.push({
          type: "footer_bold_not_retained",
          text,
          message:
            'Part or all of the footer\'s "Memorandum of Agreement..." text has lost its bold formatting. That line may be resized but must stay bold.',
        });
      }
    }

    if (pageNumberRuns.some((r) => r.bold)) {
      issues.push({
        type: "footer_page_number_bold",
        text,
        message:
          "The page number in the footer is bold — it should not be. Only the \"Memorandum of Agreement...\" text should be bold.",
      });
    }
  }

  return issues;
}

/**
 * Top-right tracking code (D-A-1a) correctness for Sponsorship/Internal.
 * moa.md: if the GTC-through-Dispute-Resolution section differs from the
 * canonical template text, the code must change from "D-A-1a"; otherwise
 * it must stay "D-A-1a".
 *
 * CANONICAL_GTC_TEXT below is a fallback default — the "Canonical Text"
 * sheet tab (row: MOA Type=sponsorship/internal, Check=GTC) is the
 * preferred, user-editable source; this only kicks in if that row is
 * blank. Until either is filled in, this only surfaces the code that's
 * present, without asserting pass/fail, matching moa.md's note that this
 * may intentionally stay a human-verified flag rather than a hard rule.
 */
const CANONICAL_GTC_TEXT = {
  internal: null,
  sponsorship: null,
};

const GTC_SECTION_START = "GENERAL TERMS AND CONDITIONS";
const GTC_SECTION_END = "DISPUTE RESOLUTION AND VENUE OF ACTIONS";

function normalizeForDiff(str) {
  return str.replace(/\s+/g, " ").trim().toLowerCase();
}

function extractGtcSection(fullText) {
  const start = fullText.indexOf(GTC_SECTION_START);
  if (start === -1) return null;
  const endLabelIdx = fullText.indexOf(GTC_SECTION_END, start);
  if (endLabelIdx === -1) return null;
  // Include through the end of the Dispute Resolution heading's own
  // clause text — grab a generous window since we don't know where that
  // clause ends without a further heading; callers only use this for a
  // similarity comparison, not exact boundaries.
  return fullText.slice(start, endLabelIdx + GTC_SECTION_END.length + 1000);
}

// Cheap token-overlap similarity — good enough to flag "substantively
// different" vs "same modulo formatting" without pulling in a diff lib.
function similarity(a, b) {
  const tokensA = new Set(normalizeForDiff(a).split(" "));
  const tokensB = new Set(normalizeForDiff(b).split(" "));
  if (tokensA.size === 0 || tokensB.size === 0) return 0;
  let overlap = 0;
  for (const t of tokensA) if (tokensB.has(t)) overlap++;
  return overlap / Math.max(tokensA.size, tokensB.size);
}

const GTC_SIMILARITY_THRESHOLD = 0.95; // below this = "substantively edited"

export function checkTopRightCode(fullText, moaType, canonicalOverride, headerText) {
  const issues = [];
  if (moaType !== "sponsorship" && moaType !== "internal") return issues; // Partnership handled separately (absence-only)

  // The top-right tracking code lives in the document HEADER, not the
  // body — check headerText if given, falling back to fullText only if
  // no header was supplied (e.g. older callers/tests), so this doesn't
  // hard-crash on missing data, just loses accuracy.
  const hasCode = /D-A-1a/i.test(headerText ?? fullText);
  const canonical = canonicalOverride ?? CANONICAL_GTC_TEXT[moaType];

  if (!canonical) {
    // Can't diff yet — just surface the presence/absence of the code so a
    // human reviewer can judge, per moa.md ("up to MNL to check").
    issues.push({
      type: "top_right_code_needs_manual_check",
      text: hasCode ? "D-A-1a" : "GENERAL TERMS AND CONDITIONS",
      message: hasCode
        ? 'Top-right code is "D-A-1a". Automatic verification against the canonical GTC→Dispute Resolution text isn\'t configured yet — please manually confirm this section wasn\'t substantively edited.'
        : 'Top-right code is not "D-A-1a" (or missing). Automatic verification isn\'t configured yet — please manually confirm whether the GTC→Dispute Resolution section was edited, which would justify a change.',
    });
    return issues;
  }

  const section = extractGtcSection(fullText);
  if (!section) {
    issues.push({
      type: "gtc_section_not_found",
      text: GTC_SECTION_START,
      message: "Could not locate the GTC→Dispute Resolution section to verify the top-right code.",
    });
    return issues;
  }

  const sim = similarity(section, canonical);
  const isEdited = sim < GTC_SIMILARITY_THRESHOLD;

  if (isEdited && hasCode) {
    issues.push({
      type: "top_right_code_should_change",
      text: "D-A-1a",
      message:
        "The GTC→Dispute Resolution section appears to differ from the canonical template, but the top-right code still reads \"D-A-1a\". It should be updated.",
    });
  } else if (!isEdited && !hasCode) {
    issues.push({
      type: "top_right_code_changed_without_cause",
      text: "GENERAL TERMS AND CONDITIONS",
      message:
        'The GTC→Dispute Resolution section matches the canonical template, but the top-right code isn\'t "D-A-1a". Please confirm this change was intentional.',
    });
  }

  return issues;
}

/**
 * One-page signatory block estimate. moa.md: all signatories must fit on
 * one printed page. The Docs API doesn't expose page boundaries for
 * natural text overflow (only explicit pageBreak elements), so this is an
 * estimate from page height vs. an approximate line count for the
 * signatory block — always surfaced as a manual-check flag, never a hard
 * pass/fail, per the spec's recommendation.
 */
const APPROX_PT_PER_LINE = 14; // rough single-spaced line height at default template font size
const APPROX_MARGIN_PT = 72; // ~1in top+bottom margins combined, rough default

export function checkOnePageSignatoryBlock(fullText, pageSize) {
  const issues = [];
  const anchor = "IN WITNESS WHEREOF";
  const anchorIdx = fullText.indexOf(anchor);
  if (anchorIdx === -1) return issues; // missing_required_section already flags this

  const signatoryBlock = fullText.slice(anchorIdx);
  const lineCount = signatoryBlock.split("\n").filter((l) => l.trim()).length;

  if (!pageSize?.height?.magnitude) {
    issues.push({
      type: "signatory_block_page_fit_unknown",
      text: anchor,
      message:
        "Could not read page dimensions to estimate whether the signatory block fits on one page — please check manually.",
    });
    return issues;
  }

  const usablePt = pageSize.height.magnitude - APPROX_MARGIN_PT;
  const estimatedLinesPerPage = Math.floor(usablePt / APPROX_PT_PER_LINE);

  if (lineCount > estimatedLinesPerPage) {
    issues.push({
      type: "signatory_block_may_exceed_one_page",
      text: anchor,
      message: `The signatory block (from "IN WITNESS WHEREOF" onward, ~${lineCount} lines) may exceed one printed page (est. ~${estimatedLinesPerPage} lines/page). This is an estimate — please verify manually before submission.`,
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

export function checkFonEitherOr(fullText) {
  const issues = [];

  // Scope to only the counterparty's own party-description clause — the
  // text BEFORE DLSU's section begins. Every MOA (even a correct one)
  // contains "a recognized organization of De La Salle University" in
  // DLSU's own fixed boilerplate later in the document, which would
  // otherwise always false-positive as if it were the counterparty's
  // leftover alternate phrase.
  const dlsuIdx = fullText.search(/DE LA SALLE UNIVERSITY/i);
  const counterpartyText = dlsuIdx === -1 ? fullText : fullText.slice(0, dlsuIdx);

  const hasCompanyPhrase = /a company registered with the law of the Republic of the Philippines/i.test(counterpartyText);
  const hasSchoolPhrase = /a recognized organization of [A-Z][A-Za-z\s.]+/i.test(counterpartyText);

  if (hasCompanyPhrase && hasSchoolPhrase) {
    issues.push({
      type: "fon_both_options_present",
      text: "a company registered with the law of the Republic of the Philippines",
      message:
        'Both party-type options are present ("a company registered..." AND "a recognized organization of...") in the counterparty\'s clause. Keep only the one that applies and delete the other.',
    });
  } else if (!hasCompanyPhrase && !hasSchoolPhrase) {
    issues.push({
      type: "fon_missing_party_type",
      text: "FULL COMPANY NAME",
      message:
        'Neither party-type phrase is present in the counterparty\'s clause. State whether the counterparty is "a company registered with the law of the Republic of the Philippines" or "a recognized organization of [University Name]".',
    });
  }

  return issues;
}

/**
 * Honorifics on org-typed representative/president names. moa.md: any
 * name an org types into the template must carry an honorific, same as
 * the hardcoded DLSU signatory names (e.g. "MR. JAMES B. LAXA"), and in
 * all caps to match template convention.
 *
 * This only checks the two known anchor sentences where an org types a
 * name in (confirmed against the actual template wording):
 *   - Sponsorship/Partnership: "...represented by its [Position],
 *     [NAME], hereinafter referred to as the [Short Company Name]."
 *   - Internal: "...represented by its President, [NAME], hereinafter..."
 * It intentionally does NOT scan the whole document for names — general
 * name-detection needs an LLM call and isn't worth it for just these two
 * fixed slots (see signatoryTiers.js for the same reasoning).
 */
const HONORIFICS = ["MR.", "MS.", "MRS.", "DR.", "ATTY.", "ENGR.", "FR.", "BR.", "SR.", "HON.", "REV."];

const NAME_ANCHOR_PATTERNS = {
  sponsorship: /represented by its [^,]+,\s*([^,]+),\s*hereinafter referred to as/gi,
  partnership: /represented by its [^,]+,\s*([^,]+),\s*hereinafter referred to as/gi,
  internal: /represented by its President,\s*([^,]+),\s*hereinafter/gi,
};

// Placeholders that mean "not filled in yet" — already flagged by
// checkPlaceholders(), so skip them here rather than double-flagging.
const NAME_PLACEHOLDER_VALUES = new Set(["NAME OF REPRESENTATIVE", "NAME OF PRESIDENT"]);

export function checkNameHonorifics(fullText, moaType) {
  const issues = [];
  const pattern = NAME_ANCHOR_PATTERNS[moaType];
  if (!pattern) return issues;

  for (const match of fullText.matchAll(pattern)) {
    const name = match[1].trim();
    if (!name || NAME_PLACEHOLDER_VALUES.has(name)) continue; // still a placeholder, handled elsewhere

    const hasHonorific = HONORIFICS.some((h) => name.startsWith(h));
    if (!hasHonorific) {
      issues.push({
        type: "missing_name_honorific",
        text: name,
        message: `"${name}" is missing an honorific (e.g. MR., MS., DR., ATTY.) in all caps, matching template convention.`,
      });
    }
  }

  return issues;
}

export function runSharedChecks(fullText, { runs, footers, pageSize, moaType, footerCanonicalOverride } = {}) {
  return [
    ...checkPlaceholders(fullText),
    ...checkRequiredSections(fullText),
    ...checkPayeeClause(fullText, runs),
    ...checkFooter(footers, moaType, footerCanonicalOverride),
    ...checkOnePageSignatoryBlock(fullText, pageSize),
    ...checkNameHonorifics(fullText, moaType),
  ];
}
