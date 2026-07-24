// Internal MOA checks — Mo_Rule_Checklist_Spec.md section 1

export function checkInternal(fullText, { pdfMode } = {}) {
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

  issues.push(...checkPresidentInSignatoryBlock(fullText));
  issues.push(...checkEventDateFormat(fullText));
  issues.push(...checkSignatoryBlockPageBreak(fullText));

  return issues;
}

/**
 * Both parties' representatives in the FINAL signatory block (not just
 * the opening "represented by its President" clause) must be shown as
 * President (or an explicitly-noted equivalent). Heuristic: count
 * "President" occurrences after "IN WITNESS WHEREOF" — the template has
 * two (one per party column), so fewer than two suggests one column's
 * title was swapped for something else. Best-effort text heuristic, not
 * a structural read of the actual table layout — flag as such in the
 * message rather than asserting it with full confidence.
 */
function checkPresidentInSignatoryBlock(fullText) {
  const issues = [];
  const witnessIdx = fullText.indexOf("IN WITNESS WHEREOF");
  if (witnessIdx === -1) return issues; // missing_required_section already flags this

  const block = fullText.slice(witnessIdx);
  const presidentCount = (block.match(/president/gi) || []).length;

  if (presidentCount < 2) {
    issues.push({
      type: "president_missing_from_signatory_block",
      text: "IN WITNESS WHEREOF",
      message:
        'Both parties\' representatives must always be shown as President (or an explicitly noted equivalent) in the final signatory block, not just in the opening "represented by its President" clause. "President" appears fewer than expected times in that block — please confirm both signatories are shown correctly.',
    });
  }

  return issues;
}

/**
 * Required event date range format: "Month DD, YYYY, to Month DD, YYYY"
 * (e.g. "October 20, 2024, to November 20, 2024") — proper Title Case
 * months, comma before "to". This is an Internal-specific convention;
 * Sponsorship/Partnership documents legitimately use ALL CAPS dates
 * instead (see extractLeadTimeDates in shared.js), so this check is
 * intentionally NOT shared across MOA types.
 */
function checkEventDateFormat(fullText) {
  const issues = [];
  const idx = fullText.indexOf("to be held on");
  if (idx === -1) return issues;

  const window = fullText.slice(idx, idx + 200);
  const rangeMatch = window.match(
    /to be held on\s+([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})(,)?\s+to\s+([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})/
  );

  if (!rangeMatch) {
    issues.push({
      type: "event_date_format_unclear",
      text: "to be held on",
      message:
        'Could not confidently match the event date range against the required format ("Month DD, YYYY, to Month DD, YYYY", e.g. "October 20, 2024, to November 20, 2024"). Please verify manually.',
    });
    return issues;
  }

  const [, month1, , , comma, month2] = rangeMatch;
  const isTitleCase = (m) => /^[A-Z][a-z]+$/.test(m);

  const problems = [];
  if (!comma) problems.push('missing the comma before "to"');
  if (!isTitleCase(month1) || !isTitleCase(month2)) {
    problems.push('month names should be written in standard Title Case (e.g. "October", not "OCTOBER" or "october")');
  }

  if (problems.length > 0) {
    issues.push({
      type: "event_date_format_incorrect",
      text: rangeMatch[0],
      message: `Event date range doesn't match the required format ("October 20, 2024, to November 20, 2024"): ${problems.join("; ")}.`,
    });
  }

  return issues;
}

/**
 * moa.md/reviewer guidance: the signatory block should start with a page
 * break right at the "DLSU-OFFICE-SHORT ORGANIZATION NAME" line, and all
 * signatories (through both "Witnessed by" names) must fit on that one
 * page. This is a genuine structural/layout requirement, but the current
 * text-extraction pipeline only reads flattened run text — it doesn't
 * capture paragraph-level "page break before" flags or table row
 * geometry, so this can't be verified programmatically yet (unlike
 * checkOnePageSignatoryBlock's page-height estimate, which at least has
 * an approximate line count to work with). Rather than silently skip
 * it, or guess and risk a wrong verdict, this always surfaces as an
 * explicit manual-check reminder for Internal MOAs. If this becomes
 * worth automating later, it needs paragraph.paragraphStyle.pageBreakBefore
 * read from the Docs API, threaded through similarly to how inline
 * images are captured for the draft-signature check.
 */
function checkSignatoryBlockPageBreak(fullText) {
  const issues = [];
  if (!fullText.includes("IN WITNESS WHEREOF")) return issues; // missing_required_section already flags this

  issues.push({
    type: "signatory_block_page_break_needs_manual_check",
    text: "IN WITNESS WHEREOF",
    message:
      'Please manually confirm: the signatory block starts with a page break right at the "DLSU-OFFICE-SHORT ORGANIZATION NAME" line, and all signatories (both parties, through the "Witnessed by" names) fit on that one page. This isn\'t verified automatically yet — the checker can\'t read page-break placement or table layout from this document.',
  });

  return issues;
}
