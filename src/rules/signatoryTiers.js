// Signatory tier rules — per moa.md. The set of required signatory names
// scales with the sponsorship's monetary amount. All amounts are in PHP.
//
// NOTE on "all names must have honorifics" (spec item 3): general
// name-honorific detection across the whole document needs either a
// name-detection model or an LLM call — regex can't reliably tell a
// person's name apart from a company/org name. Per the spec's
// recommendation, this is intentionally scoped down to just the known
// signatory names below (already hardcoded with honorifics), rather than
// scanning the whole doc. Revisit only if the user gives examples of
// other names needing this check.

const SIGNATORY_TIERS = [
  {
    max: 100000,
    required: ["DR. JAYMEE ABIGAIL K. PANTALEON-RAMOS", "MR. JAMES B. LAXA"],
    label: "≤ PHP 100,000",
  },
  {
    max: 500000,
    required: [
      "MS. FRITZIE IAN P. DE VERA",
      "DR. JAYMEE ABIGAIL K. PANTALEON-RAMOS",
      "MR. JAMES B. LAXA",
    ],
    label: "PHP 100,001–500,000",
  },
  {
    max: 1000000,
    required: [
      "DR. ROBERT C. ROLEDA",
      "MS. FRITZIE IAN P. DE VERA",
      "DR. JAYMEE ABIGAIL K. PANTALEON-RAMOS",
      "MR. JAMES B. LAXA",
    ],
    label: "PHP 500,001–1,000,000",
  },
  {
    max: Infinity,
    required: [
      "BR. BERNARD S. OCA, FSC",
      "DR. ROBERT C. ROLEDA",
      "MS. FRITZIE IAN P. DE VERA",
      "DR. JAYMEE ABIGAIL K. PANTALEON-RAMOS",
      "MR. JAMES B. LAXA",
    ],
    label: "> PHP 1,000,000",
  },
];

/**
 * Extracts the first PHP amount found in the Undertaking clause and
 * returns the matching tier definition. `tiersOverride`, if given (from
 * the "Signatory Tiers" sheet tab), takes priority over the hardcoded
 * defaults above — lets tier amounts/names be edited without a code
 * deploy.
 */
export function getSignatoryTierForAmount(fullText, tiersOverride) {
  const tiers = tiersOverride && tiersOverride.length > 0 ? tiersOverride : SIGNATORY_TIERS;
  const undertakingIdx = fullText.indexOf("UNDERTAKING");
  const window = undertakingIdx !== -1 ? fullText.slice(undertakingIdx, undertakingIdx + 800) : fullText;

  const match = window.match(/PHP\s?([\d,]+)/);
  if (!match) return null;

  const amount = parseInt(match[1].replace(/,/g, ""), 10);
  if (isNaN(amount)) return null;

  const tier = tiers.find((t) => amount <= t.max);
  return { amount, tier };
}

export function checkSignatoryTier(fullText, tiersOverride) {
  const issues = [];
  const result = getSignatoryTierForAmount(fullText, tiersOverride);

  if (!result) return issues; // no monetary value found — separate check already flags this

  const { amount, tier } = result;
  const missing = tier.required.filter((name) => !fullText.includes(name));

  if (missing.length > 0) {
    issues.push({
      type: "missing_signatory_for_tier",
      text: "UNDERTAKING",
      message: `This sponsorship amount (PHP ${amount.toLocaleString()}, tier: ${tier.label}) requires the following signatory name(s), which appear to be missing: ${missing.join(
        ", "
      )}.`,
    });
  }

  return issues;
}
