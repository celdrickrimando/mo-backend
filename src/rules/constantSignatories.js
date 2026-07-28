// Constant-signatory formatting checks — people whose name and title are
// fixed DLSU-office roles (not something an org fills in), so they should
// read identically across every MOA: name in ALL CAPS + bold, position
// italicized. Distinct from signatoryTiers.js, which is about WHICH names
// are required at a given sponsorship amount — this is about HOW a name
// that's already present should be formatted, regardless of amount.
//
// Data source: the "Constant Signatories" tab on the Mo Rules sheet if
// configured (see CANONICAL_SHEET_SETUP.md), falling back to the
// hardcoded defaults below — same override pattern as signatoryTiers.js.
// Editing/adding a person only ever means adding a row to that sheet tab,
// no code change needed.

import { isRangeBold, isRangeItalic } from "../googleDocs.js";
// Pulled from textPosition.js, a dependency-free module that imports from
// neither shared.js nor this file — breaks the circular-import concern
// that previously forced these to be duplicated locally (shared.js
// imports FROM this file, so this file couldn't import back from
// shared.js). See Mo_Handoff_Notes.md section D.
import { flatIndexToAbsolute, locationFor, HONORIFICS, stripHonorific } from "./textPosition.js";

// Re-exported so existing importers (shared.js, signatoryPlacement.js)
// keep working unchanged — the real implementation now lives in
// textPosition.js alongside HONORIFICS.
export { stripHonorific };

export const DEFAULT_CONSTANT_SIGNATORIES = [
  {
    name: "DR. JAYMEE ABIGAIL K. PANTALEON-RAMOS",
    positionFirstPage: "Dean of Student Affairs",
    positionSignatory: "Dean, Office of Student Affairs",
  },
  {
    name: "MR. JAMES B. LAXA",
    positionFirstPage: "Director for SLIFE",
    positionSignatory: "Director, Office of Student LIFE",
  },
  {
    name: "MS. ANDREIA CELINE VALDERRAMA",
    positionFirstPage: null,
    positionSignatory: "Chairperson, DLSU-SLIFE-CSO",
  },
  {
    name: "MS. JOHANNE LEI S. FAILANA",
    positionFirstPage: null,
    positionSignatory: "Executive Vice Chairperson for Externals, DLSU-SLIFE-CSO",
  },
];

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Finds every case-insensitive occurrence of `needle` in `haystack`,
// returning both its position and its ACTUAL on-page casing (not the
// canonical needle) — the actual casing is what tells us whether it's
// really in ALL CAPS or not.
function findAllCaseInsensitive(haystack, needle) {
  if (!needle) return [];
  const re = new RegExp(escapeRegex(needle), "gi");
  const matches = [];
  let m;
  while ((m = re.exec(haystack)) !== null) {
    matches.push({ index: m.index, text: m[0] });
    if (m.index === re.lastIndex) re.lastIndex++; // guard against zero-length matches looping forever
  }
  return matches;
}

// How far to look around a name for its expected position phrase. Wide
// enough to cross a "By:" line or a short intervening clause, narrow
// enough not to accidentally match a different person's position nearby.
const WINDOW = 220;

/**
 * Looks immediately before `index` in fullText for one of HONORIFICS,
 * returning the matched honorific (e.g. "MR.") or null. Only counts an
 * exact honorific token right up against the name (ignoring surrounding
 * whitespace) — not just "some text that happens to contain a period".
 */
function honorificImmediatelyBefore(fullText, index) {
  const before = fullText.slice(Math.max(0, index - 6), index).trim().toUpperCase();
  return HONORIFICS.find((h) => before.endsWith(h)) || null;
}

/**
 * Checks every configured constant signatory who actually appears
 * anywhere in this document (most won't appear in every MOA type — e.g.
 * the CSO officers only sign some) for:
 *   1. A present, correct honorific at EACH occurrence of their bare
 *      name — checked per-occurrence (not just "does the honorific'd
 *      name appear anywhere in the document"), because a person is
 *      frequently named correctly once (e.g. the page-1 "represented by
 *      its ..." clause) and then again, incorrectly, in the actual
 *      signatory block — a single document-wide search for the full
 *      honorific'd name would find the first correct mention and never
 *      even look at the second, malformed one. Searching for the bare
 *      name and checking the honorific locally at every hit is the only
 *      way to catch that.
 *   2. ALL CAPS name (an occurrence found only case-insensitively means
 *      it's present but wrongly cased)
 *   3. Bold name, checked at the EXACT position found (not by
 *      re-searching the name text, which could land on a different
 *      occurrence of the same name elsewhere with different formatting —
 *      e.g. the same person's name in the first-page clause AND the
 *      signatory block).
 *   4. A nearby, correctly-italicized position — checked BEFORE the name
 *      (first-page style: "Position, NAME") and AFTER the name
 *      (signatory-block style: "NAME" on one line, position below/after)
 * If neither expected position phrase can be confidently matched nearby,
 * this flags it for manual review rather than guessing — real documents
 * occasionally vary title wording enough that a strict match would
 * false-positive (same reasoning as the removed Internal "President (or
 * equivalent)" check in internal.js).
 */
