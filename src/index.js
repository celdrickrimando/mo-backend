import express from "express";
import cors from "cors";
import {
  fetchDocument,
  findRangeAnywhere,
  highlightRange,
  addComment,
  addGeneralComment,
  cleanupPreviousMoComments,
  clearAllMoHighlights,
  getDismissedIssueTypes,
  dismissIssueType,
  undismissIssueType,
  resetDismissedIssues,
  getConfirmedCorrectHashes,
  markIssueCorrect,
  unmarkIssueCorrect,
  resetConfirmedCorrect,
  hashConfirmedPair,
} from "./googleDocs.js";
import { fetchPdfDocument, getDriveFileMimeType } from "./pdf.js";
import { runAllChecks } from "./rules/index.js";
import { clearRulesCache } from "./rulesSheet.js";
import { requireAllowedUser } from "./auth.js";
import rateLimit from "express-rate-limit";

// EDIT ME: shown after "Mo says a-ok" both in the Google Doc comment and in
// the extension popup. Replace with whatever closing note your Committee wants.
const AFTERWORD = "You may now proceed to submit this MOA to the MNL Committee.";

// A real Google Docs/Drive file ID is always this charset. Rejecting
// anything else up front means a malformed/hostile docId never reaches the
// googleapis client at all.
const DOC_ID_RE = /^[a-zA-Z0-9_-]{10,100}$/;

// Requests from the extension's popup carry a chrome-extension:// origin,
// which is always allowed. ALLOWED_ORIGINS lets you additionally allow a
// specific web origin (e.g. while testing a hosted popup) — leave unset in
// production so the only caller that can reach this API from a browser
// context is the extension itself.
const extraAllowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const app = express();
app.use(
  cors({
    origin(origin, callback) {
      // No Origin header at all (server-to-server, curl, health checks)
      // isn't something CORS can restrict anyway — the real access control
      // is the per-user token check in auth.js, not this.
      if (!origin) return callback(null, true);
      if (origin.startsWith("chrome-extension://")) return callback(null, true);
      if (extraAllowedOrigins.includes(origin)) return callback(null, true);
      callback(new Error("Not allowed by CORS"));
    },
  })
);
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 8787;

// Every /check run makes several Docs/Drive API calls per request, so a
// single misbehaving client (buggy retry loop, or someone hammering the
// API directly with a stolen/expired token) could burn through Google's
// per-user quota fast. This is a coarse per-IP cap, not a substitute for
// the identity check in auth.js — it's there to blunt abuse/DoS, not to
// decide who's allowed in.
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests — please wait a moment and try again." },
});

