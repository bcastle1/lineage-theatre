import assert from "node:assert/strict";
import test from "node:test";
import startHandler from "./start.mjs";
import statusHandler from "./status.mjs";
import { normalizeImagineStatus } from "./_shared.mjs";

function makeResponse() {
  return {
    statusCode: 200,
    headers: {},
    body: "",
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    end(value = "") {
      this.body = value;
    },
    json() {
      return JSON.parse(this.body);
    },
  };
}

test("normalizes completed ImagineArt status responses", () => {
  assert.deepEqual(normalizeImagineStatus({
    status: "success",
    video: {
      status: "finished",
      url: { generation: ["https://media.example/film.mp4"], thumbnail: ["https://media.example/poster.jpg"] },
    },
  }, "job-1"), {
    jobId: "job-1",
    status: "completed",
    videoUrl: "https://media.example/film.mp4",
    thumbnailUrl: "https://media.example/poster.jpg",
    message: null,
  });
});

test("starts one premium ImagineArt job without exposing the token", async () => {
  const originalFetch = globalThis.fetch;
  process.env.IMAGINEART_API_TOKEN = "test-token";
  let capturedRequest;
  globalThis.fetch = async (url, options) => {
    capturedRequest = { url, options };
    return new Response(JSON.stringify({ id: "render-123", status: "processing" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  try {
    const request = {
      method: "POST",
      headers: { host: "lineagetheater.com", origin: "https://lineagetheater.com", "idempotency-key": "project-123:attempt-1" },
      body: { projectId: "project-123", prompt: "A respectful and realistic cinematic family history scene with warm light, period detail, and natural camera movement." },
    };
    const response = makeResponse();
    await startHandler(request, response);

    assert.equal(response.statusCode, 202);
    assert.equal(response.json().jobId, "render-123");
    assert.equal(capturedRequest.url, "https://api.vyro.ai/v2/video/text-to-video");
    assert.equal(capturedRequest.options.headers.Authorization, "Bearer test-token");
    assert.equal(capturedRequest.options.body.get("style"), "luma-dream-machine-ray-2");
    assert.equal(capturedRequest.options.body.get("aspect_ratio"), "16:9");
    assert.equal(response.body.includes("test-token"), false);
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.IMAGINEART_API_TOKEN;
  }
});

test("falls back to the current video status route and returns the signed result", async () => {
  const originalFetch = globalThis.fetch;
  process.env.IMAGINEART_API_TOKEN = "test-token";
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    if (String(url).includes("/assets/")) return new Response("{}", { status: 404 });
    return new Response(JSON.stringify({
      status: "success",
      video: { status: "finished", url: { generation: "https://media.example/result.mp4", thumbnail: null } },
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };

  try {
    const request = { method: "GET", headers: { host: "lineagetheater.com" }, url: "/api/imagineart/status?id=render-123" };
    const response = makeResponse();
    await statusHandler(request, response);

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().status, "completed");
    assert.equal(response.json().videoUrl, "https://media.example/result.mp4");
    assert.equal(urls.length, 2);
    assert.match(urls[1], /\/video\/render-123\/status$/);
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.IMAGINEART_API_TOKEN;
  }
});
