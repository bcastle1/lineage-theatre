export function textFeedback(text, label = "Text") {
  return text.trim()
    ? `${label}: ${text.length.toLocaleString("en-US")} characters read`
    : "No readable text found; add a transcription or source context";
}

export function mediaFeedback(type) {
  if (type.startsWith("image/"))
    return "Photo saved; add names, dates, and relationships for accurate story context.";
  if (type.startsWith("audio/"))
    return "Audio saved; speech has not been transcribed. Add a transcript to use its story details.";
  return "Video saved; scenes and dialogue have not been analyzed. Add a summary or transcript to use its story details.";
}

function pageList(pages) {
  return pages.slice(0, 8).join(", ") + (pages.length > 8 ? ` and ${pages.length - 8} more` : "");
}

// Read every page. A missing text layer on one page must not discard later evidence.
export async function readPdfText(document) {
  const sections = [];
  const emptyPages = [];
  const failedPages = [];
  for (let number = 1; number <= document.numPages; number++) {
    let page;
    try {
      page = await document.getPage(number);
      const content = await page.getTextContent();
      const text = content.items
        .filter((item) => typeof item.str === "string")
        .map((item) => `${item.str}${item.hasEOL ? "\n" : " "}`)
        .join("")
        .trim();
      if (text) sections.push(`[Page ${number}]\n${text}`);
      else emptyPages.push(number);
    } catch {
      failedPages.push(number);
    } finally {
      page?.cleanup();
    }
  }
  const warnings = [];
  if (emptyPages.length)
    warnings.push(`No extractable text on ${emptyPages.length} page${emptyPages.length === 1 ? "" : "s"} (${pageList(emptyPages)}); scans and pictures need a transcription or context.`);
  if (failedPages.length)
    warnings.push(`Could not read ${failedPages.length} page${failedPages.length === 1 ? "" : "s"} (${pageList(failedPages)}); add their text separately.`);
  return {
    text: sections.join("\n\n"),
    extraction: [
      `PDF text read from ${sections.length} of ${document.numPages} pages`,
      ...warnings,
    ].join(". "),
  };
}
