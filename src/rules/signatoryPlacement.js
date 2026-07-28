// Constant-signatory SECTION placement — WHICH of the two signatory-block
// markers ("By:" vs "Witnessed by:") each fixed CSO officer (Johanne,
// James, Andreia) must appear under, AND whether they're present in the
// signatory block at all. Distinct from constantSignatories.js, which only
// checks that a name/position that's ALREADY present is formatted
// correctly (caps/bold/italic) — this checks that the person is in the
// document, in the right place, at all.
//
// Rules (per the user's spec):
//   Internal MOA, CSO-ORG (CSO is one of the two parties):
//     MS. JOHANNE LEI S. FAILANA -> "By:"            (CSO's own representative)
//     MR. JAMES B. LAXA          -> "Witnessed by:"
//   Internal MOA, ORG-ORG (MOA is between two other orgs; CSO only oversees):
//     MS. JOHANNE LEI S. FAILANA -> "Witnessed by:"
//     MR. JAMES B. LAXA          -> "Witnessed by:"
//   Sponsorship / Partnership (External) — always, regardless of amount/party:
//     MR. JAMES B. LAXA              -> "By:"
//     MS. ANDREIA CELINE VALDERRAMA  -> "Witnessed by:"
//
// `csoIsParty` (boolean) is a value the popup asks the user for explicitly
// when moaType === "internal" (as the CSO-ORG / ORG-ORG toggle) — a plain
// text check can't reliably tell "DLSU-SLIFE-CSO itself" apart from any
// other SLIFE-recognized org typed into the same placeholder, so this
// can't be inferred from the document text alone. If it's undefined (not
// yet answered), this check is skipped entirely rather than guessing.

import { DEFAULT_CONSTANT_SIGNATORIES, stripHonorific } from "./constantSignatories.js";
import { flatIndexToAbsolute, detectDlsuColumn } from "./textPosition.js";

const SIGNATORY_MARKER_RE = /\bBy:|\bWitnessed by:?/g;

function getExpectedPlacements(moaType, csoIsParty) {
  if (moaType === "internal") {
    if (csoIsParty === undefined || csoIsParty === null) return null;
    return csoIsParty
      ? {
          "MS. JOHANNE LEI S. FAILANA": "By:",
          "MR. JAMES B. LAXA": "Witnessed by:",
        }
      : {
          "MS. JOHANNE LEI S. FAILANA": "Witnessed by:",
          "MR. JAMES B. LAXA": "Witnessed by:",
        };
  }
  if (moaType === "sponsorship" || moaType === "partnership") {
    return {
      "MR. JAMES B. LAXA": "By:",
      "MS. ANDREIA CELINE VALDERRAMA": "Witnessed by:",
    };
  }
  return null;
}

/**
 * Same technique as googleDocs.js's findRangeForText 2nd pass: joins a run
 * subset's text and maps each joined-string offset back to its absolute
 * Docs index, so a substring position found in the joined text (e.g. "By:"
 * inside one column's runs) can be turned into a real highlightable range.
 */
function locateInRunSubset(runSubset, substringStart, length) {
  let joined = "";
  const posMap = [];
  for (const run of runSubset) {
    for (let i = 0; i < run.text.length; i++) posMap.push(run.startIndex + i);
    joined += run.text;
  }
  if (substringStart < 0 || substringStart + length > posMap.length) return null;
  return {
    startIndex: posMap[substringStart],
    endIndex: posMap[substringStart + length - 1] + 1,
  };
}

/**
 * Looks for `person.name` in `text` (case-insensitive), falling back to
 * the honorific-stripped core name (e.g. "JAMES B. LAXA" instead of "MR.
 * JAMES B. LAXA") if the full name isn't found. Returns the matched
 * index/length, or null if neither is present.
 *
 * This matters because a missing or wrong honorific is ALREADY a
 * dedicated, separate check (constantSignatories.js's
 * constant_signatory_missing_honorific) — without this fallback, someone
 * whose honorific is merely missing or misspelled would ALSO get wrongly
 * flagged here as "doesn't appear in the signatory block at all", which
 * is a much more alarming (and wrong) claim than what's actually true.
 */
function findNameInText(text, personName) {
  const upperText = text.toUpperCase();
  const fullIdx = upperText.indexOf(personName.toUpperCase());
  if (fullIdx !== -1) return { index: fullIdx, length: personName.length };

  const core = stripHonorific(personName);
  if (core) {
    const coreIdx = upperText.indexOf(core.toUpperCase());
    if (coreIdx !== -1) return { index: coreIdx, length: core.length };
  }

  return null;
}

