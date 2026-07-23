// Turns rows from the Mo Rules Google Sheet into the same { type, text,
// message } issue shape the rest of the rule engine uses. Four simple,
// no-code rule "templates" cover most additions someone would want to
// make without touching code — see CANONICAL_SHEET_SETUP.md for the
// exact column layout each of these expects.
//
// Column lookups here use lowercase, single-spaced keys (e.g. "moa type",
// "phrase") because rulesSheet.js normalizes every header this way when
// reading the sheet — so "Moa Type", "MOA TYPE", and "  moa   type  " in
// the actual spreadsheet header row all work identically.

function isActive(row) {
  // Blank "Active" column defaults to active (Y) — a new row someone adds
  // without filling every column should still take effect.
  const v = (row["active"] || "").trim().toUpperCase();
  return v !== "N" && v !== "NO" && v !== "FALSE";
}

function appliesToMoaType(row, moaType) {
  const v = (row["moa type"] || "").trim().toLowerCase();
  return v === "" || v === "all" || v === moaType;
}

export function runRequiredPhraseRules(fullText, moaType, rows) {
  const issues = [];
  for (const row of rows) {
    if (!isActive(row) || !appliesToMoaType(row, moaType)) continue;
    const phrase = row["phrase"];
    if (!phrase) continue;

    if (!fullText.toLowerCase().includes(phrase.toLowerCase())) {
      issues.push({
        type: "sheet_required_phrase_missing",
        text: phrase,
        message: row["message"] || `Required phrase "${phrase}" was not found.`,
      });
    }
  }
  return issues;
}

export function runForbiddenPhraseRules(fullText, moaType, rows) {
  const issues = [];
  for (const row of rows) {
    if (!isActive(row) || !appliesToMoaType(row, moaType)) continue;
    const phrase = row["phrase"];
    if (!phrase) continue;

    if (fullText.toLowerCase().includes(phrase.toLowerCase())) {
      issues.push({
        type: "sheet_forbidden_phrase_present",
        text: phrase,
        message: row["message"] || `Phrase "${phrase}" should not be present.`,
      });
    }
  }
  return issues;
}

export function runEitherOrRules(fullText, moaType, rows) {
  const issues = [];
  for (const row of rows) {
    if (!isActive(row) || !appliesToMoaType(row, moaType)) continue;
    const a = row["phrase a"];
    const b = row["phrase b"];
    if (!a || !b) continue;

    const hasA = fullText.toLowerCase().includes(a.toLowerCase());
    const hasB = fullText.toLowerCase().includes(b.toLowerCase());

    if (hasA && hasB) {
      issues.push({
        type: "sheet_either_or_both_present",
        text: a,
        message: row["message"] || `Both "${a}" and "${b}" are present — keep only the one that applies and delete the other.`,
      });
    } else if (!hasA && !hasB) {
      issues.push({
        type: "sheet_either_or_neither_present",
        text: a,
        message: row["message"] || `Neither "${a}" nor "${b}" is present — exactly one is required.`,
      });
    }
  }
  return issues;
}

export function runAllSheetDrivenRules(fullText, moaType, rulesConfig) {
  if (!rulesConfig) return [];
  return [
    ...runRequiredPhraseRules(fullText, moaType, rulesConfig.requiredPhrases || []),
    ...runForbiddenPhraseRules(fullText, moaType, rulesConfig.forbiddenPhrases || []),
    ...runEitherOrRules(fullText, moaType, rulesConfig.eitherOrPhrases || []),
  ];
}

/**
 * Looks up a canonical-text row (Footer or GTC) for a given MOA type from
 * the "Canonical Text" tab. Returns the text, or null if not set —
 * callers fall back to their own hardcoded default when null.
 */
export function getCanonicalTextFromSheet(rulesConfig, moaType, checkName) {
  const rows = rulesConfig?.canonicalText || [];
  const row = rows.find(
    (r) =>
      isActive(r) &&
      (r["moa type"] || "").trim().toLowerCase() === moaType &&
      (r["check"] || "").trim().toLowerCase() === checkName.toLowerCase()
  );
  return row?.["text"] || null;
}

/**
 * Parses the "Signatory Tiers" tab into the same shape signatoryTiers.js
 * uses internally: [{ max, required: [names], label }, ...] sorted
 * ascending by max. Returns [] if the tab has no rows for this MOA type
 * (caller falls back to its hardcoded defaults).
 */
export function getSignatoryTiersFromSheet(rulesConfig, moaType) {
  const rows = (rulesConfig?.signatoryTiers || []).filter(
    (r) => isActive(r) && (r["moa type"] || "").trim().toLowerCase() === moaType
  );
  if (rows.length === 0) return [];

  const tiers = rows.map((r) => {
    const maxRaw = (r["max amount"] || "").trim();
    const max = maxRaw === "" || maxRaw.toLowerCase() === "no limit" ? Infinity : Number(maxRaw.replace(/,/g, ""));
    const required = (r["required names"] || "")
      .split(",")
      .map((n) => n.trim())
      .filter(Boolean);
    return { max: isNaN(max) ? Infinity : max, required, label: r["label"] || maxRaw };
  });

  tiers.sort((a, b) => a.max - b.max);
  return tiers;
}
