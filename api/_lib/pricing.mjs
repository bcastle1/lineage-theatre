// Server-only pricing. Never obtain a rate or charge amount from a browser request.
const PUBLIC_PACK_PRICE_CENTS = 8_800;
const PUBLIC_PACK_CREDITS = 80_000;
const PUBLIC_PRICING_URL = "https://magiclight.ai/openclaw/pricing/";

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function environmentInteger(value) {
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value.trim())) return null;
  const parsed = Number(value.trim());
  return positiveInteger(parsed) ? parsed : null;
}

export function pricingPolicy(env = process.env) {
  const price = env.MAGICLIGHT_API_PACK_PRICE_CENTS;
  const credits = env.MAGICLIGHT_API_PACK_CREDITS;
  const configured = price !== undefined || credits !== undefined;
  const packPriceCents = configured ? environmentInteger(price) : PUBLIC_PACK_PRICE_CENTS;
  const packCredits = configured ? environmentInteger(credits) : PUBLIC_PACK_CREDITS;
  if (!packPriceCents || !packCredits)
    throw new Error("MagicLight's reference rate configuration is incomplete or invalid. No film price or charge can be confirmed.");
  return Object.freeze({
    currency: "USD",
    packPriceCents,
    packCredits,
    markupBasisPoints: 0,
    source: configured ? "server-configuration" : "public-pro-api-pack",
    sourceUrl: configured ? null : PUBLIC_PRICING_URL,
  });
}

// The caller must obtain credits from MagicLight's authenticated quote response.
// This arithmetic helper does not verify a quote, authorize payment, or submit a job.
export function costFromProviderCredits(providerCredits, policy) {
  if (!positiveInteger(providerCredits))
    throw new Error("A valid MagicLight credit quote is required before calculating the film price.");
  if (!policy || policy.currency !== "USD" || policy.markupBasisPoints !== 0
      || !positiveInteger(policy.packPriceCents) || !positiveInteger(policy.packCredits))
    throw new Error("A valid server pricing policy with no markup is required.");
  const numerator = BigInt(providerCredits) * BigInt(policy.packPriceCents);
  const denominator = BigInt(policy.packCredits);
  // Round half up to one US cent using integer arithmetic, without float drift.
  const cents = (2n * numerator + denominator) / (2n * denominator);
  if (cents < 1n || cents > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error("The provider quote cannot be represented as a billable currency amount. No charge can be confirmed.");
  return Number(cents);
}

export function pricingReadiness(env = process.env) {
  let referenceRate = null;
  let referenceStatus = "available";
  let referenceReason = "MagicLight Pro API credit-pack reference; this is not a complete-film quote.";
  try {
    const policy = pricingPolicy(env);
    referenceRate = {
      credits: 1_000,
      amountCents: costFromProviderCredits(1_000, policy),
      source: policy.source,
      sourceUrl: policy.sourceUrl,
    };
    if (policy.source === "server-configuration")
      referenceReason = "Configured MagicLight credit-pack reference; this is not a complete-film quote.";
  } catch {
    referenceStatus = "configuration-pending";
    referenceReason = "The MagicLight reference rate needs a valid server configuration. A price is not available.";
  }
  return {
    currency: "USD",
    policy: "provider-cost-no-markup",
    markupBasisPoints: 0,
    referenceStatus,
    referenceRate,
    referenceReason,
    estimate: {
      status: "awaiting-provider-quote",
      amountCents: null,
      providerCredits: null,
      reason: "Waiting for MagicLight's credit quote for this complete film. Highest-quality animation and final-film settings have not been quoted.",
    },
    chargeReady: false,
  };
}
