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

// Invisible marker prepended to every comment Mo creates. Google Docs'
// comment sidebar doesn't render zero-width characters, so reviewers
// never see this — but it lets a later /check run tell "a comment Mo
// wrote" apart from "a comment a human reviewer wrote", since both are
// created under the same signed-in user's identity (Mo has no bot
// account of its own). Never change this string without also writing a
// one-time migration to resolve comments tagged with the OLD marker,
// or old comments will become permanently invisible to cleanup.
const MO_COMMENT_MARKER = "\u200B\u2063\u200B";

/**
 * Prefixes a comment's message with Mo's invisible marker. Every call
 * site that creates a comment (addComment, addGeneralComment) MUST wrap
 * its message with this before sending it to the Drive API, or that
 * comment becomes invisible to cleanupPreviousMoComments() forever.
 */
function tagMoComment(message) {
  return `${MO_COMMENT_MARKER}${message}`;
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
  const images = []; // NEW: [{startIndex, endIndex, objectId}]
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
      } else if (pe.autoText) {
        // Page number / page count fields (footer "Page X") render their
        // text dynamically and have no literal `content` string, but they
        // do carry their own textStyle. Track them as a zero-length run
        // with isPageNumber set so footer checks can judge their bold
        // state independently from the surrounding text instead of the
        // field silently vanishing from the run list.
        runs.push({
          text: "",
          startIndex: pe.startIndex,
          endIndex: pe.endIndex,
          bold: !!pe.autoText.textStyle?.bold,
          isPageNumber: pe.autoText.type === "PAGE_NUMBER",
        });
      } else if (pe.inlineObjectElement) {
        // An inserted image/drawing (e.g. a scanned/drawn signature).
        // Docs represents these as a zero-width placeholder character in
        // the text stream, referencing doc.inlineObjects[objectId] for
        // the actual image data — we don't need the image bytes here,
        // just its position, so checkNoSignaturesInDraft() can tell
        // whether an image sits inside the signatory block.
        images.push({
          startIndex: pe.startIndex,
          endIndex: pe.endIndex,
          objectId: pe.inlineObjectElement.inlineObjectId,
        });
      }
    }
  }
  return { runs, images };
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

  const { runs, images } = extractRuns(doc.body?.content);
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
      const { runs: footerRuns } = extractRuns(doc.footers[footerId].content);
      return {
        footerId,
        runs: footerRuns,
        fullText: footerRuns.map((r) => r.text).join(""),
      };
    });

  const pageSize = doc.documentStyle?.pageSize || null;

  // Headers: same shape/reasoning as footers above — doc.headers is a map
  // of headerId -> Header object, NOT part of doc.body.content. This is
  // where the top-right tracking code (e.g. "D-A-1a") actually lives, so
  // checkTopRightCode() needs this, not just body fullText.
  const headerIds = new Set();
  if (doc.documentStyle?.defaultHeaderId) headerIds.add(doc.documentStyle.defaultHeaderId);
  if (doc.documentStyle?.firstPageHeaderId) headerIds.add(doc.documentStyle.firstPageHeaderId);
  if (doc.documentStyle?.evenPageHeaderId) headerIds.add(doc.documentStyle.evenPageHeaderId);
  for (const el of doc.body?.content || []) {
    const sectionHeaderId = el.sectionBreak?.sectionStyle?.defaultHeaderId;
    if (sectionHeaderId) headerIds.add(sectionHeaderId);
  }
  if (headerIds.size === 0 && doc.headers) {
    for (const id of Object.keys(doc.headers)) headerIds.add(id);
  }

  const headers = [...headerIds]
    .filter((id) => doc.headers?.[id])
    .map((headerId) => {
      const { runs: headerRuns } = extractRuns(doc.headers[headerId].content);
      return {
        headerId,
        runs: headerRuns,
        fullText: headerRuns.map((r) => r.text).join(""),
      };
    });
  const headerText = headers.map((h) => h.fullText).join("\n");

  return { doc, runs, images, fullText, footers, headers, headerText, pageSize };
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
export function findRangeForText(runs, needle, segmentId) {
  // First pass: try within a single run (fast path, exact match).
  for (const run of runs) {
    const idx = run.text.indexOf(needle);
    if (idx !== -1) {
      return {
        startIndex: run.startIndex + idx,
        endIndex: run.startIndex + idx + needle.length,
        ...(segmentId ? { segmentId } : {}),
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
      ...(segmentId ? { segmentId } : {}),
    };
  }

  return null;
}

/**
 * Locates `needle` across the document's body, footers, AND headers (in
 * that order), returning both the range (tagged with a `segmentId` when
 * the match is inside a footer/header, since those are separate index
 * spaces from the body per the Docs API) and which segment it came from.
 * Returns null if the text can't be found anywhere.
 *
 * This exists because footer- and header-only text (the "Memorandum of
 * Agreement..." line, "D-A-1a", etc.) previously could never be located
 * via findRangeForText(bodyRuns, needle) alone — those runs simply aren't
 * in the body's run list at all. Issues referencing that text used to
 * fall through to a generic, unanchored "general notes" comment glued to
 * the very first character of the document body, which is both
 * meaningless to a reviewer and prone to Google Docs showing "Original
 * content deleted" once that phantom anchor drifts from the current
 * content on any subsequent edit.
 */
export function findRangeAnywhere(needle, { runs, footers = [], headers = [] }) {
  const bodyRange = findRangeForText(runs, needle);
  if (bodyRange) return { ...bodyRange, segment: "body" };

  for (const footer of footers) {
    const range = findRangeForText(footer.runs, needle, footer.footerId);
    if (range) return { ...range, segment: "footer" };
  }

  for (const header of headers) {
    const range = findRangeForText(header.runs, needle, header.headerId);
    if (range) return { ...range, segment: "header" };
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
            range: {
              startIndex: range.startIndex,
              endIndex: range.endIndex,
              // segmentId targets a specific header/footer/footnote's own
              // index space; omitted (undefined) means "the doc body",
              // per the Docs API's Range.segmentId field.
              ...(range.segmentId ? { segmentId: range.segmentId } : {}),
            },
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
 * The exact highlight color highlightRange() applies by default. Named
 * here (not just inlined) so clearAllMoHighlights() below searches for
 * precisely the color highlightRange() writes — if that default is ever
 * changed, both call sites move together instead of silently drifting
 * apart and leaving old-color highlights undetectable by cleanup.
 */
const MO_HIGHLIGHT_COLOR = { red: 1, green: 0.93, blue: 0.75 };
const COLOR_MATCH_EPSILON = 0.01; // float tolerance for rgbColor component equality

function colorsMatch(rgbColor) {
  if (!rgbColor) return false;
  const { red = 0, green = 0, blue = 0 } = rgbColor;
  return (
    Math.abs(red - MO_HIGHLIGHT_COLOR.red) < COLOR_MATCH_EPSILON &&
    Math.abs(green - MO_HIGHLIGHT_COLOR.green) < COLOR_MATCH_EPSILON &&
    Math.abs(blue - MO_HIGHLIGHT_COLOR.blue) < COLOR_MATCH_EPSILON
  );
}

function findHighlightedRanges(content) {
  const ranges = [];
  for (const el of content || []) {
    if (!el.paragraph) continue;
    for (const pe of el.paragraph.elements || []) {
      const bg = pe.textRun?.textStyle?.backgroundColor?.color?.rgbColor;
      if (colorsMatch(bg)) {
        ranges.push({ startIndex: pe.startIndex, endIndex: pe.endIndex });
      }
    }
  }
  return ranges;
}

/**
 * Clears every highlight Mo previously applied (matched by exact color,
 * see MO_HIGHLIGHT_COLOR), across the body and every header/footer.
 * Comments were being cleaned up each run (cleanupPreviousMoComments) but
 * the actual highlight formatting underneath them was not — so a
 * resolved/stale comment's highlight color stayed in the document
 * forever. Call this alongside cleanupPreviousMoComments(), BEFORE
 * writing this run's new highlights.
 *
 * Reuses the `doc` object already returned by fetchDocument() for this
 * same /check call rather than re-fetching — any highlight color found
 * in it at that point is necessarily left over from a PRIOR run, since
 * this run hasn't written any new ones yet.
 */
export async function clearAllMoHighlights(docId, accessToken, doc) {
  const auth = authorizedClient(accessToken);
  const docs = google.docs({ version: "v1", auth });

  const requests = [];

  for (const range of findHighlightedRanges(doc.body?.content)) {
    requests.push({
      updateTextStyle: {
        range: { startIndex: range.startIndex, endIndex: range.endIndex },
        textStyle: { backgroundColor: {} },
        fields: "backgroundColor",
      },
    });
  }

  for (const [segmentId, header] of Object.entries(doc.headers || {})) {
    for (const range of findHighlightedRanges(header.content)) {
      requests.push({
        updateTextStyle: {
          range: { startIndex: range.startIndex, endIndex: range.endIndex, segmentId },
          textStyle: { backgroundColor: {} },
          fields: "backgroundColor",
        },
      });
    }
  }

  for (const [segmentId, footer] of Object.entries(doc.footers || {})) {
    for (const range of findHighlightedRanges(footer.content)) {
      requests.push({
        updateTextStyle: {
          range: { startIndex: range.startIndex, endIndex: range.endIndex, segmentId },
          textStyle: { backgroundColor: {} },
          fields: "backgroundColor",
        },
      });
    }
  }

  if (requests.length === 0) return { cleared: 0 };

  await docs.documents.batchUpdate({
    documentId: docId,
    requestBody: { requests },
  });

  return { cleared: requests.length };
}

/**
 * Adds a native comment anchored to a text range. Comments live in the
 * Drive API, not the Docs API — this uses anchored replies via the
 * "anchor" field referencing the doc's revision + range.
 *
 * IMPORTANT: the "r" field must be the Docs API's own revisionId
 * (`documents.get().data.revisionId`) — NOT Drive's `headRevisionId`.
 * These are two different ID spaces/formats: `headRevisionId` belongs to
 * the Drive Revisions resource (built for binary files/Sheets), while
 * the anchor format Google Docs' own comment UI writes expects the
 * Docs-native revisionId. Passing the Drive one silently produces an
 * invalid anchor: `comments.create` succeeds (no error thrown, since
 * Drive doesn't validate that string against Docs internals) but the
 * comment never actually attaches to the range the way a real
 * Ctrl+Alt+M comment does — it just floats, unanchored.
 *
 * Also: fetch this fresh right here, not earlier in the request. If a
 * highlightRange() batchUpdate ran first (as it does in index.js), the
 * doc's revisionId has already moved forward by the time we comment —
 * using a revisionId captured before that edit would anchor against a
 * revision that's no longer current.
 */
export async function addComment(docId, accessToken, range, message) {
  if (range?.segmentId) {
    // The Drive Comments "anchor" JSON's `txt: {o, l}` offsets are only
    // valid within the document BODY's index space. A footer/header
    // range's startIndex/endIndex are local to that footer/header
    // instead, so reusing this same anchor format would point at an
    // unrelated (or out-of-bounds) spot in the body — silently creating
    // a broken/misplaced comment rather than throwing. Callers should
    // use highlightRange() (which does support segmentId) for the visual
    // marker, and addGeneralComment() for the note itself, when the
    // match is inside a footer or header.
    throw new Error(
      "addComment() can't anchor into a footer/header segment — use addGeneralComment() for footer/header matches instead."
    );
  }

  const auth = authorizedClient(accessToken);
  const docs = google.docs({ version: "v1", auth });
  const drive = google.drive({ version: "v3", auth });

  const { data } = await docs.documents.get({
    documentId: docId,
    fields: "revisionId",
  });
  const revisionId = data.revisionId;

  const anchor = JSON.stringify({
    r: revisionId,
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
      content: tagMoComment(message),
      anchor,
    },
  });
}

/**
 * Adds a plain, UNANCHORED comment — one that isn't tied to any text
 * range at all. Used for issues whose flagged text lives in a footer or
 * header (where body-relative anchoring doesn't apply) or that reference
 * no locatable text in the document at all (e.g. something missing
 * entirely).
 *
 * This intentionally does NOT fake an anchor (e.g. pointing at the first
 * character of the body) the way an earlier version of this codebase
 * did — that produced a meaningless 1-character "highlight" plus a
 * comment whose quoted content didn't match what the comment was
 * actually about, which Google Docs would often render as "Original
 * content deleted" once the doc changed at all after the anchor was
 * created. A plain comment with no anchor has nothing to go stale, and
 * the message itself quotes the specific flagged text so it's still
 * clear what the comment refers to.
 */
export async function addGeneralComment(docId, accessToken, message) {
  const auth = authorizedClient(accessToken);
  const drive = google.drive({ version: "v3", auth });

  await drive.comments.create({
    fileId: docId,
    fields: "id",
    requestBody: {
      content: tagMoComment(message),
    },
  });
}

/**
 * Finds every unresolved comment Mo previously wrote on this doc (marker-
 * tagged, see tagMoComment) and resolves them via a "resolve" reply — the
 * only way the Drive API supports resolving a comment (Comment.resolved
 * is a read-only field; you can't just PATCH it to true). Comments the
 * user wrote manually are left completely untouched, since they never
 * carry the marker.
 *
 * Call this ONCE at the start of every /check run, before writing any of
 * this run's highlights/comments, so stale anchors from a prior run never
 * pile up alongside fresh ones.
 *
 * Returns {found, resolved} for observability in the /check response —
 * "found" may be > "resolved" if some comments fail to resolve (e.g. a
 * race with the user deleting the comment themselves mid-request); those
 * failures are swallowed per-comment so one bad comment can't block
 * cleanup of the rest or the rest of the /check run.
 */
export async function cleanupPreviousMoComments(docId, accessToken) {
  const auth = authorizedClient(accessToken);
  const drive = google.drive({ version: "v3", auth });

  const staleIds = [];
  let pageToken;
  do {
    const { data } = await drive.comments.list({
      fileId: docId,
      fields: "nextPageToken, comments(id, content, resolved)",
      pageToken,
      pageSize: 100,
    });
    for (const c of data.comments || []) {
      if (!c.resolved && typeof c.content === "string" && c.content.startsWith(MO_COMMENT_MARKER)) {
        staleIds.push(c.id);
      }
    }
    pageToken = data.nextPageToken || undefined;
  } while (pageToken);

  let resolvedCount = 0;
  for (const commentId of staleIds) {
    try {
      await drive.replies.create({
        fileId: docId,
        commentId,
        fields: "id",
        requestBody: { action: "resolve" },
      });
      resolvedCount++;
    } catch (err) {
      // Non-fatal: comment may already be gone/resolved by the user.
      // Swallow and keep going so one failure doesn't block the rest.
    }
  }

  return { found: staleIds.length, resolved: resolvedCount };
}
