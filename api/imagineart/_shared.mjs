import { checkBotId } from "botid/server";

export const IMAGINEART_API_BASE = "https://api.vyro.ai/v2";
export const IMAGINEART_MODEL = "luma-dream-machine-ray-2";

export function sendJson(response, status, payload) {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store, max-age=0");
  response.end(JSON.stringify(payload));
}

export function allowSameOrigin(request) {
  const origin = request.headers?.origin;
  const host = request.headers?.host;
  if (!origin || !host) return true;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export async function isHumanRequest(request) {
  const verification = await checkBotId({
    developmentOptions: process.env.NODE_ENV === "production" ? undefined : { bypass: "HUMAN" },
    advancedOptions: {
      checkLevel: "basic",
      headers: request.headers,
    },
  });
  return !verification.isBot;
}

export async function readJsonBody(request) {
  if (request.body && typeof request.body === "object") return request.body;
  if (typeof request.body === "string") return JSON.parse(request.body);

  let raw = "";
  for await (const chunk of request) {
    raw += chunk;
    if (raw.length > 32_000) throw new Error("request_too_large");
  }
  return raw ? JSON.parse(raw) : {};
}

export async function readUpstreamJson(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { message: text.slice(0, 300) };
  }
}

export function upstreamMessage(payload, fallback) {
  if (!payload || typeof payload !== "object") return fallback;
  const message = payload.message ?? payload.error?.message ?? payload.error;
  return typeof message === "string" && message.trim() ? message.slice(0, 300) : fallback;
}

export function normalizeImagineStatus(payload, jobId) {
  const video = payload?.video && typeof payload.video === "object" ? payload.video : {};
  const rawStatus = String(video.status ?? payload?.status ?? "processing").toLowerCase();
  const urls = video.url && typeof video.url === "object" ? video.url : {};
  const generation = Array.isArray(urls.generation) ? urls.generation[0] : urls.generation;
  const thumbnail = Array.isArray(urls.thumbnail) ? urls.thumbnail[0] : urls.thumbnail;
  const videoUrl = typeof generation === "string" ? generation : null;
  const thumbnailUrl = typeof thumbnail === "string" ? thumbnail : null;

  if (["failed", "error", "cancelled", "canceled"].includes(rawStatus)) {
    return {
      jobId,
      status: "failed",
      videoUrl: null,
      thumbnailUrl: null,
      message: upstreamMessage(payload, "ImagineArt could not complete this render."),
    };
  }

  if (videoUrl && ["finished", "completed", "success", "succeeded", "ready"].includes(rawStatus)) {
    return { jobId, status: "completed", videoUrl, thumbnailUrl, message: null };
  }

  return {
    jobId,
    status: ["pending", "queued"].includes(rawStatus) ? "queued" : "processing",
    videoUrl,
    thumbnailUrl,
    message: null,
  };
}

export async function fetchWithTimeout(url, options, timeoutMs = 30_000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}
