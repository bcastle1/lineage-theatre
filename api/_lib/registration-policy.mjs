import { readRecord } from "./auth.mjs";

export const REGISTRATION_POLICY_PATH = "settings/registration.json";

export async function readRegistrationPolicy(read = readRecord) {
  const record = await read(REGISTRATION_POLICY_PATH);
  if (!record) return { approvalRequired: true, revision: 0, updatedAt: null, updatedBy: null };
  const value = record.value;
  if (typeof value.approvalRequired !== "boolean" || !Number.isSafeInteger(value.revision) || value.revision < 1
    || typeof value.updatedAt !== "string" || !Number.isFinite(Date.parse(value.updatedAt))
    || typeof value.updatedBy !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.updatedBy))
    throw new Error("The saved registration policy needs administrator attention.");
  return { approvalRequired: value.approvalRequired, revision: value.revision,
    updatedAt: value.updatedAt, updatedBy: value.updatedBy };
}
