import { google } from "googleapis";

/**
 * Builds an authorized googleapis client using the access token the
 * extension obtained via chrome.identity.getAuthToken (OAuth, user-scoped).
 */
function authorizedClient(accessToken) {
  const auth = new google.auth.OAuth2();
  auth.setCredentials({ access_token: accessToken });
  return auth;
}

/**
 * Walks a Docs API "content" array (from doc.body.content or a footer's
 * content array) and flattens it into a list of
 * { text, startIndex, endIndex, bold } runs. Shared by fetchDocument()
 * for the body and for each footer, since both are structured identically
 * (arrays of StructuralElements -> paragraph -> elements -> textRun).
 */
function extractRuns(content) {
  const runs = [];
  for (const el of content || []) {
    if (!el.paragraph) continue;
    for (const pe of el.paragraph.elements || []) {
      if (pe.textRun?.content) {
        runs.push({
          text: pe.textRun.content,
          startIndex: pe.startIndex,
          endIndex: pe.endIndex,
          bold: !!pe.textRun.textStyle?.bold,
        });
      }
    }
  }
  return runs;
}

/**
 * Fetches the full document JSON from the Docs API and flattens it into
 * a list of { text, startIndex, endIndex, bold } runs, which is what the
 * rule engine works against. Google Docs indices are UTF-16 code unit
 * offsets within the doc body — required for later highlight/comment
 * writes. `bold` is read from textRun.textStyle.bold on each run so rules
 * can check formatting, not just flattened text.
 *
 * Also extracts each Section's footer (footers live in doc.footers,
 * keyed by footerId, and are NOT part of doc.body.content) and the
 * document's page size, needed for the one-line-footer and
 * one-page-signatory-block estimates.
 */
export async function fetchDocument(docId, accessToken) {
  const auth = authorizedClient(accessToken);
  const docs = google.docs({ version: "v1", auth });

  let res;
  try {
    res = await docs.documents.get({ documentId: docId });
  } catch (err) {
    const googleMessage = err?.errors?.[0]?.message || err?.message || "";
    if (googleMessage.includes("must not be an Office file")) {
      throw new Error(
        "This looks like an uploaded Word file (.docx), not a native Google Doc — Mo can only check native Google Docs. Open it and use File → Save as Google Docs, then run Mo on that new copy."
      );
    }
    throw err;
  }
  const doc = res.data;

  const runs = extractRuns(doc.body?.content);
  const fullText = runs.map((r) => r.text).join("");

  // Footers: doc.footers is a map of footerId -> Footer object. Collect
  // every distinct footer referenced by the document (default, first-page,
  // even-page) rather than assuming a single footer, since a doc can
  // define more than one.
  const footerIds = new Set();
  if (doc.documentStyle?.defaultFooterId) footerIds.add(doc.documentStyle.defaultFooterId);
  if (doc.documentStyle?.firstPageFooterId) footerIds.add(doc.documentStyle.firstPageFooterId);
  if (doc.documentStyle?.evenPageFooterId) footerIds.add(doc.documentStyle.evenPageFooterId);
  for (const el of doc.body?.content || []) {
    const sectionFooterId = el.sectionBreak?.sectionStyle?.defaultFooterId;
    if (sectionFooterId) footerIds.add(sectionFooterId);
  }
  // Fallback: if nothing was referenced explicitly but doc.footers exists
  // (e.g. simple single-section docs), include all of them.
  if (footerIds.size === 0 && doc.footers) {
    for (const id of Object.keys(doc.footers)) footerIds.add(id);
  }

  const footers = [...footerIds]
    .filter((id) => doc.footers?.[id])
    .map((footerId) => {
      const footerRuns = extractRuns(doc.footers[footerId].content);
      return {
        footerId,
        runs: footerRuns,
        fullText: footerRuns.map((r) => r.text).join(""),
      };
    });

  const pageSize = doc.documentStyle?.pageSize || null;

  return { doc, runs, fullText, footers, pageSize };
}

