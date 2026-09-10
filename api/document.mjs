import WordExtractor from "word-extractor";
import {
  json,
  getSession,
  readBody,
  sameOrigin,
  limitAction,
} from "./_lib/auth.mjs";
export default async function handler(req, res) {
  if (req.method !== "POST")
    return json(res, 405, { message: "Method not allowed." });
  if (!sameOrigin(req))
    return json(res, 403, {
      message: "Upload the document inside Lineage Theatre.",
    });
  const session = await getSession(req);
  if (!session)
    return json(res, 401, { message: "Sign in to read this document." });
  try {
    if (!(await limitAction(`document:${session.user.email}`, 30, 3600_000)))
      return json(res, 429, {
        message: "Document reading limit reached. Try again later.",
      });
    const body = await readBody(req, 3_500_000);
    if (
      typeof body.data !== "string" ||
      !/^([A-Za-z0-9+/]+={0,2})$/.test(body.data)
    )
      return json(res, 400, {
        message: "The Word document could not be read.",
      });
    const buffer = Buffer.from(body.data, "base64");
    if (buffer.length > 2_500_000)
      return json(res, 400, {
        message:
          "Legacy Word documents must be under 2.5 MB. Convert larger files to DOCX.",
      });
    const doc = await new WordExtractor().extract(buffer);
    return json(res, 200, { text: doc.getBody().slice(0, 50000) });
  } catch {
    return json(res, 400, {
      message:
        "This legacy Word file could not be read. Convert it to DOCX or paste the text.",
    });
  }
}
