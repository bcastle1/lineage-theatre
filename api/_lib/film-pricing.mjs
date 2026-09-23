import { accessStatusForUser } from "./access.mjs";
import { digest } from "./auth.mjs";
import { readPricingSettings } from "./admin.mjs";
import { buildFilmManifest, filmProduction, FilmProductionError } from "./film-production.mjs";
import { pricingPolicy } from "./pricing.mjs";

const keyPattern = /^[A-Za-z0-9_-]{16,100}$/;
const hashPattern = /^[a-f0-9]{64}$/;
const validAmount = value => Number.isSafeInteger(value) && value > 0 && value <= 100_000_000;
const unavailable = () => new FilmProductionError(
  "Your production plan is saved. A film price cannot be calculated until production costs are available.",
  503, "PRICE_UNAVAILABLE",
);
const fixedPriceNote = "This is the fixed price for this saved film. It will not change if production costs change.";
function markedUpAmount(costCents, settings) {
  if (!validAmount(costCents) || !settings || !Number.isInteger(settings.markupBasisPoints) || settings.markupBasisPoints < 0 || settings.markupBasisPoints > 100_000
    || !Number.isSafeInteger(settings.revision) || settings.revision < 0) throw unavailable();
  const markupCents = Number((BigInt(costCents) * BigInt(settings.markupBasisPoints) + 5_000n) / 10_000n);
  const amountCents = costCents + markupCents;
  if (!validAmount(amountCents)) throw unavailable();
  return amountCents;
}

