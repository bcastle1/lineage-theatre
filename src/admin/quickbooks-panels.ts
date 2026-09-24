export type CheckoutConnectionStatus = "ready" | "renewal-due" | "setup-required" | "needs-attention";

export type HostedCheckoutSettingsValue = {
  revision: number; enabled: boolean; configured: boolean; available?: boolean; reason?: string | null; environment?: string;
  connectionStatus?: CheckoutConnectionStatus;
  serviceItemId: string; serviceItemName?: string; taxCode: string;
  deliveryTerms: string; refundTerms: string; merchantConfirmed: boolean;
  pciAcknowledged: boolean; automaticInvoiceEmailDisabled: boolean;
};

export function verifyHostedCheckoutSettings(value: HostedCheckoutSettingsValue) {
  if (!value || !Number.isSafeInteger(value.revision) || typeof value.enabled !== "boolean" || typeof value.configured !== "boolean") {
    throw new Error("The saved checkout settings could not be verified.");
  }
  return value;
}

// These reads reconcile one explicit owner action. They never retry the action
// or request a token rotation, and one failed panel must not hide the others.
export async function readQuickBooksPanels<Overview, Payments>(read: <T>(path: string) => Promise<T>) {
  const [overview, payments, settings] = await Promise.allSettled([
    read<Overview>("/api/admin?action=overview"),
    read<Payments>("/api/admin?action=payments"),
    read<HostedCheckoutSettingsValue>("/api/admin?action=hostedCheckout").then(verifyHostedCheckoutSettings),
  ]);
  return { overview, payments, settings };
}

export function mergeHostedCheckoutSettings(
  current: HostedCheckoutSettingsValue | null,
  latest: HostedCheckoutSettingsValue,
  hasUnsavedChanges: boolean,
): HostedCheckoutSettingsValue {
  if (current && latest.revision < current.revision) return current;
  if (!current || !hasUnsavedChanges) return latest;
  // Keep the draft's revision too: a status read must not silently rebase an
  // unsaved form over settings changed elsewhere.
  return { ...current, configured: latest.configured, available: latest.available, reason: latest.reason,
    environment: latest.environment, connectionStatus: latest.connectionStatus };
}
