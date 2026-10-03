// Partnership MOA checks — Mo_Rule_Checklist_Spec.md section 3
// Reuses Sponsorship's shared checks (address completeness, stipulation
// punctuation) since Partnership inherits the same External MOA structure.

import { checkSponsorship } from "./sponsorship.js";
import { checkPhpPositionRelativeToInReturnClause } from "./shared.js";

// "D-B-4a" with any hyphen/dash variant (Docs autocorrect can swap in en/non-breaking dashes)
const D_B_4A_RE = /D[-\u2010-\u2015\u2212]B[-\u2010-\u2015\u2212]4a/i;

const NON_MONETARY_PHRASE = "does not involve monetary value";

// MONETARY_PURCHASE_PHRASE marks the one legitimate carve-out where a
// Partnership MOA is allowed to contain a PHP/monetary amount: DLSU itself
// is acquiring/purchasing a service or item FROM the partner org (e.g. DLSU
// reserving and paying the partner for a venue). It is NOT a generic
// "any purchase-flavored undertaking" branch — it specifically represents
// DLSU-as-buyer. Confirmed with user; see Mo_Handoff_Notes.md section B.
const MONETARY_PURCHASE_PHRASE = "monetary value but is a purchase in nature";

export function checkPartnership(fullText, options = {}) {
  const { headerText, pdfMode } = options;
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
        "php_indication_wrong_position", // sponsorship checked this ABOVE the In Return clause; partnership needs the opposite direction, re-checked below
      ].includes(i.type)
  );

  // PHP/monetary amount must appear UNDER (after) the "In return,
  // DLSU-SLIFE-CSO (...) shall:" clause for Partnership — the opposite of
  // Sponsorship's rule. See new_additions_v3.md.
  issues.push(...checkPhpPositionRelativeToInReturnClause(fullText, "under"));

  const branch = detectUndertakingBranch(fullText);

  if (branch === "unclear") {
    issues.push({
      type: "unclear_undertaking_branch",
      text: "UNDERTAKING",
      message:
        'Undertaking clause does not clearly state whether this is a non-monetary obligation or a monetary/purchase-type partnership. Please specify one.',
    });
  } else if (branch === "non_monetary" && /PHP\s?[\d,]+/.test(fullText)) {
    // Partnership MOAs should only carry a monetary value in the
    // DLSU-is-purchasing-from-the-partner carve-out (the "monetary_purchase"
    // branch below). A PHP amount showing up under the non-monetary branch
    // is a real rule violation in virtually all cases, not just a
    // double-check item — worded firmly, with the fix path spelled out.
    issues.push({
      type: "monetary_value_in_non_monetary_branch",
      text: "PHP amount found",
      message:
        "This Undertaking is marked non-monetary, but a PHP amount was found. Partnership MOAs should only include a monetary value when DLSU itself is acquiring a service/item from the partner (e.g. venue reservation) — if that's the case here, this should be marked as the monetary/purchase branch instead. Otherwise, remove the amount.",
    });
  } else if (branch === "monetary_purchase" && !/PHP\s?[\d,]+/.test(fullText)) {
    // "monetary_purchase" = DLSU acquiring/purchasing a service or item FROM
    // the partner org; a PHP value is required to substantiate that.
    issues.push({
      type: "missing_value_in_monetary_branch",
      text: "UNDERTAKING",
      message:
        "This Undertaking is marked as monetary/purchase-type (DLSU acquiring a service/item from the partner), but no specific value/amount was found. Please state the amount or product value.",
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

  // Top-right tracking code (document HEADER, not body):
  //   - Non-monetary partnership (no payment / no monetary value) MUST carry
  //     "D-B-4a".
  //   - Monetary/purchase partnership must NOT carry it.
  //   - The Sponsorship/Internal code "D-A-1a" never belongs on a Partnership.
  // Skipped in PDF mode: flattened PDF text has no reliable header/body
  // separation, so a "missing" verdict there would be a guess (same reason
  // checkTopRightCode skips PDFs for Sponsorship).
  if (!pdfMode) {
    const header = headerText ?? "";
    // Tolerate non-ASCII hyphens/dashes that Docs autocorrect can produce.
    const hasDb4a = D_B_4A_RE.test(header);

    if (/D-A-1a/i.test(header)) {
      issues.push({
        type: "unexpected_top_right_code",
        text: "D-A-1a",
        message: "Partnership MOAs should not use the Sponsorship/Internal top-right code (D-A-1a).",
      });
    }

    if (branch === "non_monetary" && !hasDb4a) {
      issues.push({
        type: "missing_top_right_code",
        text: "UNDERTAKING",
        message:
          'This Partnership has no payment/monetary value, so the top-right header must carry the code "D-B-4a". It is missing — please add it.',
      });
    } else if (branch === "monetary_purchase" && hasDb4a) {
      issues.push({
        type: "unexpected_top_right_code",
        text: "D-B-4a",
        message:
          'This Partnership involves payment (DLSU purchasing from the partner), so it must NOT carry the "D-B-4a" top-right code. Please remove it.',
      });
    }
    // branch === "unclear": can't tell which rule applies; unclear_undertaking_branch above already asks the reviewer to fix that first.
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
