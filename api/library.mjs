import { getSession, json, readBody, sameOrigin, limitAction } from "./_lib/auth.mjs";
import { filmLibrary, FilmLibraryError } from "./_lib/film-library.mjs";

export function createLibraryHandler({ service = filmLibrary, sessionFor = getSession, limiter = limitAction } = {}) {
  return async (req, res) => {
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("Vary", "Cookie");
    try {
      if (!["GET", "POST"].includes(req.method)) return json(res, 405, { message: "Method not allowed." });
      const session = await sessionFor(req);
      if (!session || session.user?.mustChangePassword) return json(res, 401, { message: "Sign in to view your film library." });
      if (req.method === "POST" && !sameOrigin(req)) return json(res, 403, { message: "Begin this action inside Lineage Theatre." });
      if (!(await limiter(`library-${req.method}:${session.user.email}`, req.method === "GET" ? 120 : 30, 60_000)))
        return json(res, 429, { message: "Please wait before making more film library requests." });
      const url = new URL(req.url, `https://${req.headers.host}`);
      if (req.method === "POST") {
        if (url.searchParams.size) return json(res, 400, { message: "Choose a valid film library action." });
        return json(res, 200, await service.organize(session.user, await readBody(req, 4096)));
      }
      const action = url.searchParams.get("action") || "list";
      const allowed = action === "list" ? ["action", "view", "cursor"] : action === "detail" ? ["action", "kind", "id"] : [];
      if (!allowed.length || [...url.searchParams.keys()].some(key => !allowed.includes(key) || url.searchParams.getAll(key).length !== 1))
        return json(res, 400, { message: "Choose a valid film library view." });
      if (action === "detail") return json(res, 200, await service.detail(session.user, { kind: url.searchParams.get("kind"), id: url.searchParams.get("id") }));
      return json(res, 200, await service.list(session.user, { view: url.searchParams.get("view") || "active", cursor: url.searchParams.get("cursor") || undefined }));
    } catch (error) {
      return json(res, error instanceof FilmLibraryError ? error.status : 503, {
        code: error instanceof FilmLibraryError ? error.code : "LIBRARY_UNAVAILABLE",
        message: error instanceof FilmLibraryError ? error.message : "Your film library could not complete this request. Your saved films and payments are unchanged.",
      });
    }
  };
}
export default createLibraryHandler();
