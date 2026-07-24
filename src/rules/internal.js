// Internal MOA checks — Mo_Rule_Checklist_Spec.md section 1

export function checkInternal(fullText) {
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

