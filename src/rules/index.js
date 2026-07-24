import { runSharedChecks, checkLeadTime } from "./shared.js";
import { checkInternal } from "./internal.js";
import { checkSponsorship } from "./sponsorship.js";
import { checkPartnership } from "./partnership.js";
import { getRulesConfig } from "../rulesSheet.js";
import {
  runAllSheetDrivenRules,
  getCanonicalTextFromSheet,
  getSignatoryTiersFromSheet,
} from "./sheetDriven.js";

const TYPE_CHECKERS = {
  internal: checkInternal,
  sponsorship: checkSponsorship,
  partnership: checkPartnership,
};

/**
 * Runs every check for a document: the hardcoded rule engine (this
 * codebase) plus whatever's been added in the Mo Rules Google Sheet
 * (required/forbidden/either-or phrases, canonical footer/GTC text,
 * signatory tier overrides). The sheet fetch is cached for a couple of
 * minutes (see rulesSheet.js) so this doesn't hit Sheets on every single
 * check. If the sheet isn't configured, every sheet-sourced value is
 * empty/null and behavior is identical to before — sheet rules are
 * purely additive.
 */
export async function runAllChecks(fullText, moaType, docContext = {}) {
  const typeChecker = TYPE_CHECKERS[moaType];
  if (!typeChecker) {
    throw new Error(`Unknown MOA type: ${moaType}`);
  }

  const { runs, images, pageBreaks, footers, pageSize, headerText, codedSelection, pdfMode } = docContext;
  const rulesConfig = await getRulesConfig();

  const footerCanonicalOverride = getCanonicalTextFromSheet(rulesConfig, moaType, "Footer");
  const gtcCanonicalOverride = getCanonicalTextFromSheet(rulesConfig, moaType, "GTC");
  const signatoryTiersOverride = getSignatoryTiersFromSheet(rulesConfig, moaType);

  const issues = [
    ...runSharedChecks(fullText, {
      // In PDF mode, runs/images/footers/pageSize are all undefined —
      // runSharedChecks' own checks already guard on these being present
      // (see checkPayeeClause's `if (runs)`, checkFooter's
      // `if (!footers || footers.length === 0)` special-case, etc.) —
      // EXCEPT checkFooter and checkOnePageSignatoryBlock, which need an
      // explicit pdfMode skip below since they otherwise treat "absent"
      // as "definitely missing/unknown" and would always misfire in PDF
      // mode. See Feature 3 in MO_NEXT_STEPS.md.
      runs,
      images,
      footers,
      pageSize,
      moaType,
      footerCanonicalOverride,
      pdfMode,
    }),
    ...typeChecker(fullText, {
      gtcCanonicalOverride,
      signatoryTiersOverride,
      // headerText is undefined in PDF mode -> checkTopRightCode already
      // falls back to fullText when headerText is undefined, which would
      // misfire in PDF mode since D-A-1a may appear ANYWHERE in flattened
      // PDF text. Suppress it explicitly via pdfMode instead.
      headerText: pdfMode ? undefined : headerText,
      codedSelection,
      pdfMode,
      // runs/pageBreaks are undefined in PDF mode (no structural position
      // data) — checkInternal's page-break check already guards on that.
      runs,
      pageBreaks,
    }),
    ...runAllSheetDrivenRules(fullText, moaType, rulesConfig),
  ];
  const leadTime = checkLeadTime(fullText, moaType);

  return { issues, leadTime };
}
