// Reads the "Mo Rules" Google Sheet — the live, user-editable source of
// truth for rule data (required phrases, canonical text, signatory
// tiers, etc). This is separate from the OAuth flow used elsewhere in
// googleDocs.js: reading the rules sheet uses a SERVICE ACCOUNT (its own
// Google identity, set up once by the admin), not the end user's token,
// since the extension's users shouldn't need access to the rules sheet
// itself — only the person maintaining Mo does.
//
// Env vars required (set on Render):
//   GOOGLE_SERVICE_ACCOUNT_EMAIL   — from the service account JSON key
//   GOOGLE_SERVICE_ACCOUNT_KEY     — the private_key field from that JSON
//                                    (with literal \n escapes preserved)
//   MO_RULES_SHEET_ID              — the spreadsheet ID (from its URL)
//
// See CANONICAL_SHEET_SETUP.md for the full step-by-step setup guide.

import { google } from "googleapis";

const CACHE_TTL_MS = 15 * 1000; // 15 seconds — edit the sheet, wait a moment, done
let cache = { data: null, fetchedAt: 0 };

// Normalizes a header/key so column names in the sheet don't need to be
// byte-for-byte exact — "Moa Type", "MOA TYPE", " moa type " all match
// the same lookup key used in sheetDriven.js.
export function normalizeKey(str) {
  return (str || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function authorizedSheetsClient() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const key = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!email || !key) return null;

  const auth = new google.auth.JWT({
    email,
    key: key.replace(/\\n/g, "\n"), // Render env vars store \n as literal backslash-n
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });
  return google.sheets({ version: "v4", auth });
}

/**
 * Reads all rows from a tab as objects keyed by the header row (row 1).
 * Blank rows and rows where the first cell is empty are skipped. Returns
 * [] (not an error) if the tab doesn't exist or the sheet isn't
 * configured — callers should treat an empty array as "no extra rules
 * from the sheet," not a crash, so a missing/misconfigured sheet degrades
 * gracefully rather than taking Mo down.
 */
async function readTab(sheets, spreadsheetId, tabName) {
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${tabName}!A:Z`,
    });
    const rows = res.data.values || [];
    if (rows.length < 2) return [];

    const headers = rows[0].map((h) => normalizeKey(h));
    return rows
      .slice(1)
      .filter((row) => (row[0] || "").trim() !== "")
      .map((row) => {
        const obj = {};
        headers.forEach((h, i) => {
          obj[h] = (row[i] || "").trim();
        });
        return obj;
      });
  } catch (err) {
    console.error(`[rulesSheet] Failed to read tab "${tabName}":`, err.message);
    return [];
  }
}

/**
 * Fetches and caches all rule tabs from the Mo Rules sheet. Returns a
 * structured object; every field defaults to [] / {} if the sheet isn't
 * configured yet, so existing hardcoded checks keep working untouched
 * and sheet-sourced rules are purely additive.
 */
export async function getRulesConfig({ forceRefresh = false } = {}) {
  const now = Date.now();
  if (!forceRefresh && cache.data && now - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.data;
  }

  const spreadsheetId = process.env.MO_RULES_SHEET_ID;
  const sheets = authorizedSheetsClient();

  if (!spreadsheetId || !sheets) {
    // Not configured — degrade gracefully, don't throw.
    const empty = {
      requiredPhrases: [],
      forbiddenPhrases: [],
      eitherOrPhrases: [],
      canonicalText: [],
      signatoryTiers: [],
    };
    cache = { data: empty, fetchedAt: now };
    return empty;
  }

  const [requiredPhrases, forbiddenPhrases, eitherOrPhrases, canonicalText, signatoryTiers] = await Promise.all([
    readTab(sheets, spreadsheetId, "Required Phrases"),
    readTab(sheets, spreadsheetId, "Forbidden Phrases"),
    readTab(sheets, spreadsheetId, "Either-Or Phrases"),
    readTab(sheets, spreadsheetId, "Canonical Text"),
    readTab(sheets, spreadsheetId, "Signatory Tiers"),
  ]);

  const data = { requiredPhrases, forbiddenPhrases, eitherOrPhrases, canonicalText, signatoryTiers };
  cache = { data, fetchedAt: now };
  return data;
}

/** Manually clear the cache (e.g. from a /refresh-rules admin endpoint). */
export function clearRulesCache() {
  cache = { data: null, fetchedAt: 0 };
}
