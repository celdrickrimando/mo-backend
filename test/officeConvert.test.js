import test from "node:test";
import assert from "node:assert/strict";
import { ensureConvertedCopy, docUrl } from "../src/officeConvert.js";

const SRC = "1AbCdEfGhIjKlMnOpQrStUvWxYz012345";
const meta = { name: "Sample MOA.docx", md5Checksum: "md5-v2", modifiedTime: "2026-10-01T00:00:00Z", parents: ["folderA"] };

// Minimal fake of the bits of the Drive client Mo uses.
function fakeDrive({ existing = [], copyFailsWithParents = false, copyError = null, trashFails = false } = {}) {
  const calls = { list: [], copy: [], update: [] };
  return {
    calls,
    files: {
      async list(args) { calls.list.push(args); return { data: { files: existing } }; },
      async copy(args) {
        calls.copy.push(JSON.parse(JSON.stringify(args)));
        if (copyError) throw copyError;
        if (copyFailsWithParents && args.requestBody.parents) {
          const e = new Error("File not found: folderA"); e.code = 404; throw e;
        }
        return { data: { id: "NEWCOPY_" + calls.copy.length + "xxxxxxxx", name: args.requestBody.name } };
      },
      async update(args) {
        calls.update.push(args);
        if (trashFails) throw new Error("nope");
        return { data: {} };
      },
    },
  };
}

test("creates a converted copy tagged with its source and fingerprint", async () => {
  const drive = fakeDrive();
  const r = await ensureConvertedCopy(SRC, "tok", meta, { drive });
  const { requestBody } = drive.calls.copy[0];
  assert.equal(requestBody.mimeType, "application/vnd.google-apps.document"); // triggers conversion
  assert.equal(requestBody.name, "Sample MOA (Mo check)");
  assert.equal(requestBody.appProperties.moSourceId, SRC);
  assert.equal(requestBody.appProperties.moSourceFp, "md5-v2");
  assert.deepEqual(requestBody.parents, ["folderA"]);
  assert.equal(r.reused, false);
  assert.equal(r.replaced, 0);
  assert.equal(r.copyUrl, docUrl(r.copyId));
});

test("reuses the existing copy while the source is unchanged (no new copy, nothing trashed)", async () => {
  const drive = fakeDrive({ existing: [{ id: "OLDCOPY_aaaaaaaaaa", name: "Sample MOA (Mo check)", appProperties: { moSourceId: SRC, moSourceFp: "md5-v2" } }] });
  const r = await ensureConvertedCopy(SRC, "tok", meta, { drive });
  assert.equal(r.reused, true);
  assert.equal(r.copyId, "OLDCOPY_aaaaaaaaaa");
  assert.equal(drive.calls.copy.length, 0);
  assert.equal(drive.calls.update.length, 0);
});

test("changed source: new copy, dismissals carried over, old copy trashed", async () => {
  const drive = fakeDrive({ existing: [{ id: "OLDCOPY_aaaaaaaaaa", name: "x", appProperties: { moSourceId: SRC, moSourceFp: "md5-v1", moDismissed: "A,B", moConfirmedCorrect: "tok1,tok2" } }] });
  const r = await ensureConvertedCopy(SRC, "tok", meta, { drive });
  const props = drive.calls.copy[0].requestBody.appProperties;
  assert.equal(props.moDismissed, "A,B");
  assert.equal(props.moConfirmedCorrect, "tok1,tok2");
  assert.equal(props.moSourceFp, "md5-v2");
  assert.deepEqual(drive.calls.update.map((u) => [u.fileId, u.requestBody.trashed]), [["OLDCOPY_aaaaaaaaaa", true]]);
  assert.equal(r.replaced, 1);
});

test("falls back to My Drive when the original's folder isn't writable", async () => {
  const drive = fakeDrive({ copyFailsWithParents: true });
  const r = await ensureConvertedCopy(SRC, "tok", meta, { drive });
  assert.equal(drive.calls.copy.length, 2);
  assert.equal(drive.calls.copy[1].requestBody.parents, undefined);
  assert.ok(r.copyId);
});

test("a failed trash of an old copy is non-fatal", async () => {
  const drive = fakeDrive({ trashFails: true, existing: [{ id: "OLDCOPY_aaaaaaaaaa", name: "x", appProperties: { moSourceFp: "stale" } }] });
  const r = await ensureConvertedCopy(SRC, "tok", meta, { drive });
  assert.equal(r.replaced, 0);
  assert.ok(r.copyId);
});

test("a failed lookup still produces a fresh copy", async () => {
  const drive = fakeDrive();
  drive.files.list = async () => { throw new Error("list blew up"); };
  const r = await ensureConvertedCopy(SRC, "tok", meta, { drive });
  assert.equal(r.reused, false);
});

test("owner-disabled copying gives an actionable message", async () => {
  const err = new Error("The user does not have sufficient permissions to copy"); err.code = 403;
  const drive = fakeDrive({ copyError: err });
  await assert.rejects(ensureConvertedCopy(SRC, "tok", { ...meta, parents: undefined }, { drive }), /can't be copied/);
});

test("rejects a malformed file id before touching Drive (no query injection)", async () => {
  const drive = fakeDrive();
  await assert.rejects(ensureConvertedCopy("x' or '1'='1", "tok", meta, { drive }), /valid Google Drive file ID/);
  assert.equal(drive.calls.list.length, 0);
});

test("falls back to modifiedTime when Drive gives no md5 (and keeps the value short)", async () => {
  const drive = fakeDrive();
  await ensureConvertedCopy(SRC, "tok", { name: "a.doc", modifiedTime: "2026-10-01T00:00:00.000Z" }, { drive });
  assert.equal(drive.calls.copy[0].requestBody.appProperties.moSourceFp, "2026-10-01T00:00:00.000Z");
  assert.equal(drive.calls.copy[0].requestBody.name, "a (Mo check)");
});
