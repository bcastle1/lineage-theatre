import type { Source } from "./model";
import { api } from "./model";
import { saveSourceFile } from "../lib/storage";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

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
      file.type ||
      ({
        jpg: "image/jpeg",
        jpeg: "image/jpeg",
        png: "image/png",
        webp: "image/webp",
        mp3: "audio/mpeg",
        wav: "audio/wav",
        mp4: "video/mp4",
      }[ext || ""] ??
        "application/octet-stream"),
    size: file.size,
  };
  if (["txt", "md", "ged", "csv"].includes(ext || "")) {
    source.text = (await file.text()).slice(0, 50000);
    source.extraction = "Text read";
  } else if (ext === "docx") {
    const mammoth = await import("mammoth");
    source.text = (
      await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() })
    ).value.slice(0, 50000);
    source.extraction = source.text.trim()
      ? "Word text read"
      : "No readable text; add a caption";
  } else if (ext === "pdf") {
    const pdf = await import("pdfjs-dist");
    pdf.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
    const loading = pdf.getDocument({ data: await file.arrayBuffer() });
    const document = await loading.promise;
    try {
      const pages: string[] = [];
      for (let i = 1; i <= Math.min(document.numPages, 60); i++) {
        const page = await document.getPage(i);
        pages.push(
          (await page.getTextContent()).items
            .map((item) => ("str" in item ? item.str : ""))
            .join(" "),
        );
      }
      source.text = pages.join("\n").slice(0, 50000);
      source.extraction = source.text.trim()
        ? `Text read from ${Math.min(document.numPages, 60)} pages`
        : "Scanned PDF: add a transcription in the family story";
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
        source.extraction = "Legacy Word text read";
      } catch (e) {
        source.extraction =
          e instanceof Error
            ? e.message
            : "Legacy Word text could not be read; paste the text.";
      }
    }
  } else {
    source.extraction = source.type.startsWith("image")
      ? "Photo ready; add names, dates, or context below"
      : source.type.startsWith("audio")
        ? "Recording ready for soundtrack"
        : "Footage ready for your scenes";
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
