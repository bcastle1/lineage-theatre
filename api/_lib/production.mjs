import { pricingReadiness } from "./pricing.mjs";

// A key, rate, or environment flag alone cannot establish a provider or merchant connection.
export function productionReadiness({ env = process.env } = {}) {
  return {
    magiclight:false,
    billing:false,
    pricing:pricingReadiness(env),
    payment:{provider:"quickbooks",label:"QuickBooks",status:"connection-pending",available:false},
    quality:{preference:"highest",label:"Highest available animation quality",verified:false},
    connections:{
      magiclight:{available:false,reason:"MagicLight film production is awaiting the account's API connection and verified generation settings. You can prepare and save your screenplay here. No payment is taken."},
      billing:{available:false,reason:"QuickBooks is selected for payments; its merchant connection is pending. Your film price will match the quoted MagicLight cost with no BROCOTech markup. A confirmed total must be shown before you approve a charge."},
    },
  };
}