app.post("/check", apiLimiter, requireAllowedUser(), async (req, res) => {
  const { docId, moaType, accessToken, codedSelection, csoIsParty, witnessedByOnlyMode } = req.body;

  if (!docId || !moaType || !accessToken) {
    return res.status(400).json({ error: "docId, moaType, and accessToken are required." });
  }
  if (!DOC_ID_RE.test(docId)) {
    return res.status(400).json({ error: "docId doesn't look like a valid Google Drive file ID." });
  }

  // codedSelection ("coded" | "non_coded") is only meaningful for
  // Sponsorship — the popup's precautionary pre-check toggle described in
  // moa.md. Ignore it for other MOA types rather than trusting the client.
  const effectiveCodedSelection = moaType === "sponsorship" ? codedSelection : undefined;

  // csoIsParty (boolean) is only meaningful for Internal MOAs — whether
  // DLSU-SLIFE-CSO itself is one of the two signing parties, vs. a MOA
  // between two other SLIFE-recognized orgs where CSO only witnesses.
  // Same reasoning as codedSelection: ignore it for other MOA types rather
  // than trusting the client to have left it out.
  const effectiveCsoIsParty = moaType === "internal" ? csoIsParty : undefined;

  // witnessedByOnlyMode (boolean) — Internal only, and only meaningful for
  // the "[CSO ORG/MAIN]-[NON CSO ORG]" sub-option when CSO ORG/MAIN was
  // the one INVITED (not the one inviting). In that case the standard MOA
  // format isn't expected to hold at all, so runAllChecks short-circuits
  // to a single placement check instead of the full pipeline. Same
  // trust-the-server-not-the-client reasoning as codedSelection/csoIsParty
  // above.
  const effectiveWitnessedByOnlyMode = moaType === "internal" ? !!witnessedByOnlyMode : false;

  // Figure out whether this Drive file is a native Google Doc or a PDF
  // before deciding which flow to run. Any other mimeType (e.g. an
  // uploaded .docx that was never converted) still falls through to
  // fetchDocument()'s existing "must not be an Office file" error.
  let mimeType;
  try {
    ({ mimeType } = await getDriveFileMimeType(docId, accessToken));
  } catch (err) {
    return res.status(500).json({ error: `Could not read this file from Drive: ${err.message}` });
  }

  if (mimeType === "application/pdf") {
    try {
      const { fullText, numPages } = await fetchPdfDocument(docId, accessToken);
      // witnessedByOnlyMode relies on table/run structure (tableColumn,
      // signatory-block position) that PDFs simply don't have available
      // (fetchPdfDocument returns flattened text only, no `runs`) — running
      // it here would silently return zero issues ("a-ok") whether or not
      // the two names are actually there. Rather than give a false pass,
      // fall back to the normal full Internal check for PDFs; the reviewer
      // still needs to look regardless of this toggle for a read-only file.
      const { issues, leadTime } = await runAllChecks(fullText, moaType, {
        codedSelection: effectiveCodedSelection,
        csoIsParty: effectiveCsoIsParty,
        pdfMode: true,
      });

      // PDFs are read-only in Phase 1 — no highlight/comment writes.
      // Every issue is just reported back to the popup, with a shared
      // pdfMode flag so the popup can render an appropriate "read-only,
      // review manually" framing instead of "marked/unmarked in doc".
      return res.json({
        pdfMode: true,
        numPages,
        issueCount: issues.length,
        writeResults: issues.map((issue) => ({
          issue: issue.type,
          message: issue.message,
          written: false,
          reason: "PDF checks are read-only in this version — review and fix manually, then re-check.",
        })),
        afterword: issues.length === 0 ? AFTERWORD : null,
        leadTimeOk: leadTime.leadTimeOk,
        leadTimeDays: leadTime.leadTimeDays,
        requiredLeadTimeDays: leadTime.requiredLeadTimeDays,
        leadTimeNote: leadTime.note || null,
      });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: err.message });
    }
  }

  try {
    let cleanup = { found: 0, resolved: 0 };
    try {
      cleanup = await cleanupPreviousMoComments(docId, accessToken);
    } catch (err) {
      // Non-fatal — if cleanup fails (e.g. transient Drive API error), the
      // check should still run; the user just may see one extra stale
      // comment this round, not a broken check.
      console.error("cleanupPreviousMoComments failed:", err.message);
    }

    const { doc, runs, images, pageBreaks, fullText, footers, headers, pageSize, headerText } = await fetchDocument(docId, accessToken);

    try {
      await clearAllMoHighlights(docId, accessToken, doc);
    } catch (err) {
      // Non-fatal, same reasoning as the comment cleanup above — a
      // transient failure here shouldn't block the check itself.
      console.error("clearAllMoHighlights failed:", err.message);
    }

    const { issues: allIssues, leadTime } = await runAllChecks(fullText, moaType, {
      runs,
      images,
      pageBreaks,
      footers,
      pageSize,
      headerText,
      codedSelection: effectiveCodedSelection,
      csoIsParty: effectiveCsoIsParty,
      witnessedByOnlyMode: effectiveWitnessedByOnlyMode,
    });

    let dismissedTypes = [];
    try {
      dismissedTypes = await getDismissedIssueTypes(docId, accessToken);
    } catch (err) {
      // Non-fatal — worst case, a manually-resolved issue reappears once
      // more instead of the check itself failing.
      console.error("getDismissedIssueTypes failed:", err.message);
    }

    // Per-instance "mark correct, don't flag again" (Mo_Handoff_Notes.md
    // section C) — distinct from dismissedTypes above, which mutes a whole
    // issue TYPE. This mutes one specific (type, flaggedText) pair, so
    // confirming e.g. one name's bold formatting doesn't hide a real bold
    // violation on a different name elsewhere in the same document.
    let confirmedCorrectHashes = new Set();
    try {
      confirmedCorrectHashes = await getConfirmedCorrectHashes(docId, accessToken);
    } catch (err) {
      // Non-fatal, same reasoning as getDismissedIssueTypes above.
      console.error("getConfirmedCorrectHashes failed:", err.message);
    }

    const issues = allIssues.filter((issue) => {
      if (dismissedTypes.includes(issue.type)) return false;
      if (confirmedCorrectHashes.size && confirmedCorrectHashes.has(hashConfirmedPair(issue.type, issue.text))) return false;
      return true;
    });

    // Write highlights + comments back into the doc for each issue,
    // individually — never merged into one combined comment, so a
    // reviewer can tell at a glance which exact phrase each note is
    // about.
    //
    // Three cases per issue, in order of preference:
    //  1. Text found in the body -> highlight + a real anchored comment
    //     on that exact range (as before).
    //  2. Text found in a footer/header -> those are a separate index
    //     space from the body (Docs API's segmentId), so we highlight
    //     the exact phrase there directly (highlightRange supports
    //     segmentId), but the comment itself is added as a plain,
    //     unanchored note that quotes the flagged text — anchoring a
    //     Drive comment into a footer/header segment isn't supported by
    //     the same body-relative anchor format, so this keeps the note
    //     accurate rather than silently mis-anchoring it.
    //  3. Text not found anywhere (e.g. something required is missing
    //     entirely) -> a plain, unanchored, INDIVIDUAL comment per issue,
    //     still quoting whatever identifying text is available.
    // Previously, every case-2/3 issue was dumped together into one
    // single comment fake-anchored to the first character of the
    // document body — which read as one wall of unrelated notes, and
    // which Google Docs would often render as "Original content deleted"
    // once the doc changed at all after that anchor was created.
    const writeResults = [];
    let markedCount = 0;
    let unmarkedCount = 0;

    for (const issue of issues) {
      // Some checks (e.g. constant signatory placement) already know the
      // EXACT absolute Docs range they mean — e.g. a specific occurrence
      // in one of two identical-looking table columns, or a specific "By:"
      // marker among several identical ones. A plain text search for
      // issue.text via findRangeAnywhere would happily match the FIRST
      // occurrence anywhere in the doc, which for repeated markers like
      // "By:"/"Witnessed by:" is frequently the WRONG one. When a check
      // supplies issue.location, trust it outright instead of re-deriving
      // a (possibly wrong) location from text search.
      const match = issue.location
        ? { startIndex: issue.location.startIndex, endIndex: issue.location.endIndex, segment: issue.location.segment || "body", ...(issue.location.segmentId ? { segmentId: issue.location.segmentId } : {}) }
        : issue.text
        ? findRangeAnywhere(issue.text, { runs, footers, headers })
        : null;

      if (match && match.segment === "body") {
        try {
          await highlightRange(docId, accessToken, match);
          await addComment(docId, accessToken, match, issue.message);
          writeResults.push({ issue: issue.type, message: issue.message, text: issue.text ?? null, written: true });
          markedCount++;
        } catch (err) {
          writeResults.push({ issue: issue.type, message: issue.message, text: issue.text ?? null, written: false, reason: err.message });
          unmarkedCount++;
        }
        continue;
      }

      if (match && (match.segment === "footer" || match.segment === "header")) {
        try {
          await highlightRange(docId, accessToken, match);
          await addGeneralComment(
            docId,
            accessToken,
            `Regarding the ${match.segment} text "${issue.text}":\n\n${issue.message}`
          );
          writeResults.push({
            issue: issue.type,
            message: issue.message,
            text: issue.text ?? null,
            written: true,
            reason: `highlighted in the ${match.segment}; comment quotes the exact text (Drive comments can't anchor into a ${match.segment} the way they can in the body)`,
          });
          markedCount++;
        } catch (err) {
          writeResults.push({ issue: issue.type, message: issue.message, text: issue.text ?? null, written: false, reason: err.message });
          unmarkedCount++;
        }
        continue;
      }

      // Not locatable anywhere — still its own individual comment, not
      // merged with any other issue, quoting the identifying text when
      // there is any.
      try {
        const note = issue.text
          ? `Regarding "${issue.text}":\n\n${issue.message}`
          : issue.message;
        await addGeneralComment(docId, accessToken, note);
        writeResults.push({
          issue: issue.type,
          message: issue.message,
          text: issue.text ?? null,
          written: true,
          reason: "general comment — couldn't pinpoint an exact location in the document",
        });
        markedCount++;
      } catch (err) {
        writeResults.push({ issue: issue.type, message: issue.message, text: issue.text ?? null, written: false, reason: err.message });
        unmarkedCount++;
      }
    }

    if (issues.length === 0) {
      // Drop a single confirmation comment, unanchored (nothing to point at).
      try {
        await addGeneralComment(docId, accessToken, `Mo says a-ok. No issues found in this MOA. ${AFTERWORD}`);
      } catch {
        // non-fatal — extension still reports a-ok even if the comment write fails
      }
    }

    res.json({
      issueCount: issues.length,
      markedCount,
      unmarkedCount,
      commentsCleanedUp: cleanup.resolved, // NEW
      afterword: issues.length === 0 ? AFTERWORD : null,
      leadTimeOk: leadTime.leadTimeOk,
      leadTimeDays: leadTime.leadTimeDays,
      requiredLeadTimeDays: leadTime.requiredLeadTimeDays,
      leadTimeNote: leadTime.note || null,
      writeResults,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/health", (_req, res) => res.json({ ok: true }));

// Lets the popup permanently mute a "please check manually" issue for one
// specific document once a reviewer has confirmed it by eye, so it stops
// being re-raised (and re-commented/highlighted) on every future check of
// that same doc. Only issue types in DISMISSIBLE_ISSUE_CODES (googleDocs.js)
// are eligible — anything the rule engine treats as a hard pass/fail can't
// be muted this way.
app.post("/dismiss-issue", apiLimiter, requireAllowedUser(), async (req, res) => {
  const { docId, accessToken, issueType } = req.body;
  if (!docId || !accessToken || !issueType) {
    return res.status(400).json({ error: "docId, accessToken, and issueType are required." });
  }
  if (!DOC_ID_RE.test(docId)) {
    return res.status(400).json({ error: "docId doesn't look like a valid Google Drive file ID." });
  }
  try {
    const dismissed = await dismissIssueType(docId, accessToken, issueType);
    res.json({ dismissed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Lets the popup mark one specific flagged INSTANCE as correct so /check
// stops re-raising it — usable on any issue, not just the 5
// DISMISSIBLE_ISSUE_CODES types. Unlike /dismiss-issue (which mutes a
// whole type for the document), this only mutes the exact (issueType,
// text) pair, so a real violation elsewhere in the same document under
// the same issue type still gets flagged normally. Self-healing: if the
// flagged text later changes, the stored hash naturally stops matching
// and the check re-evaluates that spot from scratch. See
// Mo_Handoff_Notes.md section C.
app.post("/mark-correct", apiLimiter, requireAllowedUser(), async (req, res) => {
  const { docId, accessToken, issueType, text } = req.body;
  if (!docId || !accessToken || !issueType) {
    return res.status(400).json({ error: "docId, accessToken, and issueType are required." });
  }
  if (!DOC_ID_RE.test(docId)) {
    return res.status(400).json({ error: "docId doesn't look like a valid Google Drive file ID." });
  }
  try {
    await markIssueCorrect(docId, accessToken, issueType, text ?? "");
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Friendly fallback labels for the dismissible "manual check" types, used
// in the archive panel ONLY when that type isn't currently detected in the
// document at all (so there's no live issue.message to borrow instead) —
// e.g. the reviewer dismissed it, then the underlying thing got fixed, but
// they haven't reset the dismissal yet. Keeps the archive panel readable
// instead of showing a raw snake_case type string.
const DISMISSIBLE_TYPE_FALLBACK_LABELS = {
  signatory_block_page_break_needs_manual_check: "Signatory block page-break placement (manual check)",
  witness_whereof_page_break_needs_manual_check: "\"IN WITNESS WHEREOF...\" page-break placement (manual check)",
  top_right_code_needs_manual_check: "Top-right code (manual check)",
  signatory_block_page_fit_unknown: "Signatory block page fit (manual check)",
  gtc_section_not_found: "GTC section not found (manual check)",
  event_date_format_unclear: "Event date format (manual check)",
  constant_signatory_position_needs_manual_check: "Constant signatory position text (manual check)",
};

// Lists everything currently dismissed/confirmed-correct for this
// document, so the popup's archive panel can show it with a per-row
// "Restore" button. Deliberately re-derives display text from a FRESH,
// UNFILTERED check rather than storing the original flagged text anywhere
// — see the chat discussion this was designed in: storing raw text
// wouldn't fit Drive's small appProperties value cap, and a hidden
// companion file/appDataFolder would need a new OAuth scope (real friction
// now that the app is published, not just in Testing). The tradeoff: an
// entry only shows up here while its underlying text is STILL present,
// unchanged, in the document — once actually fixed, it has nothing left
// to show and drops out of the archive on its own (which is fine: there's
// nothing meaningful left to "restore" for something that no longer
// exists in the doc anyway).
app.post("/archive", apiLimiter, requireAllowedUser(), async (req, res) => {
  const { docId, moaType, accessToken, codedSelection, csoIsParty, witnessedByOnlyMode } = req.body;
  if (!docId || !moaType || !accessToken) {
    return res.status(400).json({ error: "docId, moaType, and accessToken are required." });
  }
  if (!DOC_ID_RE.test(docId)) {
    return res.status(400).json({ error: "docId doesn't look like a valid Google Drive file ID." });
  }

  try {
    const { fullText, runs, images, pageBreaks, footers, pageSize, headerText } = await fetchDocument(docId, accessToken);
    const { issues: allIssues } = await runAllChecks(fullText, moaType, {
      runs,
      images,
      pageBreaks,
      footers,
      pageSize,
      headerText,
      codedSelection: moaType === "sponsorship" ? codedSelection : undefined,
      csoIsParty: moaType === "internal" ? csoIsParty : undefined,
      witnessedByOnlyMode: moaType === "internal" ? !!witnessedByOnlyMode : false,
    });

    const [dismissedTypes, confirmedCorrectHashes] = await Promise.all([
      getDismissedIssueTypes(docId, accessToken),
      getConfirmedCorrectHashes(docId, accessToken),
    ]);

    const archive = [];

    for (const issueType of dismissedTypes) {
      const liveMatch = allIssues.find((i) => i.type === issueType);
      archive.push({
        kind: "type",
        issueType,
        text: liveMatch?.text ?? null,
        message: liveMatch?.message ?? DISMISSIBLE_TYPE_FALLBACK_LABELS[issueType] ?? issueType,
      });
    }

    for (const hash of confirmedCorrectHashes) {
      const liveMatch = allIssues.find((i) => hashConfirmedPair(i.type, i.text) === hash);
      if (!liveMatch) continue; // self-healed since — nothing left to show or restore
      archive.push({
        kind: "instance",
        issueType: liveMatch.type,
        text: liveMatch.text,
        message: liveMatch.message,
        hash,
      });
    }

    res.json({ archive });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Reverses a single archived entry — the per-row "Restore" button in the
// archive panel. kind "type" un-mutes a whole DISMISSIBLE_ISSUE_CODES
// type (needs issueType); kind "instance" un-mutes one confirmed-correct
// occurrence (needs the hash token the /archive response already gave
// the popup for that row).
app.post("/restore-issue", apiLimiter, requireAllowedUser(), async (req, res) => {
  const { docId, accessToken, kind, issueType, hash } = req.body;
  if (!docId || !accessToken || !kind) {
    return res.status(400).json({ error: "docId, accessToken, and kind are required." });
  }
  if (!DOC_ID_RE.test(docId)) {
    return res.status(400).json({ error: "docId doesn't look like a valid Google Drive file ID." });
  }

  try {
    if (kind === "type") {
      if (!issueType) return res.status(400).json({ error: "issueType is required for kind \"type\"." });
      await undismissIssueType(docId, accessToken, issueType);
    } else if (kind === "instance") {
      if (!hash) return res.status(400).json({ error: "hash is required for kind \"instance\"." });
      await unmarkIssueCorrect(docId, accessToken, hash);
    } else {
      return res.status(400).json({ error: 'kind must be "type" or "instance".' });
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Un-mutes every previously dismissed issue type AND every confirmed-
// correct instance for this document, so future checks go back to
// raising all of them again — one combined "reset all my overrides for
// this doc" action (see Mo_Handoff_Notes.md section C, open question).
app.post("/reset-dismissed-issues", apiLimiter, requireAllowedUser(), async (req, res) => {
  const { docId, accessToken } = req.body;
  if (!docId || !accessToken) {
    return res.status(400).json({ error: "docId and accessToken are required." });
  }
  if (!DOC_ID_RE.test(docId)) {
    return res.status(400).json({ error: "docId doesn't look like a valid Google Drive file ID." });
  }
  try {
    await resetDismissedIssues(docId, accessToken);
    try {
      await resetConfirmedCorrect(docId, accessToken);
    } catch (err) {
      // Non-fatal on its own — the type-level dismissals above already
      // cleared successfully; don't fail the whole reset over the second
      // (independent) appProperties value.
      console.error("resetConfirmedCorrect failed:", err.message);
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Manually clear the rules-sheet cache so a just-edited sheet takes
// effect immediately instead of waiting for the ~15 second TTL to expire.
// Optional protection: if REFRESH_RULES_SECRET is set as an env var, this
// requires a matching "x-refresh-secret" header — otherwise it's left
// open, since this only clears a cache (it can never read or write
// anything sensitive) and the TTL is already short enough that abuse
// has minimal impact either way.
app.post("/refresh-rules", (req, res) => {
  const requiredSecret = process.env.REFRESH_RULES_SECRET;
  if (requiredSecret && req.headers["x-refresh-secret"] !== requiredSecret) {
    return res.status(401).json({ error: "Invalid or missing x-refresh-secret header." });
  }
  clearRulesCache();
  res.json({ ok: true, message: "Rules cache cleared — next check will re-fetch the sheet." });
});

app.listen(PORT, () => {
  console.log(`Mo backend listening on http://localhost:${PORT}`);
  if (!process.env.REFRESH_RULES_SECRET) {
    console.warn(
      "WARNING: REFRESH_RULES_SECRET is not set — POST /refresh-rules is open to anyone. Set it in your environment to require the x-refresh-secret header."
    );
  }
  if (!process.env.ALLOWED_EMAIL_DOMAIN && !process.env.ALLOWED_EMAILS) {
    console.warn(
      "NOTE: ALLOWED_EMAIL_DOMAIN/ALLOWED_EMAILS aren't set — falling back to the built-in default (@dlsu.edu.ph + celdrickrimando@gmail.com). Set them explicitly in production."
    );
  }
});
