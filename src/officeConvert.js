import { google } from "googleapis";

/**
 * Word (.docx / .doc) support.
 *
 * The Google Docs API refuses to read an uploaded Office file in place
 * ("This operation is not supported for this document" / "must not be an
 * Office file"), and every check, highlight and comment in Mo is built on
 * the Docs API. Rather than fork the rule engine, Mo converts the Word file
 * to a native Google Doc COPY (Drive does the conversion server-side during
 * files.copy) and runs the exact same pipeline against that copy.
 *
 * Consequences worth knowing:
 *   - Highlights and comments land in the copy, never in the original
 *     Word file (Drive can't edit those in place). The popup links to it.
 *   - The copy is owned by the person running the check, so this also works
 *     for Word files they can only view.
 *   - One copy is kept per source file and reused while the source is
 *     unchanged (matched by md5Checksum), so re-checking doesn't litter the
 *     Drive. When the source changes, a fresh copy is made, the
 *     "don't flag again" state (moDismissed / moConfirmedCorrect) is carried
 *     over, and the previous copy is moved to the Drive trash.
 *   - Layout-dependent checks (page breaks, one-page signature block, footer
 *     line count) run on the converted layout, which can differ slightly from
 *     Word's. Those checks were already advisory.
 */

export const GOOGLE_DOC_MIME = "application/vnd.google-apps.document";

export const OFFICE_DOC_MIMES = {
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/msword": "doc",
};

// appProperties written on the COPY so it can be found again later.
const SOURCE_ID_KEY = "moSourceId";
const SOURCE_FP_KEY = "moSourceFp";
// Per-document override state that must survive a re-conversion.
const CARRY_OVER_KEYS = ["moDismissed", "moConfirmedCorrect"];

const DRIVE_ID_RE = /^[a-zA-Z0-9_-]{10,100}$/;

function authorizedClient(accessToken) {
  const auth = new google.auth.OAuth2();
  auth.setCredentials({ access_token: accessToken });
  return auth;
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

export function docUrl(fileId) {
  return `https://docs.google.com/document/d/${fileId}/edit`;
}

// appProperties values are capped at 124 chars (key + value ≤ 124 bytes).
function fingerprintOf(meta) {
  return String(meta.md5Checksum || meta.modifiedTime || "unknown").slice(0, 60);
}

function copyName(sourceName) {
  const base = String(sourceName || "Untitled").replace(/\.(docx?|DOCX?)$/, "");
  return `${base} (Mo check)`;
}

function describeConvertError(err) {
  const code = err?.code || err?.status || err?.response?.status;
  const msg = err?.errors?.[0]?.message || err?.message || "";
  if (code === 404) {
    return "Mo can't see this Word file. Make sure you're signed in with the account that has access to it.";
  }
  if (code === 403 && /copy|download|restrict/i.test(msg)) {
    return "This Word file can't be copied — its owner may have disabled copying or downloading. Ask for edit access, or make your own copy and run Mo on that.";
  }
  if (code === 403 && /quota|rate/i.test(msg)) {
    return "Google Drive is rate-limiting requests right now. Wait a minute and try again.";
  }
  return `Couldn't convert this Word file to a Google Doc: ${msg || "unknown error"}`;
}

/**
 * Returns a native Google Doc copy of a Word file, creating (or reusing) it.
 *
 * @param sourceId   Drive file ID of the .docx/.doc
 * @param accessToken the signed-in user's OAuth token
 * @param sourceMeta { name, md5Checksum, modifiedTime, parents } from Drive
 * @param opts.drive  injectable Drive client (tests)
 * @returns { copyId, copyName, copyUrl, reused, replaced }
 */
export async function ensureConvertedCopy(sourceId, accessToken, sourceMeta = {}, { drive } = {}) {
  if (!DRIVE_ID_RE.test(sourceId)) {
    throw httpError(400, "That doesn't look like a valid Google Drive file ID.");
  }
  const client = drive ?? google.drive({ version: "v3", auth: authorizedClient(accessToken) });
  const fingerprint = fingerprintOf(sourceMeta);

  // 1) Existing Mo copies of this source (newest first). Failure here isn't
  //    fatal — worst case we make a fresh copy instead of reusing one.
  let existing = [];
  try {
    const { data } = await client.files.list({
      q: `appProperties has { key='${SOURCE_ID_KEY}' and value='${sourceId}' } and trashed = false`,
      fields: "files(id, name, createdTime, appProperties)",
      orderBy: "createdTime desc",
      pageSize: 10,
      spaces: "drive",
    });
    existing = data?.files || [];
  } catch (err) {
    console.error("ensureConvertedCopy: lookup failed, creating a fresh copy:", err.message);
  }

  // 2) Source unchanged since that copy was made → reuse it as-is.
  const upToDate = existing.find((f) => f.appProperties?.[SOURCE_FP_KEY] === fingerprint);
  if (upToDate) {
    return {
      copyId: upToDate.id,
      copyName: upToDate.name,
      copyUrl: docUrl(upToDate.id),
      reused: true,
      replaced: 0,
    };
  }

  // 3) Convert. Carry over the reviewer's "don't flag again" state from the
  //    newest previous copy; its hashes are derived from flagged text, so
  //    anything that no longer matches the new content self-heals as usual.
  const appProperties = { [SOURCE_ID_KEY]: sourceId, [SOURCE_FP_KEY]: fingerprint };
  const previous = existing[0]?.appProperties || {};
  for (const key of CARRY_OVER_KEYS) {
    if (previous[key]) appProperties[key] = previous[key];
  }

  const requestBody = {
    name: copyName(sourceMeta.name),
    mimeType: GOOGLE_DOC_MIME, // this is what makes Drive convert during the copy
    appProperties,
  };
  if (Array.isArray(sourceMeta.parents) && sourceMeta.parents.length) {
    requestBody.parents = sourceMeta.parents; // keep it next to the original when we can
  }

  let created;
  try {
    ({ data: created } = await client.files.copy({ fileId: sourceId, requestBody, fields: "id, name" }));
  } catch (firstErr) {
    if (!requestBody.parents) throw httpError(500, describeConvertError(firstErr));
    // Probably no write access to the original's folder — fall back to My Drive.
    delete requestBody.parents;
    try {
      ({ data: created } = await client.files.copy({ fileId: sourceId, requestBody, fields: "id, name" }));
    } catch (secondErr) {
      throw httpError(500, describeConvertError(secondErr));
    }
  }

  // 4) Retire superseded copies (Drive trash, so it's recoverable). Non-fatal.
  let replaced = 0;
  for (const old of existing) {
    try {
      await client.files.update({ fileId: old.id, requestBody: { trashed: true } });
      replaced++;
    } catch (err) {
      console.error("ensureConvertedCopy: couldn't trash old copy:", err.message);
    }
  }

  return {
    copyId: created.id,
    copyName: created.name || requestBody.name,
    copyUrl: docUrl(created.id),
    reused: false,
    replaced,
  };
}
