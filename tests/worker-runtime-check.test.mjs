import test from "node:test";
import assert from "node:assert/strict";
import { checkWorkerRuntime } from "../scripts/check-worker-runtime.mjs";

test("missing runtime executable fails closed without exposing its private path", async () => {
  const privatePath = "not-installed-private-runtime-path-SENTINEL";
  const result = await checkWorkerRuntime({ ffmpeg: privatePath });
  assert.equal(result.runtimeReady, false);
  assert.equal(result.failure, "RUNTIME_MEDIA_UNAVAILABLE");
  assert.equal(result.providerContacted, false);
  assert.equal(result.customerWorkProcessed, false);
  assert.doesNotMatch(JSON.stringify(result), /SENTINEL|not-installed-private-runtime-path/);
});
