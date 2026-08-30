import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(() => {
  const runtime = globalThis as typeof globalThis & { process?: { env?: Record<string, string | undefined> } };
  const buildEnvironment = runtime.process?.env ?? {};
  const buildCommit = buildEnvironment.VERCEL_GIT_COMMIT_SHA || buildEnvironment.GITHUB_SHA || "local";

  return {
    define: {
      __BUILD_COMMIT__: JSON.stringify(buildCommit),
    },
    plugins: [
      react(),
      {
        name: "lineage-build-marker",
        transformIndexHtml(html: string) {
          return html.replace("</head>", `    <meta name="lineage-build" content="${buildCommit}" />\n  </head>`);
        },
      },
    ],
    server: {
      host: "127.0.0.1",
      port: 5173,
    },
  };
});
