// Intuit owns the opaque invoice token; it is not a fixed-length hex digest.
// Keep navigation on the exact hosted invoice origin and one bounded path token.
// Server order validation and browser navigation must use the same rules.
export function normalizeHostedInvoiceUrl(value) {
  if (typeof value !== "string" || value.length > 4096 || !value.startsWith("https://connect.intuit.com/")
    || /[\s\\#\u0000-\u001f\u007f]/.test(value)) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname !== "connect.intuit.com" || url.username || url.password || url.port || url.hash
      || url.href !== value) return null;
    if (url.pathname.startsWith("/portal/") && url.pathname.length > "/portal/".length) return value;
    if (!/^\/t\/scs-v1-[A-Za-z0-9._~-]{1,2048}$/.test(url.pathname)) return null;
    const locales = url.searchParams.getAll("locale");
    if (locales.length > 1 || (locales.length === 1 && !/^[a-zA-Z]{2}_[a-zA-Z]{2}$/.test(locales[0]))) return null;
    // Query action/tracking values cannot change the payment destination.
    // Preserve only a validated locale without changing the invoice identity.
    return `${url.origin}${url.pathname}${locales.length ? `?locale=${locales[0]}` : ""}`;
  } catch { return null; }
}
