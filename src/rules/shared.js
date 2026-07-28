// Shared checks applied to every MOA type, per Mo_Rule_Checklist_Spec.md section 0.

import { isTextBold, isTextItalic, isRangeBold, isRangeItalic } from "../googleDocs.js";
import { checkNoSignaturesInDraft } from "./draftStage.js";
import { checkConstantSignatoryFormatting, DEFAULT_CONSTANT_SIGNATORIES, stripHonorific } from "./constantSignatories.js";
import { checkConstantSignatoryPlacement } from "./signatoryPlacement.js";
import { flatIndexToAbsolute, locationFor, HONORIFICS, runContainingFlatIndex, detectDlsuColumn } from "./textPosition.js";

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
 * Confirms the document's own "(re: ...)" subtitle actually matches the
 * MOA type the reviewer selected in the popup before running the check
 * (e.g. selecting "Partnership" but the subtitle reads "(re: External
 * Sponsorship for ...)"). This is a real, seen-in-practice mistake —
 * either the wrong type was selected in the popup, or the subtitle text
 * itself was copy-pasted from the wrong template and never updated — and
 * previously went completely undetected, since nothing compared the
 * subtitle against the selected moaType at all.
 *
 * Per moa.md's own footer wording convention (see checkFooter above),
 * canonical subtitles read:
 *   - Internal:     "Internal Partnership for [DLSU Event Name]"
 *   - Sponsorship:  "External Sponsorship for [Event Name]"
 *   - Partnership:  "External Partnership for [Event Name]"
 * Internal's canonical wording legitimately contains the word
 * "Partnership" too, so a plain "does it contain the word X" test isn't
 * enough to tell Internal and Partnership apart — classifySubtitle()
 * below checks for "internal" FIRST, before falling through to
 * "sponsorship"/"partnership", so "Internal Partnership" is correctly
 * read as Internal, not Partnership.
 *
 * Two tiers of detection:
 *  1. Specific — the subtitle names an exact type ("Internal",
 *     "Sponsorship", or "Partnership"). Flagged against whichever exact
 *     type was selected.
 *  2. Broad fallback — the specific word isn't there, but "Internal" vs.
 *     "External" still is (e.g. a reworded subtitle that dropped
 *     "Sponsorship"/"Partnership" but kept "External"). "Internal" is
 *     always its own type; "External" covers BOTH Sponsorship and
 *     Partnership — those two are never flagged against each other at
 *     this tier, only against Internal, since a plain "External" doesn't
 *     say which of the two it is.
 *
 * Deliberately conservative: if the subtitle doesn't contain any of
 * "internal"/"external"/"sponsorship"/"partnership" at all, this stays
 * silent rather than guessing — avoiding false positives on a subtitle
 * reworded in a way this can't recognize.
 */
const MOA_TYPE_LABELS = {
  internal: "Internal",
  sponsorship: "Sponsorship",
  partnership: "Partnership",
};

// Which selected moaType values count as "External" for the broad-tier check.
const EXTERNAL_MOA_TYPES = new Set(["sponsorship", "partnership"]);

function classifySubtitle(subtitle) {
  if (/\binternal\b/i.test(subtitle)) return { type: "internal", specific: true };
  if (/\bsponsorship\b/i.test(subtitle)) return { type: "sponsorship", specific: true };
  if (/\bpartnership\b/i.test(subtitle)) return { type: "partnership", specific: true };
  if (/\bexternal\b/i.test(subtitle)) return { type: "external", specific: false };
  return null; // no recognizable type keyword — stay silent, don't guess
}

export function checkSubtitleMatchesSelectedType(fullText, moaType) {
  const issues = [];
  const titleMatch = fullText.match(/\(re:\s*([^)]+)\)/i);
  if (!titleMatch) return issues; // no subtitle to compare against

  const subtitle = titleMatch[1].trim();
  const classification = classifySubtitle(subtitle);
  if (!classification) return issues;

  if (classification.specific) {
    if (classification.type === moaType) return issues;

    issues.push({
      type: "subtitle_type_mismatch",
      text: titleMatch[0],
      message: `The document's subtitle reads "(re: ${subtitle})", which reads as ${articleFor(MOA_TYPE_LABELS[classification.type])} ${MOA_TYPE_LABELS[classification.type]} MOA, but this document was checked as ${MOA_TYPE_LABELS[moaType]}. Please confirm the correct document type — either re-run the check as ${MOA_TYPE_LABELS[classification.type]}, or fix the subtitle wording if ${MOA_TYPE_LABELS[moaType]} is actually correct.`,
    });
    return issues;
  }

  // Broad fallback: only "external" reaches here (no specific word
  // found). "External" is only inconsistent with an Internal selection —
  // it's consistent with either Sponsorship or Partnership, so those two
  // are never flagged against each other at this tier.
  if (!EXTERNAL_MOA_TYPES.has(moaType)) {
    issues.push({
      type: "subtitle_type_mismatch",
      text: titleMatch[0],
      message: `The document's subtitle reads "(re: ${subtitle})", which reads as an External MOA (Sponsorship or Partnership), but this document was checked as Internal. Please confirm the correct document type — either re-run the check as Sponsorship or Partnership (whichever applies), or fix the subtitle wording if Internal is actually correct.`,
    });
  }

  return issues;
}

