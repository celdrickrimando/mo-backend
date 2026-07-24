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

  return issues;
}
