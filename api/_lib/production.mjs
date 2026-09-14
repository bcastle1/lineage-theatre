// A key or environment flag alone cannot establish a working provider contract.
export function productionReadiness() {
  return {
    magiclight:false,
    billing:false,
    quality:{preference:"highest",label:"Highest available animation quality",verified:false},
    connections:{
      magiclight:{available:false,reason:"MagicLight film production is awaiting the account's API connection and verified generation settings. You can prepare and save your screenplay here. No payment is taken."},
      billing:{available:false,reason:"Film pricing and in-app payment are not active. A confirmed total will be shown before you approve any charge."},
    },
  };
}
