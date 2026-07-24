// Partnership MOA checks — Mo_Rule_Checklist_Spec.md section 3
// Reuses Sponsorship's shared checks (address completeness, stipulation
// punctuation) since Partnership inherits the same External MOA structure.

import { checkSponsorship } from "./sponsorship.js";

const NON_MONETARY_PHRASE = "does not involve monetary value";
const MONETARY_PURCHASE_PHRASE = "monetary value but is a purchase in nature";

export function checkPartnership(fullText, options = {}) {
  const { headerText } = options;
  const issues = checkSponsorship(fullText, options).filter(
    (i) =>
      ![
        "missing_sponsorship_tier", // sponsorship-only concept; branch logic below replaces it
        "wrong_undertaking_wording", // sponsorship says "sponsor", partnership says "partner" — checked separately below
        "missing_signatory_for_tier", // signatory tiers are a sponsorship-specific rule per moa.md, not defined for partnerships
        "top_right_code_needs_manual_check", // Partnership uses its own absence-only check below, not the Sponsorship diff logic
        "top_right_code_should_add",
        "top_right_code_should_remove",
        "coded_selection_mismatch", // coded/non-coded is a Sponsorship-only concept
        "gtc_section_not_found",
      ].includes(i.type)
  );

  const branch = detectUndertakingBranch(fullText);

  if (branch === "unclear") {
    issues.push({
      type: "unclear_undertaking_branch",
      text: "UNDERTAKING",
      message:
        'Undertaking clause does not clearly state whether this is a non-monetary obligation or a monetary/purchase-type partnership. Please specify one.',
    });
  } else if (branch === "non_monetary" && /PHP\s?[\d,]+/.test(fullText)) {
    issues.push({
      type: "monetary_value_in_non_monetary_branch",
      text: "PHP amount found",
      message:
        "This Undertaking is marked as non-monetary, but a cash amount appears in the document. Please confirm this is intentional.",
    });
  } else if (branch === "monetary_purchase" && !/PHP\s?[\d,]+/.test(fullText)) {
    issues.push({
      type: "missing_value_in_monetary_branch",
      text: "UNDERTAKING",
      message:
        "This Undertaking is marked as monetary/purchase-type, but no specific value/amount was found. Please state the amount or product value.",
    });
  }

  // Undertaking wording: partnerships must say "commits to be a partner"
  if (fullText.includes("UNDERTAKING") && !/commits to be a partner/i.test(fullText)) {
    issues.push({
      type: "wrong_undertaking_wording",
      text: "UNDERTAKING",
      message: 'Partnership MOAs must use the phrase "commits to be a partner" in the Undertaking clause.',
    });
  }

  // Non-monetary partnerships must define media mileage the org will provide in return
  if (branch === "non_monetary" && !/media mileage/i.test(fullText)) {
    issues.push({
      type: "missing_media_mileage",
      text: "UNDERTAKING",
      message:
        "Non-monetary partnerships must specify the media mileage the organization will provide in return for the partner's contribution.",
    });
  }

  // Partnerships do NOT use the top-right tracking code (D-A-1a) that
  // Sponsorship/Internal MOAs use. The code lives in the document HEADER,
  // not the body, so check headerText (falling back to fullText only if
  // no header was supplied).
  if (/D-A-1a/i.test(headerText ?? fullText)) {
    issues.push({
      type: "unexpected_top_right_code",
      text: "D-A-1a",
      message: "Partnership MOAs should not include the top-right tracking code — that applies to Sponsorship/Internal MOAs only.",
    });
  }

  return issues;
}

function detectUndertakingBranch(fullText) {
  const hasNonMonetary = fullText.includes(NON_MONETARY_PHRASE);
  const hasMonetaryPurchase = fullText.includes(MONETARY_PURCHASE_PHRASE);

  if (hasNonMonetary && !hasMonetaryPurchase) return "non_monetary";
  if (hasMonetaryPurchase && !hasNonMonetary) return "monetary_purchase";
  if (hasNonMonetary && hasMonetaryPurchase) return "unclear"; // both present — genuinely ambiguous

  // Neither canonical phrase is present verbatim. Real MOAs don't always
  // keep that exact wording, so don't force a false "unclear" flag just
  // because it was reworded or dropped — a document with no "PHP" amount
  // anywhere is reliably non-monetary on its own. Only fall back to
  // "unclear" if a PHP amount actually appears without matching either
  // canonical phrase.
  return /PHP\s?[\d,]+/.test(fullText) ? "unclear" : "non_monetary";
}
