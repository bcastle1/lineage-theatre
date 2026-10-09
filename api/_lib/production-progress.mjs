import { digest, readRecord, writeRecord } from "./auth.mjs";

const HASH = /^[a-f0-9]{64}$/;
const STALE_MS = 10 * 60_000;
const HISTORY_MS = 30 * 86400_000;
const stamp = value => typeof value === "string" ? Date.parse(value) : NaN;
const positive = value => Number.isFinite(value) && value > 0;
const profilePath = profile => `production/timing/${profile}.json`;

// A model/quality change must bump the adapter's timingVersion. Samples never
// mix test runs, unlike runtimes, scene counts, sound settings or renderers.
export function productionTimingProfile(job, adapter) {
  return digest(JSON.stringify({ version: 1, renderer: adapter.id, environment: adapter.environment,
    timingVersion: adapter.timingVersion || 1, duration: job.manifest.targetDurationSeconds,
    shots: job.shots.length, style: job.manifest.style, quality: job.manifest.qualityPreference,
    music: job.manifest.sound?.musicRequested === true }));
}

function samples(value, now) {
  if (value?.version !== 1 || !Array.isArray(value.samples)) return [];
  const seen = new Set();
  return value.samples.filter(s => HASH.test(s.id || "") && !seen.has(s.id) && seen.add(s.id) && stamp(s.completedAt) <= now
    && stamp(s.completedAt) >= now - HISTORY_MS && positive(s.totalSeconds) && s.totalSeconds <= 86400
    && positive(s.renderSeconds) && s.renderSeconds <= s.totalSeconds).sort((a, b) => stamp(a.completedAt) - stamp(b.completedAt)).slice(-30);
}
function bounds(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return { low: Math.max(1, Math.floor(sorted[Math.floor((sorted.length - 1) * .2)] * .8)),
    high: Math.ceil(sorted[Math.ceil((sorted.length - 1) * .9)] * 1.3),
    middle: sorted[Math.floor((sorted.length - 1) * .5)] };
}

// Contains no provider identity, task reference, URL, cost, or source material.
export function productionProgressSnapshot({ job, queue, attempt, history = [], mediaReady = false, needsAttention = false, now = Date.now() }) {
  let status = job.status;
  let observedAt = job.lastCheckedAt || job.updatedAt;
  let startedAt = job.productionStartedAt;
  let legacy = false;
  if (status === "prepared" && attempt) {
    legacy = true; status = attempt.status; observedAt = attempt.checkedAt || attempt.updatedAt; startedAt = attempt.submittedAt;
    if (status === "submitting" && now - stamp(startedAt) >= 300_000) status = "uncertain";
  } else if (status === "prepared" && queue?.state === "pending") status = "queued";
  const shots = job.shots || [], manifestShots = job.manifest?.shots || [];
  const total = manifestShots.reduce((n, s) => n + (positive(s.targetDurationMs) ? s.targetDurationMs : 0), 0);
  const completed = legacy ? 0 : shots.filter(s => s.status === "completed").length;
  const completedMs = legacy ? 0 : manifestShots.reduce((n, s) => n + (shots.find(row => row.id === s.id)?.status === "completed" ? s.targetDurationMs : 0), 0);
  const fraction = total > 0 ? Math.min(1, completedMs / total) : 0;
  const attention = needsAttention || queue?.state === "attention" || ["uncertain", "failed"].includes(status);
  const stage = mediaReady ? "ready" : attention ? "attention" : ["completed", "verifying", "awaiting-assembly"].includes(status)
    ? "finishing" : ["processing", "submitting", "submitted"].includes(status) ? "creating" : status === "queued" ? "queued" : "waiting";
  const result = { version: 1, stage, percent: mediaReady ? 100 : attention ? null : stage === "finishing" ? 90
    : stage === "creating" ? 10 + Math.floor(fraction * 75) : stage === "queued" ? 5 : 0,
    basis: "confirmed-work", timing: mediaReady ? "complete" : attention ? "paused" : "learning",
    asOf: new Date(now).toISOString(), observedAt: Number.isFinite(stamp(observedAt)) ? observedAt : null,
    completedScenes: completed, totalScenes: shots.length, estimate: null };
  if (mediaReady || attention || !["creating", "finishing"].includes(stage)) return result;
  const freshness = now - stamp(observedAt);
  const stale = !Number.isFinite(freshness) || freshness < 0 || freshness > STALE_MS;
  // Full-film histories cannot calibrate the separate legacy single-task pilot.
  if (legacy || history.length < 5 || !Number.isFinite(stamp(startedAt)) || stamp(startedAt) > now) return stale ? { ...result, timing: "stale" } : result;
  const elapsed = Math.max(0, (now - stamp(startedAt)) / 1000);
  const duration = bounds(history.map(s => s.totalSeconds));
  const render = bounds(history.map(s => s.renderSeconds));
  // Do not extrapolate into later stages or keep moving an overdue deadline.
  const delayed = elapsed >= duration.high || stage === "creating" && elapsed >= render.high;
  let percent = result.percent;
  if (stage === "creating" && total > 0) {
    const active = shots.find(s => ["queued", "submitting", "processing"].includes(s.status));
    const target = manifestShots.find(s => s.id === active?.id);
    if (active && target && positive(target.targetDurationMs) && Number.isFinite(stamp(active.submittedAt))) {
      const observation = Number.isFinite(stamp(observedAt)) ? stamp(observedAt) : stamp(active.submittedAt);
      const activeElapsed = Math.max(0, (Math.min(now, observation) - stamp(active.submittedAt)) / 1000);
      const expected = render.middle * target.targetDurationMs / total;
      // At most 85% of an unfinished scene is estimated. Completion and stage
      // changes require saved results; an absent heartbeat freezes interpolation.
      const estimatedMs = target.targetDurationMs * Math.min(.85, activeElapsed / Math.max(1, expected));
      percent = Math.max(percent, Math.min(84, 10 + Math.floor((completedMs + estimatedMs) / total * 75)));
    }
  }
  if (stale) return { ...result, percent, basis: percent === result.percent ? result.basis : "measured-estimate", timing: "stale" };
  if (delayed) return { ...result, percent, basis: percent === result.percent ? result.basis : "measured-estimate", timing: "delayed" };
  return { ...result, percent, basis: percent === result.percent ? result.basis : "measured-estimate", timing: "available",
    estimate: { earliestAt: new Date(stamp(startedAt) + duration.low * 1000).toISOString(),
      latestAt: new Date(stamp(startedAt) + duration.high * 1000).toISOString(), sampleCount: history.length } };
}

