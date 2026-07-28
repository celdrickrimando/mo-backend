// Dependency-free position/text helpers shared across the rule engine.
//
// Pulled out of shared.js / constantSignatories.js (where flatIndexToAbsolute,
// locationFor, and HONORIFICS were duplicated verbatim to avoid a circular
// import — shared.js imports FROM constantSignatories.js, so
// constantSignatories.js couldn't import these back from shared.js).
// This file imports from neither, so both (and signatoryPlacement.js,
// draftStage.js) can import from here instead of hand-rolling their own
// copies. See Mo_Handoff_Notes.md section D.

/**
 * Maps a flattened-fullText offset to its absolute Docs API startIndex, by
 * walking runs and accumulating their text lengths. Several checks derive a
 * precise fullText position (via match.indices or manual offset tracking)
 * to call isRangeBold/isRangeItalic correctly — this lets those same checks
 * attach that already-known-correct position to the issue as `location`, so
 * index.js's write-back step can highlight the EXACT occurrence that was
 * actually checked, instead of re-finding the text by an ambiguous global
 * search that could land on a different, differently formatted occurrence
 * of the same string elsewhere in the document (a name or org short name
 * commonly appears more than once in a MOA).
 */
export function flatIndexToAbsolute(runs, flatIndex) {
  let charsSeen = 0;
  for (const run of runs) {
    if (charsSeen + run.text.length > flatIndex) {
      return run.startIndex + (flatIndex - charsSeen);
    }
    charsSeen += run.text.length;
  }
  return null;
}

export function locationFor(runs, startIndex, endIndex) {
  const absStart = flatIndexToAbsolute(runs, startIndex);
  const absEnd = flatIndexToAbsolute(runs, endIndex - 1);
  if (absStart === null || absEnd === null) return undefined;
  return { startIndex: absStart, endIndex: absEnd + 1, segment: "body" };
}

/**
 * Same walk as flatIndexToAbsolute, but returns the actual run object
 * containing that offset (not just its absolute index) — needed when a
 * caller wants to read one of the run's own fields (e.g. `tableColumn`)
 * at a specific fullText position, not just convert the position itself.
 */
export function runContainingFlatIndex(runs, flatIndex) {
  let charsSeen = 0;
  for (const run of runs) {
    if (charsSeen + run.text.length > flatIndex) return run;
    charsSeen += run.text.length;
  }
  return null;
}

// Fixed text that only ever appears on DLSU/CSO's own side of the
// signatory block (never the other party's) — used to figure out which
// of the two table columns is "DLSU/CSO's column" when a name is
// missing/blank and there's no name occurrence to anchor off of.
// Originally local to signatoryPlacement.js; moved here so
// shared.js's blank-signatory-slot check (which needs the same
// left/right column identification, to avoid double-flagging a blank
// DLSU/CSO slot that's already reported by name via
// checkConstantSignatoryPlacement) can reuse it instead of duplicating it.
export const DLSU_SIDE_MARKERS = ["DLSU-SLIFE-CSO", "OFFICE OF STUDENT LIFE", "DE LA SALLE UNIVERSITY"];

/** Which of the two table columns (0/1) carries DLSU/CSO's own fixed text, if determinable. */
export function detectDlsuColumn(signatoryRuns) {
  const hits = {};
  for (const col of [0, 1]) {
    const colText = signatoryRuns
      .filter((r) => r.tableColumn === col)
      .map((r) => r.text)
      .join("")
      .toUpperCase();
    hits[col] = DLSU_SIDE_MARKERS.some((m) => colText.includes(m));
  }
  if (hits[0] && !hits[1]) return 0;
  if (hits[1] && !hits[0]) return 1;
  return null; // ambiguous (both or neither) — don't guess
}

export const HONORIFICS = ["MR.", "MS.", "MRS.", "DR.", "ATTY.", "ENGR.", "FR.", "BR.", "SR.", "HON.", "REV."];

// Strips a recognized honorific prefix (e.g. "MR. ") off `name`, or
// returns null if it doesn't start with one of the known honorifics.
export function stripHonorific(name) {
  for (const h of HONORIFICS) {
    if (name.startsWith(h + " ")) return name.slice(h.length + 1);
  }
  return null;
}
