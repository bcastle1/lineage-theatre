import { normalizeFilmReceipt } from "./checkout-contract";
import type { LibraryCoverage } from "./film-library";

export function verifiedOriginalPaymentReceipt(value: unknown, coverage: LibraryCoverage) {
  const receipt = normalizeFilmReceipt(value);
  if (!receipt || receipt.receiptId !== coverage.orderId || receipt.amountCents !== coverage.amountCents
    || receipt.currency !== coverage.currency || receipt.sandbox) {
    throw new Error("The original payment receipt could not be verified. Refresh this film's status before trying again.");
  }
  return receipt;
}
