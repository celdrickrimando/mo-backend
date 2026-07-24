// Shared checks applied to every MOA type, per Mo_Rule_Checklist_Spec.md section 0.

import { isTextBold } from "../googleDocs.js";
import { checkNoSignaturesInDraft } from "./draftStage.js";

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

// Internal-only placeholders — confirmed against the actual Internal MOA
// template; these strings don't appear in Sponsorship/Partnership at all,
// so they're kept separate rather than added to the shared list above.
const INTERNAL_PLACEHOLDER_STRINGS = [
  "SHORT ORGANIZATION NAME",
  "DLSU-OFFICE-SHORT ORGANIZATION NAME",
  "DLSU-SLIFE-SHORT ORGANIZATION NAME",
  "NAME OF PROJECT HEAD/ORG REP",
  "NAME OF FACULTY ADVISER",
];

const REQUIRED_SECTIONS = [
  "GENERAL TERMS AND CONDITIONS",
  "TERMINATION OF THE MEMORANDUM OF AGREEMENT",
  "ENTIRE AGREEMENT",
  "DISPUTE RESOLUTION AND VENUE OF ACTIONS",
  "IN WITNESS WHEREOF",
];

// Matches "Month DD, YYYY" e.g. "October 20, 2024"
// /i because the template itself has these dates typed in ALL CAPS (e.g.
// "JUNE 19, 2026") — a case-sensitive match against Title-Case month names
// silently missed every real document and made lead time unparseable.
const VALID_DATE_RE = /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4}\b/i;

