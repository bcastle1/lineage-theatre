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
