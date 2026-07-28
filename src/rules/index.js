import { runSharedChecks, checkLeadTime, checkSubtitleMatchesSelectedType } from "./shared.js";
import { checkInternal } from "./internal.js";
import { checkSponsorship } from "./sponsorship.js";
import { checkPartnership } from "./partnership.js";
import { checkConstantSignatoryPlacement } from "./signatoryPlacement.js";
import { getRulesConfig } from "../rulesSheet.js";
import {
  runAllSheetDrivenRules,
  getCanonicalTextFromSheet,
  getSignatoryTiersFromSheet,
  getConstantSignatoriesFromSheet,
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

  // Internal / "[CSO ORG/MAIN]–[NON CSO ORG], CSO not inviting" branch (per
  // Mo_Handoff_Notes.md open question 2, answered): when CSO ORG/MAIN was
  // the one INVITED rather than the one inviting, the standard MOA format
  // doesn't apply at all, so nothing else here is meaningful to check —
  // not even the subtitle-matches-type gate below. The ONLY thing that
  // still matters is that MR. JAMES B. LAXA (Director for SLIFE) and MS.
  // JOHANNE LEI S. FAILANA (CSO EVCE) both appear under "Witnessed by:".
  // Reuses checkConstantSignatoryPlacement's existing internal/csoIsParty
  // logic — passing csoIsParty=false already yields exactly that pair of
  // expected placements (same shape as the ORG-ORG case), so no new
  // placement rule was needed. Zero issues here reads as "Mo says a-ok"
  // through the normal empty-issues rendering, matching the spec.
  if (moaType === "internal" && docContext.witnessedByOnlyMode) {
    const { runs } = docContext;
    const rulesConfig = await getRulesConfig();
    const constantSignatoriesOverride = getConstantSignatoriesFromSheet(rulesConfig);
    const issues = checkConstantSignatoryPlacement(fullText, runs, "internal", false, constantSignatoriesOverride);
    return {
      issues,
      leadTime: { leadTimeOk: null, leadTimeDays: null, requiredLeadTimeDays: null, note: null },
    };
  }

  // Gate: check the document's own "(re: ...)" subtitle against the
  // selected type FIRST, before anything else. Every other check below
  // assumes the selected type is actually correct — Internal-only
  // placeholders, Sponsorship's coded/non-coded top-right-code logic,
  // Partnership's undertaking-branch detection, even which required
  // sections/footer wording count as canonical — so running any of that
  // against a mismatched type wouldn't just be redundant, it would
  // itself produce incorrect or misleading results layered on top of the
  // real problem. Surface ONLY the type mismatch when there is one, skip
  // every other check (including the Sheet fetch below and lead-time
  // parsing), and let the reviewer resolve that first — either by
  // re-running the check as the right type, or by fixing the subtitle
  // wording if the selected type was actually correct. Once resolved,
  // the next check proceeds to everything below as normal.
  const subtitleIssues = checkSubtitleMatchesSelectedType(fullText, moaType);
  if (subtitleIssues.length > 0) {
    return {
      issues: subtitleIssues,
      leadTime: { leadTimeOk: null, leadTimeDays: null, requiredLeadTimeDays: null, note: null },
    };
  }

  const { runs, images, pageBreaks, footers, pageSize, headerText, codedSelection, pdfMode, csoIsParty } = docContext;
  const rulesConfig = await getRulesConfig();

  const footerCanonicalOverride = getCanonicalTextFromSheet(rulesConfig, moaType, "Footer");
  const gtcCanonicalOverride = getCanonicalTextFromSheet(rulesConfig, moaType, "GTC");
  const signatoryTiersOverride = getSignatoryTiersFromSheet(rulesConfig, moaType);
  const constantSignatoriesOverride = getConstantSignatoriesFromSheet(rulesConfig);

  const issues = [
    ...runSharedChecks(fullText, {
      // In PDF mode, runs/images/footers/pageSize/pageBreaks are all
      // undefined — runSharedChecks' own checks already guard on these
      // being present (see checkPayeeClause's `if (runs)`, checkFooter's
      // `if (!footers || footers.length === 0)` special-case, etc.) —
      // EXCEPT checkFooter, checkOnePageSignatoryBlock, and
      // checkSignatoryBlockPageBreak, which need an explicit pdfMode skip
      // below since they otherwise treat "absent" as "definitely
      // missing/unknown" and would always misfire in PDF mode. See
      // Feature 3 in MO_NEXT_STEPS.md.
      runs,
      images,
      pageBreaks,
      footers,
      pageSize,
      moaType,
      footerCanonicalOverride,
      pdfMode,
      constantSignatoriesOverride,
      csoIsParty,
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
      // Needed for the Undertaking/Witnesseth clause bold+caps field
      // checks — undefined in PDF mode, same reasoning as everywhere else
      // runs-dependent checks are gated off for PDFs.
      runs: pdfMode ? undefined : runs,
    }),
    ...runAllSheetDrivenRules(fullText, moaType, rulesConfig),
  ];
  const leadTime = checkLeadTime(fullText, moaType);

  return { issues, leadTime };
}
