import { pricingReadiness } from "./pricing.mjs";
import { filmProduction } from "./film-production.mjs";

// A key, rate, or environment flag alone cannot establish a provider or merchant connection.
export function productionReadiness({ env = process.env, pricingSettings={markupBasisPoints:0,revision:0}, filmService = filmProduction } = {}) {
  let available = false;
  try {
    const ready = filmService.readiness();
    available = ready.available === true && ready.adapter === "magiclight" && ready.environment === "production";
  } catch { /* Configuration failures cannot enable customer production. */ }
  return {
    magiclight:available,
    billing:false,
    pricing:pricingReadiness(env,pricingSettings),
    payment:{provider:"quickbooks",label:"QuickBooks",status:"connection-pending",available:false},
    quality:{preference:"highest",label:"Highest available animation quality",verified:available},
    connections:{
      magiclight:{available,reason:available
        ?"MagicLight production is configured. Each saved film still requires verified payment, supported production inputs, and a current provider budget before generation."
        :"MagicLight film production setup is incomplete. Generation settings and finished-film delivery still need verification. Your screenplay, plan, and any recorded payment remain saved."},
      billing:{available:false,reason:"QuickBooks is selected for payments; its merchant connection is pending. When checkout becomes available, payment processing will be provided by Intuit Payments Inc. Film prices use a verified provider quote or a planning estimate plus the saved administrator markup. The total you approve at checkout is the fixed payment amount."},
    },
  };
}
