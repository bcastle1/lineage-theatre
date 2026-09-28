import { readFile } from "node:fs/promises";
import { put } from "@vercel/blob/client";
// The parent supplies a short-lived, one-path upload grant through stdin.
let input = "";
for await (const chunk of process.stdin) input += chunk;
const { pathname, token, path } = JSON.parse(input);
await put(pathname, await readFile(path), { token, access: "private", contentType: "video/mp4", addRandomSuffix: false });
console.log(JSON.stringify({ uploaded: true }));
