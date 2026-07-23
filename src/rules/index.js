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

  const { runs, footers, pageSize, headerText, codedSelection } = docContext;
  const rulesConfig = await getRulesConfig();

  const footerCanonicalOverride = getCanonicalTextFromSheet(rulesConfig, moaType, "Footer");
  const gtcCanonicalOverride = getCanonicalTextFromSheet(rulesConfig, moaType, "GTC");
  const signatoryTiersOverride = getSignatoryTiersFromSheet(rulesConfig, moaType);

  const issues = [
    ...runSharedChecks(fullText, { runs, footers, pageSize, moaType, footerCanonicalOverride }),
    ...typeChecker(fullText, { gtcCanonicalOverride, signatoryTiersOverride, headerText, codedSelection }),
    ...runAllSheetDrivenRules(fullText, moaType, rulesConfig),
  ];
  const leadTime = checkLeadTime(fullText, moaType);

  return { issues, leadTime };
}
