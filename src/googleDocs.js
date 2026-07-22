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
 * Fetches the full document JSON from the Docs API and flattens it into
 * a list of { text, startIndex, endIndex } runs, which is what the rule
 * engine works against. Google Docs indices are UTF-16 code unit offsets
 * within the doc body — required for later highlight/comment writes.
 */
export async function fetchDocument(docId, accessToken) {
  const auth = authorizedClient(accessToken);
  const docs = google.docs({ version: "v1", auth });

  const res = await docs.documents.get({ documentId: docId });
  const doc = res.data;

  const runs = [];
  const content = doc.body?.content || [];

  for (const el of content) {
    if (!el.paragraph) continue;
    for (const pe of el.paragraph.elements || []) {
      if (pe.textRun?.content) {
        runs.push({
          text: pe.textRun.content,
          startIndex: pe.startIndex,
          endIndex: pe.endIndex,
        });
      }
    }
  }

  const fullText = runs.map((r) => r.text).join("");

  return { doc, runs, fullText };
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