function articleFor(label) {
  return /^[aeiou]/i.test(label) ? "an" : "a";
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

// The PHP/monetary amount must sit on a specific side of the Undertaking's
// "In return, DLSU-SLIFE-CSO (...) shall:" clause — ABOVE it for
// Sponsorship (the sponsor's own contribution, which the PHP figure
// describes, is stated first; what DLSU/CSO gives back follows), UNDER it
// for Partnership. Per user confirmation, new_additions_v3.md.
const IN_RETURN_CLAUSE_RE = /In return,\s*DLSU-SLIFE-CSO\s*\([^)]*\)\s*shall:/i;

export function checkPhpPositionRelativeToInReturnClause(fullText, direction) {
  const issues = [];
  const clauseMatch = fullText.match(IN_RETURN_CLAUSE_RE);
  if (!clauseMatch) return issues; // clause itself missing/reworded — a different check's concern, not this one's

  const clauseIndex = clauseMatch.index;
  const phpMatches = [...fullText.matchAll(/PHP\s?[\d,]+/g)];
  if (phpMatches.length === 0) return issues; // no PHP amount at all — missing_sponsorship_tier / missing_value_in_monetary_branch already cover that

  // Flag EVERY wrong-side occurrence, not just the first — same reasoning
  // as the stipulation-punctuation fix: a single-match check would
  // silently drop any additional wrong-side amount beyond the first one.
  const wrongSide = phpMatches.filter((m) => (direction === "above" ? m.index > clauseIndex : m.index < clauseIndex));

  for (const m of wrongSide) {
    issues.push({
      type: "php_indication_wrong_position",
      text: m[0],
      message:
        direction === "above"
          ? 'The PHP/monetary amount must appear ABOVE (before) the "In return, DLSU-SLIFE-CSO (...) shall:" clause in the Undertaking.'
          : 'The PHP/monetary amount must appear UNDER (after) the "In return, DLSU-SLIFE-CSO (...) shall:" clause in the Undertaking.',
    });
  }

  return issues;
}

// GTC clause 4 ("Selling is not allowed in campus.") has no variable
// field to check formatting for (see the comment further down where the
// GTC clause regexes are defined), but per new_additions_v3.md its
// presence itself is now a required check, for both Sponsorship and
// Partnership. Looked for within the GTC section specifically (falling
// back to the whole document if the GTC section's own boundaries can't be
// found — gtc_section_not_found already separately flags that case).
export function checkGtcSellingClausePresent(fullText) {
  const issues = [];
  const section = extractGtcSection(fullText) ?? fullText;
  if (!/selling is not allowed in campus/i.test(section)) {
    issues.push({
      type: "missing_gtc_selling_clause",
      text: "GENERAL TERMS AND CONDITIONS",
      message: 'GTC clause 4, "Selling is not allowed in campus.", must be present.',
    });
  }
  return issues;
}

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
  // API index (fullText is the concatenation of runs[].text in order).
  const anchorAbsoluteIndex = flatIndexToAbsolute(runs, anchorIdx);
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
 * New, separate requirement (per new_additions_v3.md): the FULL exact
 * sentence "IN WITNESS WHEREOF, the parties set their hands in the place
 * and date abovementioned:" must be present verbatim, immediately
 * preceded by a page break — i.e. this sentence should start its own
 * fresh page. Distinct from checkSignatoryBlockPageBreak() above, which
 * only anchors off the shorter "IN WITNESS WHEREOF" phrase and looks for
 * a break AFTER it (before the org-name table heading that follows) —
 * this one requires the LONGER exact sentence AND a break BEFORE it. Both
 * checks currently run independently; if your real template only has ONE
 * page break total (serving both roles at once, immediately before this
 * sentence, with the table heading following right after with no second
 * break), let me know — that would need these merged into one check
 * instead of two separate ones each expecting their own break.
 */
export function checkWitnessWhereofSentencePageBreak(fullText, runs, pageBreaks) {
  const issues = [];
  const FULL_SENTENCE = "IN WITNESS WHEREOF, the parties set their hands in the place and date abovementioned:";
  const sentenceIdx = fullText.indexOf(FULL_SENTENCE);

  if (sentenceIdx === -1) {
    issues.push({
      type: "witness_whereof_sentence_missing",
      text: "IN WITNESS WHEREOF",
      message: `The full sentence "${FULL_SENTENCE}" must be present.`,
    });
    return issues; // can't check the page-break relationship without the sentence itself
  }

  // No structural data available — can't do the real page-break check,
  // fall back to the dismissible reminder (same reasoning as
  // checkSignatoryBlockPageBreak: a natural page split without an
  // explicit inserted break isn't detectable via the Docs API).
  if (!runs || !pageBreaks) {
    issues.push(witnessWhereofPageBreakManualCheckIssue());
    return issues;
  }

  const sentenceAbsoluteIndex = flatIndexToAbsolute(runs, sentenceIdx);
  if (sentenceAbsoluteIndex === null) {
    issues.push(witnessWhereofPageBreakManualCheckIssue());
    return issues;
  }

  const hasBreakBeforeSentence = pageBreaks.some(
    (pb) => pb.startIndex <= sentenceAbsoluteIndex && pb.startIndex >= sentenceAbsoluteIndex - PAGE_BREAK_SEARCH_WINDOW
  );

  if (!hasBreakBeforeSentence) {
    issues.push(witnessWhereofPageBreakManualCheckIssue());
  }

  return issues;
}

