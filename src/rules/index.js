import { runSharedChecks, checkLeadTime } from "./shared.js";
import { checkInternal } from "./internal.js";
import { checkSponsorship } from "./sponsorship.js";
import { checkPartnership } from "./partnership.js";

const TYPE_CHECKERS = {
  internal: checkInternal,
  sponsorship: checkSponsorship,
  partnership: checkPartnership,
};

export function runAllChecks(fullText, moaType) {
  const typeChecker = TYPE_CHECKERS[moaType];
  if (!typeChecker) {
    throw new Error(`Unknown MOA type: ${moaType}`);
  }

  const issues = [...runSharedChecks(fullText), ...typeChecker(fullText)];
  const leadTime = checkLeadTime(fullText, moaType);

  return { issues, leadTime };
}