export function checkPlaceholders(fullText, moaType) {
  const issues = [];
  const list = moaType === "internal" ? [...PLACEHOLDER_STRINGS, ...INTERNAL_PLACEHOLDER_STRINGS] : PLACEHOLDER_STRINGS;
  for (const placeholder of list) {
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

export function checkPayeeClause(fullText, runs, moaType) {
  const issues = [];
  // Internal MOAs are between two DLSU offices/orgs — there's no external
  // payee, and the actual template legitimately uses plain
  // "DE LA SALLE UNIVERSITY" (no "INC.") throughout; "INC." never appears
  // anywhere in a real Internal MOA. This check only makes sense for
  // Sponsorship/Partnership, where DLSU IS the payee receiving funds and
  // needs the complete legal entity name for the official receipt.
  if (moaType === "internal") return issues;

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

/**
 * Splits a footer's flat run list back into paragraphs, since footer.runs
 * (from extractRuns) is just a linear sequence — a paragraph boundary is
 * wherever a "\n" shows up inside a run's text. Each paragraph also
 * records whether ANY of its runs is a PAGE_NUMBER autoText field.
 *
 * This replaces a previous approach that tried to detect the "Page x of
 * x" line by regex-matching literal digits in the extracted text. That
 * regex could never match: Google Docs renders PAGE_NUMBER/PAGE_COUNT
 * fields dynamically, so extractRuns() gets back an EMPTY string for the
 * actual numbers — only the literal words "Page" and "of" have real
 * text. A digit-matching regex therefore never recognized that line at
 * all, which meant:
 *   (a) the one-line check counted "Page x of x" as a 2nd real paragraph
 *       of the "Memorandum of Agreement..." line and always flagged it, and
 *   (b) the bold check swept the literal (non-bold-by-design) "Page"/"of"
 *       words into the same bucket as the Memorandum line's runs and
 *       always flagged it as having "lost" its bold formatting.
 * Grouping by the actual paragraph (via the "\n" boundary) and judging a
 * whole paragraph as page-number-only if it contains any PAGE_NUMBER
 * field — rather than per-run text content — fixes both.
 */
function splitFooterParagraphs(runs) {
  const paragraphs = [];
  let current = { text: "", runs: [], hasPageNumberField: false };

  for (const run of runs) {
    const segments = run.text.split("\n");
    segments.forEach((segment, i) => {
      if (segment) current.text += segment;
      if (run.isPageNumber) current.hasPageNumberField = true;
      // Only attribute this run to the paragraph it actually contributes
      // to. A run's text can end in "\n" (e.g. the Memorandum line's own
      // run carries its own paragraph-ending newline) — splitting that
      // produces a trailing empty segment representing "nothing more
      // from this run" in the NEXT paragraph. Pushing the run there too
      // would leak it (and its bold state) into a paragraph it isn't
      // actually part of. Only the first segment (i === 0) or a
      // non-empty segment counts as real membership.
      if (segment || i === 0) current.runs.push(run);
      if (i < segments.length - 1) {
        paragraphs.push(current);
        current = { text: "", runs: [], hasPageNumberField: false };
      }
    });
  }
  if (current.text.trim() || current.runs.length) paragraphs.push(current);

  return paragraphs
    .map((p) => ({ ...p, text: p.text.trim() }))
    .filter((p) => p.text || p.hasPageNumberField);
}

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

    const paragraphs = splitFooterParagraphs(footer.runs);
    // "Page x of x" is its own templated field with a different format
    // than the "Memorandum of Agreement..." line — per moa.md, ONLY the
    // "Memorandum of Agreement..." line is subject to the one-line rule.
    // A paragraph counts as the page-number line if it contains the
    // PAGE_NUMBER/PAGE_COUNT autoText field, regardless of the literal
    // "Page"/"of" text around it.
    const moaParagraphs = paragraphs.filter((p) => !p.hasPageNumberField);
    const pageParagraphs = paragraphs.filter((p) => p.hasPageNumberField);
    const moaLineText = moaParagraphs
      .map((p) => p.text)
      .join(" ")
      .trim();

    // (1) One line only — proxy via paragraph count and char length, since
    // Docs API doesn't expose actual rendered line-wrap state.
    if (moaParagraphs.length > 1 || moaLineText.length > FOOTER_SINGLE_LINE_CHAR_THRESHOLD) {
      issues.push({
        type: "footer_not_one_line",
        text: moaLineText || text,
        message:
          'The footer\'s "Memorandum of Agreement..." line appears to wrap past one line (or contains multiple paragraphs of its own, not counting the separate "Page x of x" line). It must stay to a single line.',
      });
    }

    // (2) Consistency — checked once a canonical string is known, either
    // from the "Canonical Text" sheet tab (preferred, user-editable) or
    // the hardcoded fallback above. Internal MOAs' 1st line is freeform
    // per moa.md ("Memorandum of Agreement re: Internal Partnership for
    // [DLSU Event Name]", event name wording not strict) — this exact-
    // match check is only meaningful if a canonical string has actually
    // been configured for "internal" in the sheet; leave that row blank
    // to keep Internal lenient.
    const canonical = canonicalOverride ?? CANONICAL_FOOTER_TEXT[moaType];
    if (canonical && moaLineText !== canonical) {
      issues.push({
        type: "footer_inconsistent",
        text: moaLineText || text,
        message: `Footer text doesn't match the expected wording for ${moaType} MOAs. Expected: "${canonical}".`,
      });
    }

    // (3) Bold retained — judged per ACTUAL PARAGRAPH (see
    // splitFooterParagraphs above), not just the isPageNumber flag on
    // individual runs, which only marks the number fields themselves and
    // would otherwise sweep the literal (correctly non-bold) "Page"/"of"
    // words in that same line into the Memorandum line's bold check.
    const moaRuns = moaParagraphs.flatMap((p) => p.runs).filter((r) => r.text.trim());
    const pageRuns = pageParagraphs.flatMap((p) => p.runs);

    if (moaRuns.length > 0) {
      const boldStates = new Set(moaRuns.map((r) => r.bold));
      if (boldStates.size > 1 || boldStates.has(false)) {
        issues.push({
          type: "footer_bold_not_retained",
          text: moaLineText || text,
          message:
            'Part or all of the footer\'s "Memorandum of Agreement..." text has lost its bold formatting. That line may be resized but must stay bold.',
        });
      }
    }

    if (pageRuns.some((r) => r.bold)) {
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
 * Confirms the footer's "Memorandum of Agreement re: ..." wording matches
 * the document's own "(re: ...)" subtitle under the main title. Unlike
 * checkFooter's canonical-text consistency check (which needs a
 * configured canonical string per MOA type), this compares the doc
 * against ITSELF, so it works out of the box with no sheet config.
 */
export function checkFooterMatchesTitle(fullText, footers) {
  const issues = [];
  if (!footers || footers.length === 0) return issues; // missing_footer already covers this

  const titleMatch = fullText.match(/\(re:\s*([^)]+)\)/i);
  if (!titleMatch) return issues; // no subtitle to compare against

  const titleText = normalizeForDiff(titleMatch[1]);

  for (const footer of footers) {
    const footerMatch = footer.fullText.match(/Memorandum of Agreement re:\s*(.+?)(?:Page\s+\S|$)/i);
    if (!footerMatch) continue;
    const footerText = normalizeForDiff(footerMatch[1]);
    if (!footerText) continue;

    if (footerText !== titleText) {
      issues.push({
        type: "footer_title_mismatch",
        text: footerMatch[0].trim(),
        message: `Footer title ("${footerMatch[1].trim()}") doesn't match the document's own title ("${titleMatch[1].trim()}"). These must be consistent.`,
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

export function checkTopRightCode(fullText, moaType, canonicalOverride, headerText, codedSelection, pdfMode) {
  const issues = [];
  if (moaType !== "sponsorship") return issues; // Internal never uses D-A-1a; Partnership handled separately (absence-only)
  if (pdfMode) return issues; // no reliable header/body separation in flattened PDF text — skip rather than misfire

  // The top-right tracking code lives in the document HEADER, not the
  // body — check headerText if given, falling back to fullText only if
  // no header was supplied (e.g. older callers/tests), so this doesn't
  // hard-crash on missing data, just loses accuracy.
  const hasCode = /D-A-1a/i.test(headerText ?? fullText);
  const canonical = canonicalOverride ?? CANONICAL_GTC_TEXT[moaType];

  // A "coded" MOA follows the GTC→Dispute-Resolution section exactly per
  // the template; the moment that section is substantively edited it
  // becomes "non-coded". `isEdited` is the system's own ground-truth read
  // of that (true = non-coded, false = coded), derived by diffing against
  // the canonical text. It stays null when there's no canonical text to
  // diff against yet.
  let isEdited = null;

  if (canonical) {
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
    isEdited = sim < GTC_SIMILARITY_THRESHOLD;
  }

  // The popup lets the user pre-select "Coded" or "Non-coded" as a
  // precaution before running the check (Sponsorship only). That
  // selection never overrides what the document itself says — it's
  // cross-checked against the system's own determination above, and
  // flagged if it disagrees.
  if (codedSelection === "coded" || codedSelection === "non_coded") {
    const selectionSaysNonCoded = codedSelection === "non_coded";
    if (isEdited !== null && isEdited !== selectionSaysNonCoded) {
      issues.push({
        type: "coded_selection_mismatch",
        text: hasCode ? "D-A-1a" : "GENERAL TERMS AND CONDITIONS",
        message: `You selected "${codedSelection === "coded" ? "Coded" : "Non-coded"}" before running this check, but the GTC→Dispute Resolution section ${
          isEdited ? "appears to have been edited from" : "appears to match"
        } the canonical template — which would make this MOA ${isEdited ? "Non-coded" : "Coded"}. Please double-check the selection.`,
      });
    }
    // If we have no canonical text yet, fall back to trusting the user's
    // selection as the working determination so the add/remove rule below
    // can still run, rather than only surfacing a manual-check flag with
    // no verdict at all.
    if (isEdited === null) {
      isEdited = selectionSaysNonCoded;
    }
  }

  if (isEdited === null) {
    // Can't diff yet, and no user selection to fall back on — just
    // surface the presence/absence of the code so a human reviewer can
    // judge, per moa.md ("up to MNL to check").
    issues.push({
      type: "top_right_code_needs_manual_check",
      text: hasCode ? "D-A-1a" : "GENERAL TERMS AND CONDITIONS",
      message: hasCode
        ? 'Top-right code is "D-A-1a". Automatic verification against the canonical GTC→Dispute Resolution text isn\'t configured yet — please manually confirm this section wasn\'t substantively edited.'
        : 'Top-right code is not "D-A-1a" (or missing). Automatic verification isn\'t configured yet — please manually confirm whether the GTC→Dispute Resolution section was edited, which would justify a change.',
    });
    return issues;
  }

  // Coded (GTC unedited) → the header must have "D-A-1a"; if missing, add it.
  // Non-coded (GTC edited) → the header must NOT have "D-A-1a"; if present, remove it.
  // Otherwise, no comment — per moa.md, only these two cases get flagged.
  if (!isEdited && !hasCode) {
    issues.push({
      type: "top_right_code_should_add",
      text: "GENERAL TERMS AND CONDITIONS",
      message:
        'This MOA is Coded (the GTC→Dispute Resolution section matches the canonical template), but the top-right header is missing "D-A-1a". Please add it.',
    });
  } else if (isEdited && hasCode) {
    issues.push({
      type: "top_right_code_should_remove",
      text: "D-A-1a",
      message:
        'This MOA is Non-coded (the GTC→Dispute Resolution section has been edited from the canonical template), but the top-right header still has "D-A-1a". Please remove it.',
    });
  }

  return issues;
}

/**
 * moa.md/reviewer guidance: the signatory block should start with a page
 * break right after the "IN WITNESS WHEREOF, the parties set their
 * hands... abovementioned:" sentence, before the org-name table heading
 * that follows it. The Docs API DOES expose explicit manual page breaks
 * (Insert > Break > Page break) as their own structural element —
 * extractRuns() in googleDocs.js captures these as `pageBreaks` — so this
 * checks for one positioned shortly after the anchor sentence, instead of
 * always asking for a manual check.
 *
 * Originally an Internal-only check (the anchor sentence and the
 * immediately-following heading are identical boilerplate across all
 * three MOA types — moa.md's page-break guidance was never actually
 * type-specific, only the check itself hadn't been extended yet). Moved
 * here so all three types share one implementation instead of drifting
 * apart.
 *
 * If an explicit page break is found there, no issue is raised at all —
 * confirmed correct, no manual check needed.
 *
 * If none is found, this can't tell "the break is genuinely missing"
 * apart from "the page split naturally without an inserted break, which
 * may still be fine" (the Docs API doesn't expose natural/rendered page
 * boundaries, only explicit ones) — so THAT case still surfaces a
 * manual-check reminder, but a dismissible one: once a reviewer confirms
 * it by eye, they can mark it resolved from the popup and it won't be
 * re-raised on later checks of this document (see DISMISSIBLE_ISSUE_CODES
 * / dismissIssueType in googleDocs.js and index.js's dismissed-issue
 * filtering).
 */
const PAGE_BREAK_SEARCH_WINDOW = 500; // chars after the anchor sentence to look for a break in

export function checkSignatoryBlockPageBreak(fullText, runs, pageBreaks) {
  const issues = [];
  const anchor = "IN WITNESS WHEREOF";
  const anchorIdx = fullText.indexOf(anchor);
  if (anchorIdx === -1) return issues; // missing_required_section already flags this

  // No structural data available (e.g. runs/pageBreaks not supplied) —
  // can't do the real check, fall back to the dismissible reminder.
  if (!runs || !pageBreaks) {
    issues.push(pageBreakManualCheckIssue());
    return issues;
  }

  // Map the fullText character offset of the anchor to its absolute Docs
  // API index by walking `runs` (fullText is the concatenation of
  // runs[].text in order) — same approach as draftStage.js.
  let charsSeen = 0;
  let anchorAbsoluteIndex = null;
  for (const run of runs) {
    if (charsSeen + run.text.length > anchorIdx) {
      anchorAbsoluteIndex = run.startIndex + (anchorIdx - charsSeen);
      break;
    }
    charsSeen += run.text.length;
  }
  if (anchorAbsoluteIndex === null) {
    issues.push(pageBreakManualCheckIssue());
    return issues;
  }

  const hasBreakAfterAnchor = pageBreaks.some(
    (pb) => pb.startIndex >= anchorAbsoluteIndex && pb.startIndex <= anchorAbsoluteIndex + PAGE_BREAK_SEARCH_WINDOW
  );

  if (!hasBreakAfterAnchor) {
    issues.push(pageBreakManualCheckIssue());
  }

  return issues;
}

function pageBreakManualCheckIssue() {
  return {
    type: "signatory_block_page_break_needs_manual_check",
    text: "IN WITNESS WHEREOF",
    message:
      'Please manually confirm: the signatory block starts with a page break right after "IN WITNESS WHEREOF, the parties set their hands...", before the org-name table heading that follows, and all signatories (both parties, through the "Witnessed by" names) fit on that one page. No explicit page break was detected there automatically — this may just mean the page split naturally, which the checker can\'t read; please verify by eye. Once confirmed, you can mark this resolved so it stops appearing on future checks of this document.',
  };
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
    signingDate = safeDate(normalizeDateCasing(`${month} ${day}, ${year}`));
  }

  const anchor = moaType === "internal" ? "Witnesseth that:" : "UNDERTAKING";
  const anchorIdx = fullText.indexOf(anchor);
  let eventStartDate = null;

  if (anchorIdx !== -1) {
    const window = fullText.slice(anchorIdx, anchorIdx + 800);
    const dateMatch = window.match(VALID_DATE_RE);
    if (dateMatch) {
      eventStartDate = safeDate(normalizeDateCasing(dateMatch[0]));
    }
  }

  return { signingDate, eventStartDate };
}

// Templates are frequently typed in ALL CAPS (e.g. "JUNE 19, 2026"). V8
// happens to parse that fine via `new Date(...)`, but that's not a
// guaranteed cross-engine behavior — normalize to "June 19, 2026" first
// so date parsing doesn't silently depend on a JS engine implementation
// detail.
function normalizeDateCasing(str) {
  return str.replace(/[A-Za-z]+/, (month) => month[0].toUpperCase() + month.slice(1).toLowerCase());
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

export function runSharedChecks(fullText, { runs, images, pageBreaks, footers, pageSize, moaType, footerCanonicalOverride, pdfMode } = {}) {
  return [
    ...checkPlaceholders(fullText, moaType),
    ...checkRequiredSections(fullText),
    ...checkPayeeClause(fullText, runs, moaType),
    ...(pdfMode ? [] : checkFooter(footers, moaType, footerCanonicalOverride)),
    ...(pdfMode ? [] : checkFooterMatchesTitle(fullText, footers)),
    ...(pdfMode ? [] : checkOnePageSignatoryBlock(fullText, pageSize)),
    // Applies to all three MOA types — see checkSignatoryBlockPageBreak's
    // doc comment for why this moved here from being Internal-only.
    ...(pdfMode ? [] : checkSignatoryBlockPageBreak(fullText, runs, pageBreaks)),
    ...checkNameHonorifics(fullText, moaType),
    ...(pdfMode ? [] : checkNoSignaturesInDraft(fullText, runs, images)),
  ];
}