function witnessWhereofPageBreakManualCheckIssue() {
  return {
    type: "witness_whereof_page_break_needs_manual_check",
    text: "IN WITNESS WHEREOF",
    message:
      'Please manually confirm there is a page break immediately BEFORE "IN WITNESS WHEREOF, the parties set their hands in the place and date abovementioned:" so this sentence starts its own fresh page. No explicit page break was detected there automatically — this may just mean the page split naturally, which the checker can\'t read; please verify by eye. Once confirmed, you can mark this resolved so it stops appearing on future checks of this document.',
  };
}

// Placeholder NAME labels used across the 3 templates that aren't already
// covered by PLACEHOLDER_STRINGS/INTERNAL_PLACEHOLDER_STRINGS above.
const SIGNATORY_NAME_PLACEHOLDERS = new Set([
  "NAME OF WITNESS",
  "NAME OF EXTERNALS/LINKAGES/MARKETING VICE PRESIDENT",
]);

// True if `line` is still unfilled template placeholder text — either an
// exact NAME placeholder, or containing one of the org/company
// placeholder tokens (covers position lines like "Position, Short
// Company Name" or "President, DLSU-SLIFE-SHORT ORGANIZATION NAME"
// generically, without needing every position placeholder spelled out).
function isSignatoryPlaceholderLine(line) {
  if (SIGNATORY_NAME_PLACEHOLDERS.has(line)) return true;
  return [...PLACEHOLDER_STRINGS, ...INTERNAL_PLACEHOLDER_STRINGS].some((p) => line.includes(p));
}

/**
 * Structural (not exact-text) check for every NAME/position pair under a
 * "By:" or "Witnessed by:" marker, regardless of who the signatory
 * actually is (org president, project head, faculty adviser, witness,
 * externals VP...) — confirmed against the real templates (a marker is
 * followed by one or more stacked NAME+position pairs, each name bold +
 * ALL CAPS, each position italicized directly beneath it). This is what
 * covers signatories NOT already known in advance the way
 * checkConstantSignatoryFormatting()'s fixed DLSU roles are — so those
 * are skipped here (by matching against the same constant-signatory
 * list) to avoid reporting the same problem twice under two different
 * issue types.
 *
 * Caveat: pairing is done by taking every 2 non-blank lines between one
 * marker and the next as (name, position) — this holds for the confirmed
 * template layout (each cell contributes an even number of lines: one
 * pair, or two stacked pairs) but could misalign on a document with an
 * unusual/uneven layout. Kept intentionally simple rather than modeling
 * full table-cell boundaries, since the Docs API's own indices don't cleanly
 * expose "which cell was this paragraph in" without much more plumbing.
 */
// Splits `text` into non-blank, trimmed lines while keeping track of each
// line's EXACT absolute position in fullText (baseOffset + its position
// within `text`) — needed so formatting checks can use isRangeBold/
// isRangeItalic on the precise occurrence, not re-search by text content
// and risk matching a different, differently-formatted occurrence of the
// same string elsewhere in the document.
function extractNonBlankLinesWithPositions(text, baseOffset) {
  const lines = [];
  let pos = 0;
  for (const raw of text.split("\n")) {
    const lineStart = pos;
    pos += raw.length + 1; // +1 for the newline that was consumed by split()
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const leadingWs = raw.length - raw.trimStart().length;
    const start = baseOffset + lineStart + leadingWs;
    lines.push({ text: trimmed, start, end: start + trimmed.length });
  }
  return lines;
}

// Counts alphabetic characters only — used to decide whether a line
// under a signatory marker is "a real name" vs. essentially blank (a
// stray space, a lone punctuation mark, an accidental keystroke). 5 was
// chosen as the floor per the user's own judgment call — short enough
// not to reject a genuinely short real name, long enough to reject noise.
function countLetters(str) {
  return (str.match(/[A-Za-z]/g) || []).length;
}

