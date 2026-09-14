import { existsSync } from "node:fs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";

// Some deployment transports limit source-file sizes. Restore this existing
// public sample at build time so the finished deployment serves it locally.
const file = new URL("../public/assets/the-journey-of-thomas-wilson.mp4", import.meta.url);
const source = "https://raw.githubusercontent.com/bcastle1/lineage-theatre/1d758adb40fa272237d4c28a1f2d1575d4160d4b/public/assets/the-journey-of-thomas-wilson.mp4";
const expectedBytes = 17_193_754;
const expectedHash = "68f017454bf2619b972db7b062badf765829e85f0d8f315ca0f674d763bc708d";
const present = existsSync(file);
let bytes;
if (present) bytes = await readFile(file);
else {
  const response = await fetch(source, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error("The pinned public sample could not be restored. Deployment stopped.");
  bytes = Buffer.from(await response.arrayBuffer());
}
if (bytes.length !== expectedBytes || createHash("sha256").update(bytes).digest("hex") !== expectedHash)
  throw new Error("The public sample did not match its pinned checksum. Deployment stopped.");
if (!present) {
  await mkdir(new URL("../public/assets/", import.meta.url), { recursive: true });
  await writeFile(file, bytes, { flag: "wx" });
}
console.log(`Public sample ${present ? "verified" : "restored and verified"} (${expectedBytes} bytes).`);
