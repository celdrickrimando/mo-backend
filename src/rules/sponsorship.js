// Sponsorship MOA checks — Mo_Rule_Checklist_Spec.md section 2

export function checkSponsorship(fullText) {
  const issues = [];

  // Sponsorship tier / value must be present in the UNDERTAKING clause
  const undertakingIdx = fullText.indexOf("UNDERTAKING");
  if (undertakingIdx !== -1) {
    const window = fullText.slice(undertakingIdx, undertakingIdx + 500);
    if (!/PHP\s?[\d,]+/.test(window)) {
      issues.push({
        type: "missing_sponsorship_tier",
        text: "UNDERTAKING",
        message:
          "No monetary/product value found in the Undertaking clause. Sponsorship MOAs must state a clear tier (e.g., \"PHP 10,000 (Bronze Sponsor)\").",
      });
    }
  }

  // Address completeness — flag if only city/country given
  const addressMatch = fullText.match(/postal address at ([^,\n]+(?:,[^,\n]+){0,4})/i);
  if (addressMatch) {
    const address = addressMatch[1];
    const parts = address.split(",").map((p) => p.trim()).filter(Boolean);
    if (parts.length < 3) {
      issues.push({
        type: "incomplete_address",
        text: addressMatch[0],
        message:
          "Company address looks incomplete. A complete postal address (Number, Street, Barangay, City, Province) is required — city/country alone will result in a pended submission.",
      });
    }
  }

  // Stipulation punctuation — every "; and" list must terminate the final item with a period
  issues.push(...checkStipulationPunctuation(fullText));

  return issues;
}

function checkStipulationPunctuation(fullText) {
  const issues = [];
  // crude heuristic: find runs of lines ending in "; and" and confirm the
  // block terminates in a period, not another "; and"
  const lines = fullText.split("\n").map((l) => l.trim()).filter(Boolean);
  for (let i = 0; i < lines.length - 1; i++) {
    const line = lines[i];
    const next = lines[i + 1];
    if (line.endsWith("; and") && next.endsWith("; and") === false && !next.endsWith(".") && !next.endsWith(":")) {
      issues.push({
        type: "stipulation_punctuation",
        text: line,
        message:
          'Stipulation list may be malformed — each item before the last should end in "; and", and the final item should end in a period.',
      });
    }
  }
  return issues;
}
