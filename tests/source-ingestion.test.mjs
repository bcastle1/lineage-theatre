import test from "node:test";
import assert from "node:assert/strict";
import { mediaFeedback, readPdfText, textFeedback } from "../src/studio/source-policy.mjs";

test("PDF ingestion retains evidence after page 60 and character 50,000", async () => {
  const visited = [];
  const cleaned = [];
  const result = await readPdfText({
    numPages: 72,
    async getPage(number) {
      visited.push(number);
      return {
        async getTextContent() {
          return { items: [{ str: number === 72 ? "Last-page family evidence" : "a".repeat(1000), hasEOL: true }] };
        },
        cleanup() { cleaned.push(number); },
      };
    },
  });
  assert.equal(visited.length, 72);
  assert.deepEqual(cleaned, visited);
  assert.ok(result.text.length > 50_000);
  assert.match(result.text, /\[Page 72\]\nLast-page family evidence$/);
  assert.equal(result.extraction, "PDF text read from 72 of 72 pages");
});

test("PDF missing text and failed pages are explicit while later text is preserved", async () => {
  const cleaned = [];
  const result = await readPdfText({
    numPages: 4,
    async getPage(number) {
      return {
        async getTextContent() {
          if (number === 3) throw new Error("Damaged page");
          return { items: number === 2 ? [{ type: "beginMarkedContent" }] : [{ str: `Evidence ${number}`, hasEOL: true }, { str: "Next line" }] };
        },
        cleanup() { cleaned.push(number); },
      };
    },
  });
  assert.match(result.extraction, /2 of 4 pages/);
  assert.match(result.extraction, /No extractable text on 1 page \(2\)/);
  assert.match(result.extraction, /Could not read 1 page \(3\)/);
  assert.match(result.text, /\[Page 4\]\nEvidence 4\nNext line/);
  assert.deepEqual(cleaned, [1, 2, 3, 4]);
});

test("entirely scanned PDF does not claim its content was read", async () => {
  const result = await readPdfText({
    numPages: 1,
    async getPage() {
      return { async getTextContent() { return { items: [] }; }, cleanup() {} };
    },
  });
  assert.equal(result.text, "");
  assert.match(result.extraction, /0 of 1 pages/);
  assert.match(result.extraction, /scans and pictures need a transcription or context/);
});

test("feedback distinguishes empty text from extracted text and media understanding", () => {
  assert.match(textFeedback(" \n\t"), /No readable text/);
  assert.equal(textFeedback("a".repeat(75_001)), "Text: 75,001 characters read");
  assert.match(mediaFeedback("image/jpeg"), /names, dates, and relationships/);
  assert.match(mediaFeedback("audio/mp4"), /has not been transcribed/);
  assert.match(mediaFeedback("video/quicktime"), /have not been analyzed/);
});
