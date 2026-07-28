import { google } from "googleapis";
import pdfParse from "pdf-parse";

// NOTE: pinned to pdf-parse@1.1.4 (package.json), not the current 2.x
// release line. pdf-parse 2.x is a ground-up TypeScript/ESM rewrite with
// a different API surface and a native canvas dependency (~20MB install)
// — it does not export a plain `pdfParse(buffer) -> {text, numpages}`
// callable the way this file expects. 1.1.4 is the last version on the
// legacy 1.x branch (still published/maintained under npm's "minor"
// dist-tag) and keeps that simple callable API. If upgrading later,
// re-verify this call site against whatever the new API actually is.

function authorizedClient(accessToken) {
  const auth = new google.auth.OAuth2();
  auth.setCredentials({ access_token: accessToken });
  return auth;
}

/**
 * Downloads a PDF's raw bytes from Google Drive (works for any PDF the
 * signed-in user can access, whether uploaded directly or exported from
 * a Docs/Slides file) and extracts its flattened text.
 *
 * IMPORTANT: this returns flattened text only — no per-run formatting,
 * no header/footer/body index separation, no page dimensions, no image
 * positions. See MO_NEXT_STEPS.md Feature 3 for exactly which rule-engine
 * checks are skipped in PDF mode and why.
 */
export async function fetchPdfDocument(fileId, accessToken) {
  const auth = authorizedClient(accessToken);
  const drive = google.drive({ version: "v3", auth });

  const res = await drive.files.get(
    { fileId, alt: "media" },
    { responseType: "arraybuffer" }
  );
  const buffer = Buffer.from(res.data);

  const parsed = await pdfParse(buffer);
  return { fullText: parsed.text, numPages: parsed.numpages };
}

/**
 * Confirms a Drive file is actually a PDF before we try to parse it as
 * one — /check needs this to decide which flow (Docs vs PDF) to run.
 */
export async function getDriveFileMimeType(fileId, accessToken) {
  const auth = authorizedClient(accessToken);
  const drive = google.drive({ version: "v3", auth });
  const { data } = await drive.files.get({ fileId, fields: "mimeType, name" });
  return data; // { mimeType, name }
}
