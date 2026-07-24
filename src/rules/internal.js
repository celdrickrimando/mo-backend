// Internal MOA checks — Mo_Rule_Checklist_Spec.md section 1

export function checkInternal(fullText, { pdfMode, runs, pageBreaks } = {}) {
  const issues = [];

  // NOTE: Internal MOAs do NOT use the top-right "D-A-1a" tracking code at
  // all — confirmed against the actual Internal MOA template (no header
  // reference to it anywhere, unlike Sponsorship). Unlike Partnership,
  // there's no "flag if present" check here either, since that wasn't
  // reported as an issue — only add one if D-A-1a actually starts turning
  // up in real Internal MOAs.

  // President representation check
  if (!/represented by its President/i.test(fullText)) {
    issues.push({
      type: "signatory_title_mismatch",
      text: "represented by its President",
      message:
        "Internal MOAs must show both parties represented by their President (or equivalent). Confirm the correct title is used.",
    });
  }

  // "Witnesseth that:" clause presence
  if (!fullText.includes("Witnesseth that:")) {
    issues.push({
      type: "missing_clause",
      text: "Witnesseth that:",
      message: '"Witnesseth that:" clause is missing — this defines what the inviting org provides.',
    });
  }

  // Flag unexpected monetary/cash amount (Internal MOAs are non-monetary by template design)
  if (/PHP\s?[\d,]+/.test(fullText)) {
    issues.push({
      type: "unexpected_monetary_value",
      text: "PHP amount found",
      message:
        "Internal MOAs are structured as non-monetary (item/engagement donations). A cash amount was found — please confirm this is intended.",
    });
  }

  issues.push(...checkEventDateFormat(fullText));
  issues.push(...(pdfMode ? [] : checkSignatoryBlockPageBreak(fullText, runs, pageBreaks)));

  return issues;
}

/**
 * NOTE: a "President must appear in the signatory block" check was tried
 * here and removed. The template's own guidance allows "(or equivalent)"
 * — real orgs legitimately use titles like "Chairperson" or "Executive
 * Vice Chairperson for Externals" for one party while the other uses
 * "President"/"Vice President", and a plain text count of the word
 * "President" can't reliably tell a legitimate equivalent apart from an
 * actual omission (confirmed against a real filled-in Internal MOA,
 * where it false-positived). Automating this properly would need
 * knowing each org's actual designated-equivalent title, which isn't
 * available to a text-only check — left as a fully manual review item
 * instead of a noisy automatic flag.
 */

/**
 * Required event date range shape: two valid "Month DD, YYYY" dates
 * joined by "to" (e.g. "JUNE 19, 2026 to JUNE 26, 2026" or "October 20,
 * 2024, to November 20, 2024" are both fine). Confirmed with the user
 * that neither the comma before "to" nor Title Case months are actually
 * required — real documents legitimately use ALL CAPS with no comma, the
 * same as Sponsorship/Partnership. This only flags when the range can't
 * be matched at all, not on comma/casing style.
 */
function checkEventDateFormat(fullText) {
  const issues = [];
  const idx = fullText.indexOf("to be held on");
  if (idx === -1) return issues;

  const window = fullText.slice(idx, idx + 200);
  const rangeMatch = window.match(
    /to be held on\s+[A-Za-z]+\s+\d{1,2},\s+\d{4},?\s+to\s+[A-Za-z]+\s+\d{1,2},\s+\d{4}/i
  );

  if (!rangeMatch) {
    issues.push({
      type: "event_date_format_unclear",
      text: "to be held on",
      message:
        'Could not confidently match the event date range against the required shape ("Month DD, YYYY to Month DD, YYYY"). Please verify manually.',
    });
  }

  return issues;
}

/**
 * moa.md/reviewer guidance: the signatory block should start with a page
 * break right after the "IN WITNESS WHEREOF, the parties set their
 * hands... abovementioned:" sentence, before the "DLSU-OFFICE-SHORT
 * ORGANIZATION NAME" table heading. The Docs API DOES expose explicit
 * manual page breaks (Insert > Break > Page break) as their own
 * structural element — extractRuns() in googleDocs.js now captures these
 * as `pageBreaks`, so this checks for one positioned shortly after the
 * anchor sentence, instead of always asking for a manual check.
 *
 * If an explicit page break is found there, no issue is raised at all —
 * confirmed correct, no manual check needed.
 *
 * If none is found, this can't tell "the break is genuinely missing"
 * apart from "the page split naturally without an inserted break, which
 * may still be fine" (the Docs API doesn't expose natural/rendered page
 * boundaries, only explicit ones) — so THAT case still surfaces a
 * manual-check reminder, but now a dismissible one: once a reviewer
 * confirms it by eye, they can mark it resolved from the popup and it
 * won't be re-raised on later checks of this document (see
 * DISMISSIBLE_ISSUE_CODES / dismissIssueType in googleDocs.js and
 * index.js's dismissed-issue filtering).
 */
const PAGE_BREAK_SEARCH_WINDOW = 500; // chars after the anchor sentence to look for a break in

function checkSignatoryBlockPageBreak(fullText, runs, pageBreaks) {
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
      'Please manually confirm: the signatory block starts with a page break right at the "DLSU-OFFICE-SHORT ORGANIZATION NAME" line, and all signatories (both parties, through the "Witnessed by" names) fit on that one page. No explicit page break was detected there automatically — this may just mean the page split naturally, which the checker can\'t read; please verify by eye. Once confirmed, you can mark this resolved so it stops appearing on future checks of this document.',
  };
}
