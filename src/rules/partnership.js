// Partnership MOA checks — Mo_Rule_Checklist_Spec.md section 3
// Reuses Sponsorship's shared checks (address completeness, stipulation
// punctuation) since Partnership inherits the same External MOA structure.

import { checkSponsorship } from "./sponsorship.js";

const NON_MONETARY_PHRASE = "does not involve monetary value";
const MONETARY_PURCHASE_PHRASE = "monetary value but is a purchase in nature";

export function checkPartnership(fullText) {
  const issues = checkSponsorship(fullText).filter(
    (i) => i.type !== "missing_sponsorship_tier" // sponsorship-only concept; partnership branch logic replaces it
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

  return issues;
}

function detectUndertakingBranch(fullText) {
  const hasNonMonetary = fullText.includes(NON_MONETARY_PHRASE);
  const hasMonetaryPurchase = fullText.includes(MONETARY_PURCHASE_PHRASE);

  if (hasNonMonetary && !hasMonetaryPurchase) return "non_monetary";
  if (hasMonetaryPurchase && !hasNonMonetary) return "monetary_purchase";
  return "unclear";
}
