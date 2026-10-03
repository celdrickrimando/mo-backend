// Drives the REAL Express app and the REAL rule engine, with Google (auth,
// Docs, Drive) swapped for in-memory fakes. Verifies the routing between the
// three file types and that Word files are checked/marked on the converted
// copy — not on the original file.
import { describe, test, mock, before, after } from "node:test";
import assert from "node:assert/strict";
import * as realDocs from "../src/googleDocs.js"; // keep the real pure helpers (isRangeBold, …); fake only what calls Google

const PORT = 18787;
process.env.PORT = String(PORT);
process.env.NODE_ENV = "test";
process.env.REFRESH_RULES_SECRET = "s3cret-value";
const U = (p) => new URL(p, import.meta.url).href;

const SOURCE = "SOURCEdocxID123456";
const COPY = "CONVERTEDcopyID12345";
const NATIVE = "NATIVEgoogleDocID12";
const PDFID = "PDFfileIDabcdefghij";

const writes = []; // every Docs/Drive write, so we can see which file it hit
const mimeById = {
  [SOURCE]: { mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", name: "My MOA.docx", md5Checksum: "m1", parents: ["p"] },
  [NATIVE]: { mimeType: "application/vnd.google-apps.document", name: "Native" },
  [PDFID]: { mimeType: "application/pdf", name: "x.pdf" },
  WEIRDfileID12345678: { mimeType: "image/png", name: "pic.png" },
};
const text = "MEMORANDUM OF AGREEMENT\nKnow all men by these presents\n";
const doc = {
  doc: { body: { content: [] } },
  runs: [{ text, startIndex: 1, endIndex: 1 + text.length, bold: false }],
  images: [], pageBreaks: [], fullText: text, footers: [], headers: [], headerText: "", pageSize: { width: { magnitude: 612 }, height: { magnitude: 792 } },
};
const rec = (name) => async (...a) => { writes.push([name, a[0]]); };

describe("POST /check routing (real Express app + real rule engine, fake Google)", () => {
  before(async () => {
    mock.module(U("../src/auth.js"), { namedExports: { requireAllowedUser: () => (req, _res, next) => { req.userEmail = "t@dlsu.edu.ph"; next(); }, verifyAccessToken: async () => "t@dlsu.edu.ph" } });
    mock.module(U("../src/pdf.js"), { namedExports: {
      getDriveFileMimeType: async (id) => { if (!mimeById[id]) throw new Error("not found"); return mimeById[id]; },
      fetchPdfDocument: async () => ({ fullText: text, numPages: 2 }),
    } });
    mock.module(U("../src/officeConvert.js"), { namedExports: {
      GOOGLE_DOC_MIME: "application/vnd.google-apps.document",
      OFFICE_DOC_MIMES: { "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx", "application/msword": "doc" },
      ensureConvertedCopy: async (id) => ({ copyId: COPY, copyName: "My MOA (Mo check)", copyUrl: `https://docs.google.com/document/d/${COPY}/edit`, reused: false, replaced: 1 }),
    } });
    mock.module(U("../src/googleDocs.js"), { namedExports: {
      ...realDocs,
      fetchDocument: async (id) => { writes.push(["fetchDocument", id]); return doc; },
      findRangeAnywhere: (needle) => { const i = text.indexOf(needle); return i < 0 ? null : { startIndex: 1 + i, endIndex: 1 + i + needle.length, segment: "body" }; },
      highlightRange: rec("highlightRange"), addComment: rec("addComment"), addGeneralComment: rec("addGeneralComment"),
      cleanupPreviousMoComments: async (id) => { writes.push(["cleanup", id]); return { found: 0, resolved: 0 }; },
      clearAllMoHighlights: rec("clearHighlights"),
      getDismissedIssueTypes: async (id) => { writes.push(["getDismissed", id]); return []; },
      getConfirmedCorrectHashes: async () => new Set(),
      dismissIssueType: async () => [], undismissIssueType: async () => {}, resetDismissedIssues: async () => {},
      markIssueCorrect: async () => {}, unmarkIssueCorrect: async () => {}, resetConfirmedCorrect: async () => {},
      hashConfirmedPair: (t, x) => `${t}|${x}`,
    } });
    await import("../src/index.js");
    await new Promise((r) => setTimeout(r, 300));
  });
  // index.js starts listening on import and doesn't export the server, so end
  // the (per-file) test process once results have flushed.
  after(() => { setTimeout(() => process.exit(0), 250); });

  const post = (path, body) => fetch(`http://localhost:${PORT}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ accessToken: "t", ...body }) });

  test("Word file: checked and marked on the converted copy, original untouched", async () => {
    writes.length = 0;
    const res = await post("/check", { docId: SOURCE, moaType: "partnership" });
    assert.equal(res.status, 200);
    const j = await res.json();
    assert.equal(j.checkedDocId, COPY);
    assert.equal(j.conversion.sourceKind, "docx");
    assert.equal(j.conversion.copyUrl, `https://docs.google.com/document/d/${COPY}/edit`);
    assert.ok(j.issueCount > 0, "real rule engine should flag a near-empty MOA");
    assert.equal(j.writeResults.length, j.issueCount);
    const touched = new Set(writes.map(([, id]) => id));
    assert.ok(touched.has(COPY), "copy was read/written");
    assert.ok(!touched.has(SOURCE), "the original Word file must never be written to");
  });

  test("native Google Doc: same flow as before, no conversion", async () => {
    writes.length = 0;
    const j = await (await post("/check", { docId: NATIVE, moaType: "internal", csoIsParty: true })).json();
    assert.equal(j.checkedDocId, NATIVE);
    assert.equal(j.conversion, null);
    assert.ok(new Set(writes.map(([, id]) => id)).has(NATIVE));
  });

  test("PDF: still read-only, nothing written", async () => {
    writes.length = 0;
    const j = await (await post("/check", { docId: PDFID, moaType: "sponsorship", codedSelection: "coded" })).json();
    assert.equal(j.pdfMode, true);
    assert.equal(j.numPages, 2);
    assert.equal(writes.length, 0);
  });

  test("unsupported file type → clear 415", async () => {
    const res = await post("/check", { docId: "WEIRDfileID12345678", moaType: "internal" });
    assert.equal(res.status, 415);
    assert.match((await res.json()).error, /Google Docs, Word files/);
  });

  test("bad moaType → 400, bad docId → 400", async () => {
    assert.equal((await post("/check", { docId: NATIVE, moaType: "bogus" })).status, 400);
    assert.equal((await post("/check", { docId: "short", moaType: "internal" })).status, 400);
    assert.equal((await post("/archive", { docId: NATIVE, moaType: "bogus" })).status, 400);
  });

  test("malformed JSON and disallowed origin return JSON errors, not HTML", async () => {
    const bad = await fetch(`http://localhost:${PORT}/check`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{nope" });
    assert.equal(bad.status, 400);
    assert.match(bad.headers.get("content-type"), /json/);
    const cors = await fetch(`http://localhost:${PORT}/health`, { headers: { Origin: "https://evil.example" } });
    assert.equal(cors.status, 403);
    assert.match(cors.headers.get("content-type"), /json/);
  });

  test("refresh-rules: missing/wrong secret → 401, correct secret → 200", async () => {
    const url = `http://localhost:${PORT}/refresh-rules`;
    assert.equal((await fetch(url, { method: "POST" })).status, 401);
    assert.equal((await fetch(url, { method: "POST", headers: { "x-refresh-secret": "nope" } })).status, 401);
    assert.equal((await fetch(url, { method: "POST", headers: { "x-refresh-secret": "s3cret-value" } })).status, 200);
  });

});
