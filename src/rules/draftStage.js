// Draft-stage checks — MOAs being drafted/reviewed in Google Docs must
// not yet contain an actual signature; the signatory block should only
// have the printed name/title under a blank "By:" line at this stage.
//
// Detection is scoped to INLINE IMAGES located at/after the
// "IN WITNESS WHEREOF" anchor, since that's where every MOA's signatory
// block lives (see checkOnePageSignatoryBlock in shared.js for the same
// anchor). See MO_NEXT_STEPS.md Feature 2 for the full reasoning and
// known limitations (won't catch positioned/floating images, and won't
// catch a "signature" that's actually just stylized typed text).

export function checkNoSignaturesInDraft(fullText, runs, images) {
  const issues = [];
  if (!images || images.length === 0) return issues;

  const anchorText = "IN WITNESS WHEREOF";
  const anchorIdx = fullText.indexOf(anchorText);
  if (anchorIdx === -1) return issues; // missing_required_section already flags this elsewhere

  // Map the fullText character offset of the anchor to its absolute
  // Docs API index by walking `runs` the same way findRangeForText does
  // (fullText is just the concatenation of runs[].text in order).
  let charsSeen = 0;
  let anchorAbsoluteIndex = null;
  for (const run of runs) {
    if (charsSeen + run.text.length > anchorIdx) {
      anchorAbsoluteIndex = run.startIndex + (anchorIdx - charsSeen);
      break;
    }
    charsSeen += run.text.length;
  }
  if (anchorAbsoluteIndex === null) return issues; // shouldn't happen, but don't crash if it does

  const imagesInSignatoryBlock = images.filter((img) => img.startIndex >= anchorAbsoluteIndex);
  if (imagesInSignatoryBlock.length > 0) {
    issues.push({
      type: "signature_present_in_draft",
      text: anchorText,
      message: `Found ${imagesInSignatoryBlock.length} inserted image${
        imagesInSignatoryBlock.length === 1 ? "" : "s"
      } in the signatory block. Draft MOAs must not yet contain actual signatures — this looks like it may already be signed. Please confirm and remove any signature image before this is reviewed as a draft.`,
    });
  }

  return issues;
}