export function checkConstantSignatoryPlacement(fullText, runs, moaType, csoIsParty, constantSignatoriesOverride) {
  const issues = [];
  if (!runs) return issues;

  const expected = getExpectedPlacements(moaType, csoIsParty);
  if (!expected) return issues;

  const anchorIdx = fullText.indexOf("IN WITNESS WHEREOF");
  if (anchorIdx === -1) return issues; // missing_required_section already flags this

  const anchorAbsoluteIndex = flatIndexToAbsolute(runs, anchorIdx);
  if (anchorAbsoluteIndex === null) return issues;

  // Only runs inside the signatory block AND inside a table cell — the
  // block is laid out as a borderless 2-column table (see googleDocs.js's
  // walkContent doc comment), so tableColumn (0 = left, 1 = right) is what
  // actually separates "the company/other org's column" from "DLSU's
  // column" once both sides carry real (filled-in) text.
  const signatoryRuns = runs.filter((r) => r.startIndex >= anchorAbsoluteIndex && r.tableColumn !== undefined);
  if (signatoryRuns.length === 0) return issues; // not laid out as a table — nothing to check structurally

  const people =
    constantSignatoriesOverride && constantSignatoriesOverride.length > 0
      ? constantSignatoriesOverride
      : DEFAULT_CONSTANT_SIGNATORIES;

  const dlsuColumn = detectDlsuColumn(signatoryRuns);

  for (const [personNameUpper, expectedSection] of Object.entries(expected)) {
    const person = people.find((p) => p.name.toUpperCase() === personNameUpper);
    if (!person) continue; // sheet override removed/renamed this person — nothing to check against

    const reason =
      moaType === "internal"
        ? csoIsParty
          ? " (CSO-ORG — CSO is a party to this MOA)"
          : " (ORG-ORG — CSO is not a party to this MOA, CSO only witnesses)"
        : "";

    // Does this person (full name OR honorific-stripped core name) appear
    // ANYWHERE in the signatory block at all (either column)? If not,
    // that's a missing-signatory issue, distinct from (and checked
    // before) a wrong-section issue.
    const appearsInBlock = [0, 1].some((col) => {
      const colText = signatoryRuns
        .filter((r) => r.tableColumn === col)
        .map((r) => r.text)
        .join("");
      return findNameInText(colText, person.name) !== null;
    });

    if (!appearsInBlock) {
      const missingIssue = {
        type: "constant_signatory_missing",
        text: person.name,
        message: `"${person.name}" does not appear in the signatory block at all — required under "${expectedSection}"${reason}.`,
      };

      // Best-effort: if we can confidently tell which column is DLSU/CSO's,
      // anchor the highlight to that column's expected marker so this
      // actually gets highlighted in the doc, not just an unanchored note.
      if (dlsuColumn !== null) {
        const colRuns = signatoryRuns.filter((r) => r.tableColumn === dlsuColumn);
        const colText = colRuns.map((r) => r.text).join("");
        const markerRe = expectedSection === "By:" ? /\bBy:/ : /\bWitnessed by:?/;
        const markerMatch = colText.match(markerRe);
        if (markerMatch) {
          const range = locateInRunSubset(colRuns, markerMatch.index, markerMatch[0].length);
          if (range) {
            missingIssue.location = { startIndex: range.startIndex, endIndex: range.endIndex, segment: "body" };
          }
        }
      }

      issues.push(missingIssue);
      continue; // can't check placement of someone who isn't there
    }

    for (const col of [0, 1]) {
      const colRuns = signatoryRuns.filter((r) => r.tableColumn === col);
      if (colRuns.length === 0) continue;
      const colText = colRuns.map((r) => r.text).join("");

      const found = findNameInText(colText, person.name);
      if (!found) continue; // this person doesn't appear in this column at all

      const markersBefore = [...colText.matchAll(SIGNATORY_MARKER_RE)].filter((m) => m.index < found.index);
      if (markersBefore.length === 0) continue; // name appears before any marker — too ambiguous to call, skip rather than false-positive

      const lastMarker = markersBefore[markersBefore.length - 1];
      const actualSection = lastMarker[0].startsWith("By:") ? "By:" : "Witnessed by:";

      if (actualSection !== expectedSection) {
        const wrongIssue = {
          type: "constant_signatory_wrong_section",
          text: person.name,
          message: `"${person.name}" is listed under "${actualSection}" but should be under "${expectedSection}"${reason}.`,
        };
        // Anchor precisely to THIS column's occurrence of the name, rather
        // than relying on a global text search that could land on a
        // different occurrence of the same name elsewhere in the doc.
        const range = locateInRunSubset(colRuns, found.index, found.length);
        if (range) {
          wrongIssue.location = { startIndex: range.startIndex, endIndex: range.endIndex, segment: "body" };
        }
        issues.push(wrongIssue);
      }
    }
  }

  return issues;
}

