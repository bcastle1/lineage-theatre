import type { Source } from "./model";
import { api } from "./model";
import { saveSourceFile } from "../lib/storage";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { mediaFeedback, readPdfText, textFeedback } from "./source-policy.mjs";

export async function importSource(
  file: File,
  projectId: string,
): Promise<Source> {
  if (file.size > 100 * 1024 * 1024)
    throw new Error(`${file.name} exceeds the 100 MB limit.`);
  const ext = file.name.split(".").pop()?.toLowerCase();
  if (
    ![
      "jpg",
      "jpeg",
      "png",
      "webp",
      "pdf",
      "docx",
      "txt",
      "md",
      "ged",
      "csv",
      "mp3",
      "wav",
      "m4a",
      "mp4",
      "mov",
      "webm",
      "ogg",
      "doc",
    ].includes(ext || "")
  )
    throw new Error(
      `${file.name}: use a photo, PDF, Word document, text, GEDCOM, audio, or video file.`,
    );
  const source: Source = {
    id: crypto.randomUUID(),
    name: file.name,
    type:
      (file.type !== "application/octet-stream" && file.type) ||
      ({
        jpg: "image/jpeg",
        jpeg: "image/jpeg",
        png: "image/png",
        webp: "image/webp",
        pdf: "application/pdf",
        docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        doc: "application/msword",
        txt: "text/plain",
        md: "text/markdown",
        ged: "text/plain",
        csv: "text/csv",
        mp3: "audio/mpeg",
        wav: "audio/wav",
        m4a: "audio/mp4",
        ogg: "audio/ogg",
        mp4: "video/mp4",
        mov: "video/quicktime",
        webm: "video/webm",
      }[ext || ""] ??
        "application/octet-stream"),
    size: file.size,
  };
  try {
    if (["txt", "md", "ged", "csv"].includes(ext || "")) {
      source.text = await file.text();
      source.extraction = textFeedback(source.text);
    } else if (ext === "docx") {
      const mammoth = await import("mammoth");
      const result = await mammoth.extractRawText({
        arrayBuffer: await file.arrayBuffer(),
      });
      source.text = result.value;
      source.extraction = `${textFeedback(source.text, "Word text")}. Embedded pictures are not read; add them as photos with context.`;
      if (result.messages.length)
        source.extraction += ` The Word reader reported ${result.messages.length} warning${result.messages.length === 1 ? "" : "s"}; review the extracted text.`;
    } else if (ext === "pdf") {
      const pdf = await import("pdfjs-dist");
      pdf.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
      const loading = pdf.getDocument({ data: await file.arrayBuffer() });
      try {
        const document = await loading.promise;
        Object.assign(source, await readPdfText(document));
      } finally {
        await loading.destroy();
      }
    } else if (ext === "doc") {
      if (file.size > 2_500_000)
        source.extraction =
          "Legacy Word file saved; convert to DOCX to read files over 2.5 MB";
      else {
        const data = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result).split(",")[1]);
          reader.onerror = () => reject(new Error("Document could not be read."));
          reader.readAsDataURL(file);
        });
        try {
          const result = await api<{ text: string }>("/api/document", { data });
          source.text = result.text;
          source.extraction = textFeedback(source.text, "Legacy Word text");
        } catch (e) {
          source.extraction =
            e instanceof Error
              ? e.message
              : "Legacy Word text could not be read; paste the text.";
        }
      }
    } else {
      source.extraction = mediaFeedback(source.type);
    }
  } catch {
    source.extraction =
      ext === "pdf"
        ? "PDF saved, but its text could not be read. Unlock protected PDFs or add a transcription for scans."
        : "File saved, but its text could not be read. Convert it to DOCX or plain text, or add the story details manually.";
  }
  await saveSourceFile(source.id, projectId, file);
  return source;
}
export async function imageData(blob: Blob): Promise<string> {
  const image = await createImageBitmap(blob);
  const scale = Math.min(1, 1280 / Math.max(image.width, image.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(image.width * scale);
  canvas.height = Math.round(image.height * scale);
  canvas.getContext("2d")!.drawImage(image, 0, 0, canvas.width, canvas.height);
  image.close();
  return canvas.toDataURL("image/jpeg", 0.88);
}
