export const OWNER_EMAIL = "erik@brocotech.ai";

// Only persisted server records reach this helper. An email address by itself
// never grants privileges; public registration always creates a customer.
export function roleForUser(user) {
  if (!user || user.status === "suspended") return "customer";
  if (user.email === OWNER_EMAIL && user.role === "owner") return "owner";
  return user.role === "admin" ? "admin" : "customer";
}

export function hasAdminAccess(user) {
  return ["owner", "admin"].includes(roleForUser(user));
}

export function isOwner(user) {
  return roleForUser(user) === "owner";
}

// A customer's email domain, old active flag, or signed cookie is not approval.
// The live private user record is checked on every protected request.
export function hasRecordedApproval(user) {
  return typeof user?.approvedAt === "string" && Number.isFinite(Date.parse(user.approvedAt))
    && typeof user.approvedBy === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(user.approvedBy);
}

export function accessStatusForUser(user) {
  if (user?.status === "suspended") return "suspended";
  if (hasAdminAccess(user)) return "approved";
  return user?.status === "active" && hasRecordedApproval(user) ? "approved" : "pending";
}
