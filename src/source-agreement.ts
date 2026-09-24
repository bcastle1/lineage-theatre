export type SourceAgreement = {
  title: string;
  body: string;
  consentLabel: string;
  version: string;
  contentHash: string;
  revision: number;
  updatedAt: string | null;
};

export function normalizeSourceAgreement(value: unknown): SourceAgreement {
  const agreement = value && typeof value === "object" && "agreement" in value ? value.agreement : null;
  if (!agreement || typeof agreement !== "object" || Array.isArray(agreement)) throw new Error("The source agreement could not be loaded. Please try again.");
  const current = agreement as Partial<SourceAgreement>;
  const version = typeof current.version === "string" ? /^source-agreement-v(0|[1-9]\d{0,15})-([a-f0-9]{64})(?:-([a-f0-9]{32}))?$/.exec(current.version) : null;
  const text = (input: unknown, maximum: number): input is string => typeof input === "string" && input.trim().length > 0 && input.length <= maximum;
  if (!text(current.title, 160) || !text(current.body, 10_000) || !text(current.consentLabel, 500)
    || !Number.isSafeInteger(current.revision) || Number(current.revision) < 0
    || typeof current.contentHash !== "string" || !/^[a-f0-9]{64}$/.test(current.contentHash)
    || !version || Number(version[1]) !== current.revision || version[2] !== current.contentHash
    || (current.revision === 0 ? current.updatedAt !== null : typeof current.updatedAt !== "string"
      || !Number.isFinite(Date.parse(current.updatedAt)) || new Date(current.updatedAt).toISOString() !== current.updatedAt)) {
    throw new Error("The source agreement could not be verified. Reload it before continuing.");
  }
  return { title: current.title, body: current.body, consentLabel: current.consentLabel,
    version: current.version!, contentHash: current.contentHash, revision: current.revision!, updatedAt: current.updatedAt! };
}

export function sourceAgreementAcceptance(agreement: SourceAgreement | null, accepted: boolean) {
  if (!agreement || accepted !== true) throw new Error("Read and accept the source ownership and sharing agreement before creating your account.");
  const current = normalizeSourceAgreement({ agreement });
  return { sourceAgreementAccepted: true as const, sourceAgreementVersion: current.version, sourceAgreementHash: current.contentHash };
}