export function checkSignatoryBlockNamePositionFormatting(fullText, runs, constantSignatoriesOverride) {
  const issues = [];
  if (!runs) return issues;

  const anchorIdx = fullText.indexOf("IN WITNESS WHEREOF");
  if (anchorIdx === -1) return issues;

  // Used only to decide which of the two table columns is DLSU/CSO's own
  // (see the blank-slot check below) — that side already gets a more
  // specific, name-aware "who's missing" message from
  // checkConstantSignatoryPlacement() in signatoryPlacement.js, so this
  // generic check skips it there to avoid two different comments landing
  // on the same blank spot.
  const anchorAbsoluteIndex = flatIndexToAbsolute(runs, anchorIdx);
  const signatoryRunsForColumnDetection =
    anchorAbsoluteIndex !== null ? runs.filter((r) => r.startIndex >= anchorAbsoluteIndex && r.tableColumn !== undefined) : [];
  const dlsuColumn = detectDlsuColumn(signatoryRunsForColumnDetection);

  const constantPeople =
    constantSignatoriesOverride && constantSignatoriesOverride.length > 0 ? constantSignatoriesOverride : DEFAULT_CONSTANT_SIGNATORIES;

  // Match on the FULL name (with honorific) OR the honorific-stripped core
  // name — a constant signatory whose honorific is missing/wrong is still
  // a constant signatory, and is already correctly flagged for exactly
  // that (constant_signatory_missing_honorific) by
  // checkConstantSignatoryFormatting(). Without this fallback, a name like
  // "JAMES B. LAXA" (missing "MR.") wouldn't match "MR. JAMES B. LAXA" in
  // this set, so it would fall through to being treated as an ordinary
  // org-typed signatory and get a SECOND, redundant/conflicting bold-check
  // pass here instead of being left to the one check that's actually
  // about him.
  const knownConstantNames = new Set();
  for (const p of constantPeople) {
    knownConstantNames.add(p.name.toUpperCase());
    const core = stripHonorific(p.name);
    if (core) knownConstantNames.add(core.toUpperCase());
  }

  const region = fullText.slice(anchorIdx);
  const markers = [...region.matchAll(/\bBy:|\bWitnessed by:?/g)].map((match) => {
    const flatIndex = anchorIdx + match.index;
    const run = runContainingFlatIndex(runs, flatIndex);
    return { match, flatIndex, column: run ? run.tableColumn : undefined };
  });

  for (let m = 0; m < markers.length; m++) {
    const { match, flatIndex: markerFlatIndex, column: markerColumn } = markers[m];
    const start = match.index + match[0].length;

    // The boundary for THIS marker's content is the next marker that
    // shares the SAME table column — not simply "the next marker in flat
    // text order". Table rows flatten row-by-row/cell-by-cell (see
    // walkContent), so if a marker and its name/position ever sit in
    // DIFFERENT cells (e.g. a "Witnessed by:" header row followed by a
    // separate names row, rather than marker+name together in one cell),
    // the very next marker textually is usually a DIFFERENT column's —
    // which would wrongly cut this marker's window off before ever
    // reaching its own actual name, making a signatory that's genuinely
    // present read as blank. Skipping ahead to the next SAME-column
    // marker (or falling back to the immediate next marker/end of region
    // when the column can't be determined at all) fixes that regardless
    // of which of the two cell layouts the real document actually uses.
    let boundaryMarkerIdx = m + 1;
    if (markerColumn !== undefined) {
      while (boundaryMarkerIdx < markers.length && markers[boundaryMarkerIdx].column !== markerColumn) boundaryMarkerIdx++;
    }
    const end = boundaryMarkerIdx < markers.length ? markers[boundaryMarkerIdx].match.index : region.length;

    let windowLines = extractNonBlankLinesWithPositions(region.slice(start, end), anchorIdx + start);

    // The span between this marker and its same-column boundary can still
    // contain OTHER columns' content in between (e.g. the other column's
    // header/name text, in the header-row-then-names-row layout) — drop
    // any line that isn't actually tagged with this marker's own column,
    // so it can't be mistaken for this marker's name.
    if (markerColumn !== undefined) {
      windowLines = windowLines.filter((line) => {
        const run = runContainingFlatIndex(runs, line.start);
        return run ? run.tableColumn === markerColumn : true; // keep if undeterminable rather than risk dropping a real name
      });
    }

    // Blank slot: nothing at all follows this marker before the next one
    // (or the doc ends), or what's there is too short to be a real name
    // (a stray space/character rather than an actual signatory). Skipped
    // for DLSU/CSO's own column — a blank there means one of the four
    // fixed officers is missing entirely, which
    // checkConstantSignatoryPlacement() in signatoryPlacement.js already
    // reports BY NAME (e.g. "MR. JAMES B. LAXA does not appear...")
    // whenever moaType/csoIsParty give it enough to know who's expected;
    // this generic check exists specifically for the OTHER party's side,
    // where Mo has no fixed name to check against at all.
    const isBlank = windowLines.length === 0 || countLetters(windowLines[0].text) < 5;

    if (isBlank) {
      if (markerColumn === undefined || markerColumn !== dlsuColumn) {
        const markerText = match[0];
        issues.push({
          type: "signatory_name_missing",
          text: markerText,
          message: `No name found under "${markerText}" — a signatory name is required here.`,
          location: locationFor(runs, markerFlatIndex, markerFlatIndex + markerText.length),
        });
      }
      continue; // nothing to format-check when there's no real name there
    }

    for (let i = 0; i + 1 < windowLines.length; i += 2) {
      const nameLine = windowLines[i];
      const posLine = windowLines[i + 1];
      const name = nameLine.text;
      const position = posLine.text;
      if (knownConstantNames.has(name.toUpperCase())) continue; // handled precisely by checkConstantSignatoryFormatting

      if (!isSignatoryPlaceholderLine(name)) {
        if (name !== name.toUpperCase()) {
          issues.push({
            type: "signatory_name_not_allcaps",
            text: name,
            message: `"${name}" (in the signatory block) should be written in ALL CAPS.`,
            location: locationFor(runs, nameLine.start, nameLine.end),
          });
        } else if (isRangeBold(runs, nameLine.start, nameLine.end) === false) {
          issues.push({
            type: "signatory_name_not_bold",
            text: name,
            message: `"${name}" (in the signatory block) must be bold.`,
            location: locationFor(runs, nameLine.start, nameLine.end),
          });
        }
      }

      if (position && !isSignatoryPlaceholderLine(position) && isRangeItalic(runs, posLine.start, posLine.end) === false) {
        issues.push({
          type: "signatory_position_not_italic",
          text: position,
          message: `"${position}" (under ${name}) must be italicized.`,
          location: locationFor(runs, posLine.start, posLine.end),
        });
      }
    }
  }

  return issues;
}

