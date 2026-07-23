// Sponsorship MOA checks — Mo_Rule_Checklist_Spec.md section 2

import { checkSignatoryTier } from "./signatoryTiers.js";
import { checkFonEitherOr, checkTopRightCode } from "./shared.js";

export function checkSponsorship(fullText, { gtcCanonicalOverride, signatoryTiersOverride } = {}) {
  const issues = [];

  // Top-right tracking code (D-A-1a) correctness for Sponsorship.
  issues.push(...checkTopRightCode(fullText, "sponsorship", gtcCanonicalOverride));

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

  // The specific closing report-submission clause must always be the last item
  if (!/Submit to the [A-Za-z\s]*a report of the activity within one week after the activity/i.test(fullText)) {
    issues.push({
      type: "missing_required_final_stipulation",
      text: "UNDERTAKING",
      message:
        'The stipulation "Submit to the [Short Company Name] a report of the activity within one week after the activity" must always be present as the final item in the list.',
    });
  }

  // Undertaking wording: sponsorships must say "commits to be a sponsor"
  if (fullText.includes("UNDERTAKING") && !/commits to be a sponsor/i.test(fullText)) {
    issues.push({
      type: "wrong_undertaking_wording",
      text: "UNDERTAKING",
      message: 'Sponsorship MOAs must use the phrase "commits to be a sponsor" in the Undertaking clause.',
    });
  }

  // Signatory names must match the required tier for the sponsorship amount
  issues.push(...checkSignatoryTier(fullText, signatoryTiersOverride));

  // Party-type clause: exactly one of "company registered..." / "recognized organization of..." must remain
  issues.push(...checkFonEitherOr(fullText));

  return issues;
}

// Stipulation punctuation — properly parses a lettered/numbered list block:
// every item except the last must end in "; and"; only the final item ends
// in a period. Previous version incorrectly flagged valid "; and" lines —
// fixed per user report.
function checkStipulationPunctuation(fullText) {
  const issues = [];
  const lines = fullText.split("\n").map((l) => l.trim()).filter(Boolean);

  // A list item line looks like "a. ..." / "1. ..." / "a) ..." etc.
  const listItemRe = /^[a-z0-9]{1,2}[.)]\s+/i;

  let i = 0;
  while (i < lines.length) {
    if (!listItemRe.test(lines[i])) {
      i++;
      continue;
    }
    // collect the contiguous run of list items
    const blockStart = i;
    while (i < lines.length && listItemRe.test(lines[i])) i++;
    const block = lines.slice(blockStart, i);

    if (block.length < 2) continue; // single-item "lists" aren't real lists

    const last = block[block.length - 1];
    const middle = block.slice(0, -1);

    // Every non-final item should end in "; and" (this is CORRECT, not an issue)
    const badMiddle = middle.filter((l) => !l.endsWith("; and") && !l.endsWith(";"));
    if (badMiddle.length > 0) {
      issues.push({
        type: "stipulation_punctuation",
        text: badMiddle[0],
        message: 'Each stipulation before the last should end in "; and".',
      });
    }

    // Only the final item needs to end in a period
    if (!last.endsWith(".")) {
      issues.push({
        type: "stipulation_final_punctuation",
        text: last,
        message: "The final stipulation in the list should end in a period, not \"; and\".",
      });
    }
  }

  return issues;
}
