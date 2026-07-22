import express from "express";
import cors from "cors";
import { fetchDocument, findRangeForText, highlightRange, addComment } from "./googleDocs.js";
import { runAllChecks } from "./rules/index.js";

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
    const { runs, fullText } = await fetchDocument(docId, accessToken);
    const { issues, leadTime } = runAllChecks(fullText, moaType);

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
            "Mo says a-ok. No issues found in this MOA."
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

app.listen(PORT, () => {
  console.log(`Mo backend listening on http://localhost:${PORT}`);
});