/**
 * Given a set of runs (with `bold` flags, as returned by extractRuns /
 * fetchDocument) and a plain-text needle, checks whether the needle is
 * bold in full. Handles needles that span multiple runs (e.g. because
 * part of the phrase has a different formatting boundary) by requiring
 * every contributing run to be bold. Returns:
 *   - true  if found and every contributing run is bold
 *   - false if found and at least one contributing run is not bold
 *   - null  if the needle wasn't found at all (can't judge boldness)
 */
export function isTextBold(runs, needle) {
  let joined = "";
  const runIndexMap = []; // runIndexMap[i] = index into `runs` for joined[i]
  runs.forEach((run, runIdx) => {
    for (let i = 0; i < run.text.length; i++) runIndexMap.push(runIdx);
    joined += run.text;
  });

  const idx = joined.indexOf(needle);
  if (idx === -1) return null;

  const involvedRunIdxs = new Set();
  for (let i = idx; i < idx + needle.length; i++) involvedRunIdxs.add(runIndexMap[i]);

  for (const runIdx of involvedRunIdxs) {
    if (!runs[runIdx].bold) return false;
  }
  return true;
}

/**
 * Given a plain-text substring match, finds its absolute Docs API index
 * range by walking the run list. Returns null if not found.
 * NOTE: naive substring search — good enough for flagged single-line
 * fields; for multi-run matches spanning formatting boundaries, a more
 * robust sliding-window match across concatenated run text is needed.
 */
export function findRangeForText(runs, needle) {
  // First pass: try within a single run (fast path, exact match).
  for (const run of runs) {
    const idx = run.text.indexOf(needle);
    if (idx !== -1) {
      return {
        startIndex: run.startIndex + idx,
        endIndex: run.startIndex + idx + needle.length,
      };
    }
  }

  // Second pass: the needle may span multiple runs (e.g. split by inline
  // formatting boundaries). Concatenate all run text with a lookup table
  // mapping each character position back to its absolute doc index, then
  // search across the joined string.
  let joined = "";
  const posMap = []; // posMap[i] = absolute doc index of joined[i]
  for (const run of runs) {
    for (let i = 0; i < run.text.length; i++) {
      posMap.push(run.startIndex + i);
    }
    joined += run.text;
  }

  const idx = joined.indexOf(needle);
  if (idx !== -1) {
    return {
      startIndex: posMap[idx],
      endIndex: posMap[idx + needle.length - 1] + 1,
    };
  }

  return null;
}

/**
 * Applies a highlight (background color) to a text range via batchUpdate.
 */
export async function highlightRange(docId, accessToken, range, color = { red: 1, green: 0.93, blue: 0.75 }) {
  const auth = authorizedClient(accessToken);
  const docs = google.docs({ version: "v1", auth });

  await docs.documents.batchUpdate({
    documentId: docId,
    requestBody: {
      requests: [
        {
          updateTextStyle: {
            range: { startIndex: range.startIndex, endIndex: range.endIndex },
            textStyle: {
              backgroundColor: { color: { rgbColor: color } },
            },
            fields: "backgroundColor",
          },
        },
      ],
    },
  });
}

/**
 * Adds a native comment anchored to a text range. Comments live in the
 * Drive API, not the Docs API — this uses anchored replies via the
 * "anchor" field referencing the doc's revision + range.
 */
export async function addComment(docId, accessToken, range, message) {
  const auth = authorizedClient(accessToken);
  const drive = google.drive({ version: "v3", auth });

  const anchor = JSON.stringify({
    r: "head",
    a: [
      {
        txt: {
          o: range.startIndex,
          l: range.endIndex - range.startIndex,
        },
      },
    ],
  });

  await drive.comments.create({
    fileId: docId,
    fields: "id",
    requestBody: {
      content: message,
      anchor,
    },
  });
}