export function createProductionProgress({ read = readRecord, write = writeRecord, now = Date.now } = {}) {
  async function calibrate(job) {
    try { return { version: 1, profile: job.timingProfile, samples: samples((await read(profilePath(job.timingProfile)))?.value, now()) }; }
    catch { return { version: 1, profile: job.timingProfile, samples: [] }; }
  }
  async function record(job) {
    if (job.status !== "completed" || !job.media || job.mode !== "customer" || job.authorization?.environment !== "production"
      || job.timingDisrupted || !HASH.test(job.timingProfile || "")) return;
    const end = stamp(job.completedAt), start = stamp(job.productionStartedAt), renderEnd = stamp(job.finishingStartedAt);
    const totalSeconds = (end - start) / 1000, renderSeconds = (renderEnd - start) / 1000;
    if (!positive(totalSeconds) || totalSeconds > 86400 || !positive(renderSeconds) || renderSeconds > totalSeconds || end > now()) return;
    const path = profilePath(job.timingProfile), id = digest(`${job.ownerHash}:${job.id}:${job.manifestHash}`);
    for (let retry = 0; retry < 3; retry++) {
      const old = await read(path), recent = samples(old?.value, now());
      if (recent.some(sample => sample.id === id)) return;
      const next = [...recent, { id, completedAt: job.completedAt, totalSeconds, renderSeconds }].slice(-30);
      try { await write(path, { version: 1, samples: next }, old?.etag); return; } catch { /* Conditional merge; never overwrite a concurrent sample. */ }
    }
  }
  async function snapshot({ job, email, queue, mediaReady = false, needsAttention = false }) {
    const history = HASH.test(job.timingProfile || "") && job.timingBaseline?.profile === job.timingProfile ? samples(job.timingBaseline, now()) : [];
    let attempt;
    if (job.status === "prepared" && email && job.ownerHash === digest(email)) {
      let value;
      try { value = (await read(`production/generation-attempts/${digest(email)}/${job.id}.json`))?.value; }
      catch { return { ...productionProgressSnapshot({ job, queue, now: now() }), stage: "attention", percent: null, timing: "stale" }; }
      if (value?.version === 1 && value.id === job.id && value.ownerEmail === email && value.filmId === job.filmId
        && value.manifestHash === job.manifestHash && ["submitting", "processing", "verifying", "uncertain", "failed"].includes(value.status)) attempt = value;
    }
    return productionProgressSnapshot({ job, queue, attempt, history, mediaReady, needsAttention, now: now() });
  }
  return { record, snapshot, calibrate };
}