/**
 * The requirement is "all signatories fit on ONE page" — NOT "few
 * signatories." A signatory block with many names (multiple witnesses,
 * higher-tier sponsors, etc.) is completely fine as long as none of them
 * spill onto a second page. checkWitnessWhereofSentencePageBreak() above
 * already confirms a page break exists right at the START of the block
 * (so it doesn't begin partway down a page); this check looks for the
 * OPPOSITE problem — an extra page break landing further in, which means
 * the table/names themselves got split across two pages. Anything after
 * the first ~500 chars (the window checked above) is past the "start
 * cleanly" break and would only exist if something pushed content to a
 * second page.
 */
export function checkNoPageBreakWithinSignatoryBlock(fullText, runs, pageBreaks) {
  const issues = [];
  const anchor = "IN WITNESS WHEREOF";
  const anchorIdx = fullText.indexOf(anchor);
  if (anchorIdx === -1) return issues; // missing_required_section already flags this
  if (!runs || !pageBreaks || pageBreaks.length === 0) return issues;

  const anchorAbsoluteIndex = flatIndexToAbsolute(runs, anchorIdx);
  if (anchorAbsoluteIndex === null) return issues;

  const splittingBreaks = pageBreaks.filter((pb) => pb.startIndex > anchorAbsoluteIndex + PAGE_BREAK_SEARCH_WINDOW);

  if (splittingBreaks.length > 0) {
    issues.push({
      type: "signatory_block_split_across_pages",
      text: "IN WITNESS WHEREOF",
      message:
        "A page break was found partway through the signatory block — this pushes some signatories onto a second page. Having many names under \"By:\"/\"Witnessed by:\" is fine, but all of them (both parties, every witness) must stay on the same single page. Please remove the extra break or adjust spacing so nothing spills past it.",
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
// Captures BOTH the position (group 1) and the name (group 2) from the
// same anchor sentence, so checkNameHonorifics() and
// checkRepresentativeNameAndPositionFormatting() can share one pattern
// instead of two near-duplicate regexes drifting out of sync.
const NAME_ANCHOR_PATTERNS = {
  sponsorship: /represented by its\s+([^,]+),\s*([^,]+),\s*hereinafter referred to as/gid,
  partnership: /represented by its\s+([^,]+),\s*([^,]+),\s*hereinafter referred to as/gid,
  internal: /represented by its\s+(President),\s*([^,]+),\s*hereinafter/gid,
};

// Placeholders that mean "not filled in yet" — already flagged by
// checkPlaceholders(), so skip them here rather than double-flagging.
const NAME_PLACEHOLDER_VALUES = new Set(["NAME OF REPRESENTATIVE", "NAME OF PRESIDENT"]);

export function checkNameHonorifics(fullText, moaType) {
  const issues = [];
  const pattern = NAME_ANCHOR_PATTERNS[moaType];
  if (!pattern) return issues;

  for (const match of fullText.matchAll(pattern)) {
    const name = match[2].trim();
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

/**
 * ALL CAPS + bold on the org-typed representative's name, and italics on
 * their position/rank — both from the same first-page "represented by
 * its [Position], [NAME], hereinafter..." clause used by
 * checkNameHonorifics() above. Confirmed example from the actual
 * template: "Partnership Head, MS. AERA CASSANDA ORLANDA RAMOS" — the
 * position is italicized, the name is bold + all caps.
 *
 * Scoped to this one confirmed anchor for the same reason
 * checkNameHonorifics() is: reliably finding every name/position pair
 * anywhere else in a MOA (e.g. inside the signatory block itself) needs
 * example template text to anchor against safely, not a guess — see
 * constantSignatories.js for the one signatory-block case that IS
 * anchored (fixed DLSU roles with known exact position text).
 */
export function checkRepresentativeNameAndPositionFormatting(fullText, runs, moaType) {
  const issues = [];
  const pattern = NAME_ANCHOR_PATTERNS[moaType];
  if (!pattern || !runs) return issues;

  for (const match of fullText.matchAll(pattern)) {
    const position = match[1].trim();
    const name = match[2].trim();
    if (!name || NAME_PLACEHOLDER_VALUES.has(name)) continue;

    // Shift each group's raw indices to the TRIMMED value's exact
    // position (see checkFieldsAllCapsAndBold's identical comment above
    // for why: re-searching by text instead of using the match's own
    // position can land on a different, differently-formatted occurrence
    // of the same string elsewhere in the document).
    const [nameStartRaw] = match.indices[2];
    const nameLeadingWs = match[2].length - match[2].trimStart().length;
    const nameStart = nameStartRaw + nameLeadingWs;
    const nameEnd = nameStart + name.length;

    const [posStartRaw] = match.indices[1];
    const posLeadingWs = match[1].length - match[1].trimStart().length;
    const posStart = posStartRaw + posLeadingWs;
    const posEnd = posStart + position.length;

    if (name !== name.toUpperCase()) {
      issues.push({
        type: "representative_name_not_allcaps",
        text: name,
        message: `"${name}" should be written in ALL CAPS.`,
        location: locationFor(runs, nameStart, nameEnd),
      });
    } else if (isRangeBold(runs, nameStart, nameEnd) === false) {
      issues.push({
        type: "representative_name_not_bold",
        text: name,
        message: `"${name}" must be bold.`,
        location: locationFor(runs, nameStart, nameEnd),
      });
    }

    if (position && isRangeItalic(runs, posStart, posEnd) === false) {
      issues.push({
        type: "representative_position_not_italic",
        text: position,
        message: `"${position}" (${name}'s position/rank) must be italicized.`,
        location: locationFor(runs, posStart, posEnd),
      });
    }
  }

  return issues;
}

/**
 * Generic "does each captured field read in ALL CAPS and bold" checker.
 * `regex` must have one capture group per entry in `fieldLabels`, in
 * order — used for the Undertaking/Witnesseth clause anchors below,
 * where the surrounding boilerplate wording is fixed (confirmed against
 * the actual templates) and only the fields between it vary per
 * document. Skips a field if it's still an unfilled placeholder
 * (checkPlaceholders already flags those) or empty.
 */
function checkFieldsAllCapsAndBold(fullText, runs, regex, fieldLabels, issueTypePrefix) {
  const issues = [];
  if (!runs) return issues;

  const match = fullText.match(regex);
  if (!match || !match.indices) return issues; // regex must carry the 'd' flag for match.indices

  const allPlaceholders = new Set([...PLACEHOLDER_STRINGS, ...INTERNAL_PLACEHOLDER_STRINGS]);

  fieldLabels.forEach((label, i) => {
    const raw = match[i + 1];
    const rawRange = match.indices[i + 1];
    if (!raw || !rawRange) return;
    const value = raw.trim();
    if (!value || allPlaceholders.has(value)) return; // blank, or still an unfilled placeholder

    // The captured group may include leading/trailing whitespace the
    // regex's \s+ swallowed — shift the range to the TRIMMED value's
    // exact position so the bold check below looks at precisely the
    // right characters, not the value's text content re-searched from
    // scratch (which could land on a completely different, differently-
    // formatted occurrence of the same string elsewhere in the doc).
    const leadingWs = raw.length - raw.trimStart().length;
    const startIndex = rawRange[0] + leadingWs;
    const endIndex = startIndex + value.length;

    if (value !== value.toUpperCase()) {
      issues.push({
        type: `${issueTypePrefix}_not_allcaps`,
        text: value,
        message: `"${value}" (${label}) should be written in ALL CAPS.`,
        location: locationFor(runs, startIndex, endIndex),
      });
    } else if (isRangeBold(runs, startIndex, endIndex) === false) {
      issues.push({
        type: `${issueTypePrefix}_not_bold`,
        text: value,
        message: `"${value}" (${label}) must be bold.`,
        location: locationFor(runs, startIndex, endIndex),
      });
    }
  });

  return issues;
}

// Sponsorship's "I. UNDERTAKING" clause — exact boilerplate wording
// confirmed by the user: "SHORT COMPANY NAME, commits to be a sponsor
// for the ACTIVITY NAME to be held on START DATE OF PARTNERSHIP to END
// DATE OF PARTNERSHIP, at ONLINE VENUE & ADDRESS, and will provide the
// following (free of charge):". Each of the 5 fields must be bold +
// ALL CAPS. Only used for Sponsorship — Partnership's own Undertaking
// wording hasn't been confirmed yet, so this intentionally isn't reused
// there until that boilerplate text is provided.
const SPONSORSHIP_UNDERTAKING_FIELD_RE =
  /UNDERTAKING\s*([^,]+),\s*commits to be a sponsor for the\s+(.+?)\s+to be held on\s+(.+?)\s+to\s+(.+?),\s*at\s+(.+?),\s*and will provide the following/isd;
const SPONSORSHIP_UNDERTAKING_FIELD_LABELS = [
  "SHORT COMPANY NAME",
  "ACTIVITY NAME",
  "START DATE OF PARTNERSHIP",
  "END DATE OF PARTNERSHIP",
  "ONLINE VENUE & ADDRESS",
];

export function checkUndertakingFieldFormatting(fullText, runs) {
  return checkFieldsAllCapsAndBold(
    fullText,
    runs,
    SPONSORSHIP_UNDERTAKING_FIELD_RE,
    SPONSORSHIP_UNDERTAKING_FIELD_LABELS,
    "undertaking_field"
  );
}

// Internal's "Witnesseth that:" clause — exact boilerplate wording
// confirmed by the user: "The DLSU-OFFICE-SHORT ORGANIZATION NAME agrees
// to be a partner for the EVENT NAME to be held on START DATE OF
// PARTNERSHIP to END DATE OF PARTNERSHIP at ONLINE VENUE & ADDRESS and
// will provide the following (free of charge):". No commas around "at",
// unlike the Sponsorship version above — confirmed against the quoted
// text, not a typo.
const INTERNAL_WITNESSETH_FIELD_RE =
  /Witnesseth that:\s*The\s+(.+?)\s+agrees to be a partner for the\s+(.+?)\s+to be held on\s+(.+?)\s+to\s+(.+?)\s+at\s+(.+?)\s+and will provide the following/isd;
const INTERNAL_WITNESSETH_FIELD_LABELS = [
  "DLSU-OFFICE-SHORT ORGANIZATION NAME",
  "EVENT NAME",
  "START DATE OF PARTNERSHIP",
  "END DATE OF PARTNERSHIP",
  "ONLINE VENUE & ADDRESS",
];

export function checkWitnessethFieldFormatting(fullText, runs) {
  return checkFieldsAllCapsAndBold(
    fullText,
    runs,
    INTERNAL_WITNESSETH_FIELD_RE,
    INTERNAL_WITNESSETH_FIELD_LABELS,
    "witnesseth_field"
  );
}

// Sponsorship/Partnership share identical GTC wording (confirmed against
// both actual templates side by side) — clause 1 has TWO variable fields
// (the org and the counterparty), clause 3 has one (the activity). Clause
// 2 ("DE LA SALLE UNIVERSITY INC.") is already covered by
// checkPayeeClause() above; clause 4 ("Selling is not allowed in
// campus.") has no variable field, nothing to check.
//
// The leading "\d+\." is wrapped in an OPTIONAL non-capturing group
// (?:\d+\.\s*)? rather than required. Real GTC lists are usually native
// Google Docs auto-numbered lists, not literally-typed "1." "2." "3." —
// same root cause already diagnosed and fixed for footer page numbers
// elsewhere in this file (see splitFooterParagraphs's doc comment): an
// auto-numbered list's number glyph is rendered dynamically and never
// appears in the Docs API's actual textRun content, so a regex that
// REQUIRES a literal digit prefix silently never matches ANY of these
// clauses at all — which meant every GTC field bold/caps check below
// silently produced zero issues, even on documents with real formatting
// problems. Making the digit optional lets the match succeed whether the
// list is auto-numbered (no literal digit in the text) OR manually typed
// (literal digit present) without caring which.
// The apostrophe in "University's" uses a character class matching BOTH
// the straight apostrophe (') and the curly/typographic one (’, U+2019) —
// Google Docs autocorrects a typed straight quote to the curly one by
// default, so a regex only accounting for the straight quote (the
// original bug here) silently NEVER matched any real document, meaning
// this entire clause 1 check (both fields, on every Sponsorship/
// Partnership MOA) produced zero issues no matter what was actually wrong.
const EXTERNAL_GTC_CLAUSE1_RE =
  /(?:\d+\.\s*)?([^\n]+?)\s+shall acknowledge all monetary donations received from the\s+([^\n]+?)\s+through the issuance of the University['\u2019]?s official receipt/id;
const EXTERNAL_GTC_CLAUSE1_LABELS = ["DLSU-SLIFE-SHORT ORGANIZATION NAME", "SHORT COMPANY NAME"];

const EXTERNAL_GTC_CLAUSE3_RE =
  /in the event that the\s+([^\n]+?)\s+is cancelled, rescheduled or postponed due to a fortuitous event/id;
const EXTERNAL_GTC_CLAUSE3_LABELS = ["ACTIVITY NAME"];

export function checkGtcFieldFormatting(fullText, runs) {
  return [
    ...checkFieldsAllCapsAndBold(fullText, runs, EXTERNAL_GTC_CLAUSE1_RE, EXTERNAL_GTC_CLAUSE1_LABELS, "gtc_clause1_field"),
    ...checkFieldsAllCapsAndBold(fullText, runs, EXTERNAL_GTC_CLAUSE3_RE, EXTERNAL_GTC_CLAUSE3_LABELS, "gtc_clause3_field"),
  ];
}

// Internal's GTC only has 2 clauses (confirmed against the actual
// template) and uses different wording than Sponsorship/Partnership's —
// "all donations" not "all monetary donations", "with the University
// official receipt" not "through the issuance of", "within 1 week" not
// "seven (7) days" — so these are deliberately separate regexes, not a
// shared one with Sponsorship/Partnership. Same optional-digit fix as
// EXTERNAL_GTC_CLAUSE1_RE above, and for the same reason.
const INTERNAL_GTC_CLAUSE1_RE =
  /(?:\d+\.\s*)?([^\n]+?)\s+shall acknowledge all donations received from the\s+([^\n]+?)\s+with the University official receipt/id;
const INTERNAL_GTC_CLAUSE1_LABELS = ["DLSU-SLIFE-SHORT ORGANIZATION NAME", "DLSU-OFFICE-SHORT ORGANIZATION NAME"];

const INTERNAL_GTC_CLAUSE2_RE =
  /(?:\d+\.\s*)?([^\n]+?)\s+shall assume no liability whatsoever in the event that the\s+([^\n]+?)\s+is cancelled, rescheduled or postponed due to a fortuitous event/id;
const INTERNAL_GTC_CLAUSE2_LABELS = ["DLSU-SLIFE-SHORT ORGANIZATION NAME", "NAME OF EVENT"];

export function checkInternalGtcFieldFormatting(fullText, runs) {
  return [
    ...checkFieldsAllCapsAndBold(fullText, runs, INTERNAL_GTC_CLAUSE1_RE, INTERNAL_GTC_CLAUSE1_LABELS, "gtc_clause1_field"),
    ...checkFieldsAllCapsAndBold(fullText, runs, INTERNAL_GTC_CLAUSE2_RE, INTERNAL_GTC_CLAUSE2_LABELS, "gtc_clause2_field"),
  ];
}

/**
 * Confirmed via an inline doc comment on the actual template: the
 * company/org-side witness (left column, under "Witnessed by:") must be
 * a DIFFERENT individual than that same side's earlier representative
 * (left column, under "By:") — with a documented exception that an
 * officer from the inviting org or Central Committee may stand in if no
 * other representative is available. The exception doesn't need special
 * handling here: it just means a different name gets typed in, which the
 * equality check below naturally allows through without needing to know
 * WHO that stand-in officer is.
 *
 * Relies on the tableColumn tagging added in googleDocs.js's
 * extractRuns()/walkContent() to isolate the LEFT cell of each row — the
 * flattened fullText alone can't reliably tell "company's representative"
 * apart from "DLSU's own representative" once both are real (filled-in)
 * names, since the placeholder label that used to mark which was which
 * is gone once someone types over it.
 */
export function checkWitnessDiffersFromRepresentative(fullText, runs) {
  const issues = [];
  if (!runs) return issues;

  const leftColumnRuns = runs.filter((r) => r.tableColumn === 0);
  if (leftColumnRuns.length === 0) return issues; // not laid out as a table (or column 0 wasn't found) — nothing to check

  const leftText = leftColumnRuns.map((r) => r.text).join("");

  function firstLineAfter(marker) {
    const idx = leftText.indexOf(marker);
    if (idx === -1) return null;
    // Handles both "Witnessed by:" and "Witnessed by" (no colon) template
    // variants seen across the actual documents — strip a leftover
    // leading colon so it's never mistaken for a one-character "line".
    const after = leftText.slice(idx + marker.length).replace(/^:\s*/, "");
    const line = after
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0);
    return line || null;
  }

  const representative = firstLineAfter("By:");
  const witness = firstLineAfter("Witnessed by");

  if (
    representative &&
    witness &&
    representative !== "NAME OF REPRESENTATIVE" &&
    witness !== "NAME OF WITNESS" &&
    representative.toUpperCase() === witness.toUpperCase()
  ) {
    issues.push({
      type: "witness_same_as_representative",
      text: witness,
      message: `The witness ("${witness}") must be a different individual from the earlier representative ("${representative}") — unless no one else from the company/org is available, in which case an officer from your organization or the Central Committee may take the witness role instead.`,
    });
  }

  return issues;
}

export function runSharedChecks(fullText, { runs, images, pageBreaks, footers, pageSize, moaType, footerCanonicalOverride, pdfMode, constantSignatoriesOverride, csoIsParty } = {}) {
  return [
    ...checkPlaceholders(fullText, moaType),
    ...checkRequiredSections(fullText),
    ...checkPayeeClause(fullText, runs, moaType),
    ...(pdfMode ? [] : checkFooter(footers, moaType, footerCanonicalOverride)),
    ...(pdfMode ? [] : checkFooterMatchesTitle(fullText, footers)),
    ...(pdfMode ? [] : checkOnePageSignatoryBlock(fullText, pageSize)),
    // checkSignatoryBlockPageBreak() (the shorter "IN WITNESS WHEREOF"
    // anchor, checking for a break AFTER it) is no longer called here —
    // confirmed redundant with checkWitnessWhereofSentencePageBreak below
    // now that the real template only has ONE page break in this area
    // (immediately BEFORE the full sentence). Keeping both was producing
    // two near-identical "please manually confirm" comments on the same
    // spot. The function itself is left defined, unused, in case a
    // template variant ever needs the AFTER-anchored version again.
    ...(pdfMode ? [] : checkWitnessWhereofSentencePageBreak(fullText, runs, pageBreaks)),
    ...(pdfMode ? [] : checkNoPageBreakWithinSignatoryBlock(fullText, runs, pageBreaks)),
    ...checkNameHonorifics(fullText, moaType),
    ...(pdfMode ? [] : checkRepresentativeNameAndPositionFormatting(fullText, runs, moaType)),
    ...checkConstantSignatoryFormatting(fullText, runs, constantSignatoriesOverride),
    ...(pdfMode ? [] : checkSignatoryBlockNamePositionFormatting(fullText, runs, constantSignatoriesOverride)),
    // Which SECTION (By: vs Witnessed by:) Johanne/James/Andreia must
    // appear under — distinct from the formatting check just above. Needs
    // table structure (tableColumn), so skipped in PDF mode same as the
    // other structural signatory-block checks.
    ...(pdfMode ? [] : checkConstantSignatoryPlacement(fullText, runs, moaType, csoIsParty, constantSignatoriesOverride)),
    ...(pdfMode ? [] : checkNoSignaturesInDraft(fullText, runs, images)),
  ];
}