export function checkConstantSignatoryFormatting(fullText, runs, constantSignatoriesOverride) {
  const issues = [];
  const people =
    constantSignatoriesOverride && constantSignatoriesOverride.length > 0
      ? constantSignatoriesOverride
      : DEFAULT_CONSTANT_SIGNATORIES;

  for (const person of people) {
    if (!person.name) continue;

    const coreName = stripHonorific(person.name);
    const expectedHonorificMatch = person.name.match(/^([A-Z]+\.)\s/);
    const expectedHonorific = expectedHonorificMatch ? expectedHonorificMatch[1] : null;

    // If the configured name doesn't start with a recognized honorific,
    // there's no separate per-occurrence honorific concept to check —
    // fall back to searching for the name as configured, exactly as
    // before.
    const bareOccurrences = coreName ? findAllCaseInsensitive(fullText, coreName) : findAllCaseInsensitive(fullText, person.name);
    if (bareOccurrences.length === 0) continue; // person isn't in this document at all

    for (const bareOcc of bareOccurrences) {
      let occIndex = bareOcc.index;
      let occText = bareOcc.text;

      if (coreName && expectedHonorific) {
        const foundHonorific = honorificImmediatelyBefore(fullText, occIndex);
        if (foundHonorific !== expectedHonorific) {
          issues.push({
            type: "constant_signatory_missing_honorific",
            text: foundHonorific ? `${foundHonorific} ${occText}` : occText,
            message: foundHonorific
              ? `"${foundHonorific} ${occText}" has an incorrect honorific — should read "${person.name}".`
              : `"${occText}" is missing its honorific — should read "${person.name}".`,
            // Anchored to THIS specific occurrence's bare-name span, not
            // re-derived from text search later. Without this, index.js's
            // write-back step falls back to findRangeAnywhere(issue.text),
            // which does a first-match search — when the same person's
            // honorific is missing in more than one place in the document,
            // every one of those separately-detected issues would
            // otherwise collapse onto the SAME first occurrence (piling up
            // duplicate comments there) while every other real occurrence
            // gets no highlight/comment at all, despite being correctly
            // detected here.
            location: runs ? locationFor(runs, bareOcc.index, bareOcc.index + bareOcc.text.length) : undefined,
          });
          continue; // can't reliably check caps/bold/italic on a mis-honorificed occurrence
        }
        // Correct honorific found — widen the occurrence to include it so
        // the caps/bold checks below evaluate "MR. JAMES B. LAXA" as a
        // whole, matching how it's actually meant to read on the page.
        occIndex = occIndex - (expectedHonorific.length + 1);
        occText = fullText.slice(occIndex, bareOcc.index + bareOcc.text.length);
      }

      const occ = { index: occIndex, text: occText };

      if (occ.text !== person.name) {
        issues.push({
          type: "constant_signatory_name_not_allcaps",
          text: occ.text,
          message: `"${occ.text}" should be written in ALL CAPS, as "${person.name}".`,
          location: runs ? locationFor(runs, occ.index, occ.index + occ.text.length) : undefined,
        });
        continue; // formatting checks below would just pile onto a name that's already wrong
      }

      if (runs) {
        const nameEnd = occ.index + occ.text.length;
        if (isRangeBold(runs, occ.index, nameEnd) === false) {
          issues.push({
            type: "constant_signatory_name_not_bold",
            text: occ.text,
            message: `"${occ.text}" must be bold.`,
            location: locationFor(runs, occ.index, nameEnd),
          });
        }

        const before = fullText.slice(Math.max(0, occ.index - WINDOW), occ.index);
        const after = fullText.slice(nameEnd, nameEnd + WINDOW);

        const firstPageHitOffset = person.positionFirstPage ? before.indexOf(person.positionFirstPage) : -1;
        const signatoryHitOffset = person.positionSignatory ? after.indexOf(person.positionSignatory) : -1;

        if (firstPageHitOffset !== -1) {
          const posStart = Math.max(0, occ.index - WINDOW) + firstPageHitOffset;
          const posEnd = posStart + person.positionFirstPage.length;
          if (isRangeItalic(runs, posStart, posEnd) === false) {
            issues.push({
              type: "constant_signatory_position_not_italic",
              text: person.positionFirstPage,
              message: `"${person.positionFirstPage}" (next to ${person.name}) must be italicized.`,
              location: locationFor(runs, posStart, posEnd),
            });
          }
        } else if (signatoryHitOffset !== -1) {
          const posStart = nameEnd + signatoryHitOffset;
          const posEnd = posStart + person.positionSignatory.length;
          if (isRangeItalic(runs, posStart, posEnd) === false) {
            issues.push({
              type: "constant_signatory_position_not_italic",
              text: person.positionSignatory,
              message: `"${person.positionSignatory}" (under ${person.name}) must be italicized.`,
              location: locationFor(runs, posStart, posEnd),
            });
          }
        } else if (person.positionFirstPage || person.positionSignatory) {
          issues.push({
            type: "constant_signatory_position_needs_manual_check",
            text: person.name,
            message: `Found "${person.name}" but couldn't confidently match the expected position text nearby (expected "${
              person.positionFirstPage || person.positionSignatory
            }") — please verify the title is correct and italicized.`,
            location: locationFor(runs, occ.index, nameEnd),
          });
        }
      }
    }
  }

  return issues;
}
