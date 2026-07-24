import express from "express";
import cors from "cors";
import { fetchDocument, findRangeAnywhere, highlightRange, addComment, addGeneralComment } from "./googleDocs.js";
import { runAllChecks } from "./rules/index.js";
import { clearRulesCache } from "./rulesSheet.js";

// EDIT ME: shown after "Mo says a-ok" both in the Google Doc comment and in
// the extension popup. Replace with whatever closing note your Committee wants.
const AFTERWORD = "You may now proceed to submit this MOA to the MNL Committee.";

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 8787;

app.post("/check", async (req, res) => {
  const { docId, moaType, accessToken, codedSelection } = req.body;

  if (!docId || !moaType || !accessToken) {
    return res.status(400).json({ error: "docId, moaType, and accessToken are required." });
  }

  // codedSelection ("coded" | "non_coded") is only meaningful for
  // Sponsorship — the popup's precautionary pre-check toggle described in
  // moa.md. Ignore it for other MOA types rather than trusting the client.
  const effectiveCodedSelection = moaType === "sponsorship" ? codedSelection : undefined;

  try {
    const { runs, fullText, footers, headers, pageSize, headerText } = await fetchDocument(docId, accessToken);
    const { issues, leadTime } = await runAllChecks(fullText, moaType, {
      runs,
      footers,
      pageSize,
      headerText,
      codedSelection: effectiveCodedSelection,
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
      const match = issue.text ? findRangeAnywhere(issue.text, { runs, footers, headers }) : null;

      if (match && match.segment === "body") {
        try {
          await highlightRange(docId, accessToken, match);
          await addComment(docId, accessToken, match, issue.message);
          writeResults.push({ issue: issue.type, message: issue.message, written: true });
          markedCount++;
        } catch (err) {
          writeResults.push({ issue: issue.type, message: issue.message, written: false, reason: err.message });
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
            written: true,
            reason: `highlighted in the ${match.segment}; comment quotes the exact text (Drive comments can't anchor into a ${match.segment} the way they can in the body)`,
          });
          markedCount++;
        } catch (err) {
          writeResults.push({ issue: issue.type, message: issue.message, written: false, reason: err.message });
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
          written: true,
          reason: "general comment — couldn't pinpoint an exact location in the document",
        });
        markedCount++;
      } catch (err) {
        writeResults.push({ issue: issue.type, message: issue.message, written: false, reason: err.message });
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
});
