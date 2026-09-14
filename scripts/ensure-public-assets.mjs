import { existsSync } from "node:fs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";

// Restore existing public media omitted by size-limited deployment transports.
// The finished deployment contains and serves these files locally.
const base = "https://raw.githubusercontent.com/bcastle1/lineage-theatre/1d758adb40fa272237d4c28a1f2d1575d4160d4b/public/assets/";
const assets = [
  ["the-journey-of-thomas-wilson.mp4", 17_193_754, "68f017454bf2619b972db7b062badf765829e85f0d8f315ca0f674d763bc708d"],
  ["ancestor-shipyard-still.png", 2_110_943, "8283fec9fb7ef82a4e862847bddd5ed1fb3096079a924025ecc685d7745cd989"],
  ["concept-admin.png", 1_536_906, "7ebe7e9c630af227aaf3f136e8238e59b47944344d6b2c425b6f4f437e0aea28"],
  ["concept-creator.png", 1_557_442, "d0a0edd75e653412530cf99f91e7b72e9fe110da2591f2b2cb48dba316a0d399"],
];
await Promise.all(assets.map(async ([name, expectedBytes, expectedHash]) => {
const file = new URL(`../public/assets/${name}`, import.meta.url);
const present = existsSync(file);
let bytes;
if (present) bytes = await readFile(file);
else {
  const response = await fetch(base + name, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`Pinned media ${name} could not be restored. Deployment stopped.`);
  bytes = Buffer.from(await response.arrayBuffer());
}
if (bytes.length !== expectedBytes || createHash("sha256").update(bytes).digest("hex") !== expectedHash)
  throw new Error(`Public media ${name} did not match its pinned checksum. Deployment stopped.`);
if (!present) {
  await mkdir(new URL("../public/assets/", import.meta.url), { recursive: true });
  await writeFile(file, bytes, { flag: "wx" });
}
console.log(`Public media ${name} ${present ? "verified" : "restored and verified"} (${expectedBytes} bytes).`);
}));