export function createFilmPricingService({ filmProduction: production = filmProduction, pricingSettings = readPricingSettings, now = Date.now, env = process.env } = {}) {
  async function planningPrice(actor, body) {
    // The same unavailable error can also signal a malformed live quote. Only
    // an adapter that explicitly reports unavailable may use planning inputs.
    if ((await production.readiness?.())?.available !== false || typeof production.getPrepared !== "function") throw unavailable();
    const job = await production.getPrepared({ email: actor.email, id: body.preparedId });
    if (!job || job.id !== body.preparedId || job.ownerHash !== digest(actor.email))
      throw new FilmProductionError("This production does not belong to your account.", 404, "PRODUCTION_NOT_FOUND");
    const rebuilt = buildFilmManifest(body.project);
    if (job.manifestHash !== rebuilt.manifestHash || digest(JSON.stringify(job.manifest)) !== rebuilt.manifestHash || job.filmId !== rebuilt.manifest.filmId)
      throw new FilmProductionError("This screenplay has changed. Prepare the current version before requesting a price.", 409, "PRODUCTION_PLAN_CHANGED");
    if (job.status !== "prepared" || !Array.isArray(job.shots) || job.shots.length !== job.manifest.shots.length
      || job.shots.some((shot, index) => shot.status !== "prepared" || shot.id !== job.manifest.shots[index].id))
      throw new FilmProductionError("Production has already started for this plan. Check the existing film before making another payment.", 409, "PRODUCTION_ALREADY_STARTED");
    const planUntil = job.expiresAt === undefined ? Infinity : typeof job.expiresAt === "string" ? Date.parse(job.expiresAt) : NaN;
    if (!(planUntil > now())) throw new FilmProductionError("This production plan expired. Prepare the current screenplay again.", 409, "PRODUCTION_PLAN_EXPIRED");
    const settings = await pricingSettings();
    if (!settings || !Number.isSafeInteger(settings.planningCreditsPerClip) || settings.planningCreditsPerClip < 1 || settings.planningCreditsPerClip > 1_000_000
      || !Number.isSafeInteger(settings.planningSecondsPerClip) || settings.planningSecondsPerClip < 1 || settings.planningSecondsPerClip > 60
      || !Number.isSafeInteger(settings.planningRendersPerClip) || settings.planningRendersPerClip < 1 || settings.planningRendersPerClip > 20) throw unavailable();
    // The public Pro pack ($88 / 80,000 credits, up to 280 clips) was checked
    // 2026-09-22 at https://magiclight.ai/openclaw/pricing/. Credits per clip,
    // seconds per clip and render count are editable planning assumptions,
    // never claims about a supported generation contract or final film quality.
    const clipMs = BigInt(settings.planningSecondsPerClip) * 1000n;
    const clips = job.manifest.shots.reduce((sum, shot) => sum + (BigInt(shot.targetDurationMs) + clipMs - 1n) / clipMs, 0n);
    const credits = clips * BigInt(settings.planningRendersPerClip) * BigInt(settings.planningCreditsPerClip);
    let policy;
    try { policy = pricingPolicy(env); } catch { throw unavailable(); }
    const denominator = BigInt(policy.packCredits);
    const cost = (2n * credits * BigInt(policy.packPriceCents) + denominator) / (2n * denominator);
    if (cost < 1n || cost > 100_000_000n) throw unavailable();
    markedUpAmount(Number(cost), settings);
    const currentTime = now();
    if (!(planUntil > currentTime)) throw new FilmProductionError("This production plan expired. Prepare the current screenplay again.", 409, "PRODUCTION_PLAN_EXPIRED");
    return {
      preparedId: job.id, manifestHash: job.manifestHash, filmId: job.filmId, filmTitle: job.manifest.title,
      currency: "USD", providerCostCents: Number(cost), expiresAt: new Date(Math.min(planUntil, currentTime + 15 * 60_000)).toISOString(),
      quoteReference: digest(JSON.stringify({ basis: "planning-rate", preparedId: job.id, manifestHash: job.manifestHash,
        packPriceCents: policy.packPriceCents, packCredits: policy.packCredits,
        planningCreditsPerClip: settings.planningCreditsPerClip, planningSecondsPerClip: settings.planningSecondsPerClip,
        planningRendersPerClip: settings.planningRendersPerClip, markupBasisPoints: settings.markupBasisPoints, revision: settings.revision })),
      environment: "production", pricingBasis: "planning-rate", pricingSettings: settings,
      apiVerified: false, qualityVerified: false, commercialTermsVerified: false,
    };
  }
  async function calculate(actor, body) {
    // The shared check covers customer approval and persisted legacy admin
    // roles, while denying suspended accounts regardless of their role.
    if (!actor || accessStatusForUser(actor) !== "approved" || actor.mustChangePassword
      || typeof actor.email !== "string" || actor.email !== actor.email.trim().toLowerCase() || !/^\S+@\S+\.\S+$/.test(actor.email))
      throw new FilmProductionError("Sign in to continue.", 401);
    if (!body || typeof body !== "object" || Array.isArray(body)
      || Object.keys(body).some(field => !["project", "preparedId", "idempotencyKey"].includes(field))
      || !body.project || typeof body.project !== "object" || Array.isArray(body.project)
      || typeof body.preparedId !== "string" || !keyPattern.test(body.preparedId)
      || typeof body.idempotencyKey !== "string" || !keyPattern.test(body.idempotencyKey))
      throw new FilmProductionError("Choose your saved production plan before requesting a film price.");

    let supplied;
    try {
      // A required saved reference keeps pricing from implicitly preparing or
      // changing a plan. This operation creates no payment quote or order.
      supplied = await production.quoteForPayment(body.project, actor, {
        preparedId: body.preparedId, idempotencyKey: body.idempotencyKey,
      });
    } catch (error) {
      if (error instanceof FilmProductionError && error.status === 503 && ["PRODUCTION_UNAVAILABLE", "PRICE_UNAVAILABLE"].includes(error.code))
        return planningPrice(actor, body);
      throw error;
    }
    const until = typeof supplied?.expiresAt === "string" ? Date.parse(supplied.expiresAt) : NaN;
    if (!supplied || supplied.preparedId !== body.preparedId || !["sandbox", "production"].includes(supplied.environment)
      || supplied.currency !== "USD" || !validAmount(supplied.providerCostCents)
      || typeof supplied.manifestHash !== "string" || !hashPattern.test(supplied.manifestHash)
      || typeof supplied.filmId !== "string" || !supplied.filmId || supplied.filmId.length > 100 || supplied.filmId !== body.project.id
      || typeof supplied.filmTitle !== "string" || !supplied.filmTitle.trim() || supplied.filmTitle.length > 300
      || typeof supplied.quoteReference !== "string" || !supplied.quoteReference.trim() || supplied.quoteReference.length > 200
      || supplied.qualityVerified !== true || supplied.apiVerified !== true || supplied.commercialTermsVerified !== true
      || !Number.isFinite(until) || until <= now()) throw unavailable();

    const settings = await pricingSettings();
    markedUpAmount(supplied.providerCostCents, settings);
    const currentTime = now();
    if (until <= currentTime) throw unavailable();
    return {
      preparedId: supplied.preparedId, manifestHash: supplied.manifestHash, filmId: supplied.filmId, filmTitle: supplied.filmTitle,
      currency: "USD", providerCostCents: supplied.providerCostCents, quoteReference: supplied.quoteReference,
      expiresAt: new Date(Math.min(until, currentTime + 15 * 60_000)).toISOString(), environment: supplied.environment,
      pricingBasis: "provider-quote", pricingSettings: settings, apiVerified: true, qualityVerified: true, commercialTermsVerified: true,
    };
  }
  async function price(actor, body) {
    const value = await calculate(actor, body);
    return { preparedId: value.preparedId, manifestHash: value.manifestHash, filmId: value.filmId, filmTitle: value.filmTitle,
      currency: "USD", amountCents: markedUpAmount(value.providerCostCents, value.pricingSettings), expiresAt: value.expiresAt,
      sandbox: value.environment === "sandbox", kind: "confirmed", pricingBasis: value.pricingBasis,
      note: fixedPriceNote,
    };
  }
  async function quoteForPayment(project, actor, { preparedId, idempotencyKey, environment } = {}) {
    // This environment comes from the server's merchant binding, never the
    // public price body. Pricing alone does not authorize billing or rendering.
    if (!["sandbox", "production"].includes(environment)) throw unavailable();
    const value = await calculate(actor, { project, preparedId, idempotencyKey });
    if (value.pricingBasis === "provider-quote" && value.environment !== environment) throw unavailable();
    const { pricingSettings: settings, ...quote } = value;
    return { ...quote, environment, pricingRevision: settings.revision };
  }
  return { price, quoteForPayment };
}

export const filmPricing = createFilmPricingService();
export const quoteForPayment = (...args) => filmPricing.quoteForPayment(...args);
