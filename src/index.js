import express from "express";
import cors from "cors";
import { fetchDocument, findRangeForText, highlightRange, addComment } from "./googleDocs.js";
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
  const { docId, moaType, accessToken } = req.body;

  if (!docId || !moaType || !accessToken) {
    return res.status(400).json({ error: "docId, moaType, and accessToken are required." });
  }

  try {
    const { runs, fullText, footers, pageSize } = await fetchDocument(docId, accessToken);
    const { issues, leadTime } = await runAllChecks(fullText, moaType, { runs, footers, pageSize });

    // Write highlights + comments back into the doc for each issue we can locate.
    const writeResults = [];
    let markedCount = 0;
    let unmarkedCount = 0;

    for (const issue of issues) {
      const range = findRangeForText(runs, issue.text);
      if (!range) {
        writeResults.push({ issue: issue.type, message: issue.message, written: false, reason: "text not found in doc" });
        unmarkedCount++;
        continue;
      }
      try {
        await highlightRange(docId, accessToken, range);
        await addComment(docId, accessToken, range, issue.message);
        writeResults.push({ issue: issue.type, message: issue.message, written: true });
        markedCount++;
      } catch (err) {
        writeResults.push({ issue: issue.type, message: issue.message, written: false, reason: err.message });
        unmarkedCount++;
      }
    }

    if (issues.length === 0) {
      // Drop a single confirmation comment at the top of the doc.
      if (runs[0]) {
        try {
          await addComment(
            docId,
            accessToken,
            { startIndex: runs[0].startIndex, endIndex: runs[0].startIndex + 1 },
            `Mo says a-ok. No issues found in this MOA. ${AFTERWORD}`
          );
        } catch {
          // non-fatal — extension still reports a-ok even if the comment write fails
        }
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
