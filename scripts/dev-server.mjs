import { createServer as viteServer } from "vite";
import { createServer } from "node:http";
import auth from "../api/auth.mjs";
import studio from "../api/studio.mjs";
import document from "../api/document.mjs";
const vite = await viteServer({
  server: { middlewareMode: true },
  appType: "spa",
});
createServer(async (req, res) => {
  try {
    const path = new URL(req.url, "http://localhost").pathname;
    if (path === "/api/auth") return await auth(req, res);
    if (path === "/api/studio") return await studio(req, res);
    if (path === "/api/document") return await document(req, res);
    vite.middlewares(req, res);
  } catch {
    res.statusCode = 500;
    res.end("Local server error");
  }
}).listen(5173, "127.0.0.1", () =>
  console.log("Lineage dev server http://127.0.0.1:5173"),
);
