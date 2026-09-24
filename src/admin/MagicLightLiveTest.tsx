import { useEffect, useRef, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { api, ApiError } from "../studio/model";

const fixture = {
  id: "lineage-shipyard-live-test-v1",
  title: "Fictional shipyard test",
  imageUrl: "https://lineagetheater.com/assets/ancestor-shipyard-still.png",
  prompt: "Create a short fictional historical scene based on this illustrated shipyard. At golden hour, a shipwright and an apprentice inspect a wooden sailing ship while workers move in the background. Gentle cinematic camera movement, natural atmosphere, hopeful mood. This is a fictional technical test, not a real family history.",
};
type TestStatus = "submitting" | "submitted" | "uncertain" | "processing" | "completed" | "failed";
type SavedTest = {
  id: string; status: TestStatus; submissionCount: 1; createdAt: string; updatedAt: string;
  checkedAt?: string; providerCode?: number; httpStatus?: number; taskStatus?: number;
  outputOrigin?: string; code?: string;
};
type LiveTestState = {
  configured: boolean; productionReady: false; customerFulfillment: false;
  fixture: typeof fixture & { hash: string; costVerified: false; durationVerified: false };
  test: SavedTest | null;
};
type SafeError = { code: string; httpStatus?: number };
const statuses = new Set<TestStatus>(["submitting", "submitted", "uncertain", "processing", "completed", "failed"]);
const validCode = (value: unknown): value is string => typeof value === "string" && /^MAGICLIGHT_[A-Z_]{1,80}$/.test(value);
const validDate = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value));
const optionalInteger = (value: unknown) => value === undefined || Number.isSafeInteger(value);
function safeOrigin(value: unknown): boolean {
  if (value === undefined) return true;
  if (typeof value !== "string" || value.length > 255) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.origin === value && !url.username && !url.password && !url.port;
  } catch { return false; }
}
function normalize(value: unknown): LiveTestState {
  if (!value || typeof value !== "object") throw new Error("Invalid saved test");
  const state = value as LiveTestState;
  const test = state.test;
  if (typeof state.configured !== "boolean" || state.productionReady !== false || state.customerFulfillment !== false
    || !state.fixture || state.fixture.id !== fixture.id || state.fixture.title !== fixture.title
    || state.fixture.prompt !== fixture.prompt || state.fixture.imageUrl !== fixture.imageUrl
    || typeof state.fixture.hash !== "string" || !/^[a-f0-9]{64}$/.test(state.fixture.hash)
    || state.fixture.costVerified !== false || state.fixture.durationVerified !== false
    || (test !== null && (!test || typeof test.id !== "string" || !/^[a-f0-9-]{36}$/i.test(test.id)
      || !statuses.has(test.status) || test.submissionCount !== 1 || !validDate(test.createdAt) || !validDate(test.updatedAt)
      || (test.checkedAt !== undefined && !validDate(test.checkedAt))
      || !optionalInteger(test.providerCode) || !optionalInteger(test.taskStatus)
      || (test.httpStatus !== undefined && (!Number.isSafeInteger(test.httpStatus) || test.httpStatus < 100 || test.httpStatus > 599))
      || (test.code !== undefined && !validCode(test.code)) || !safeOrigin(test.outputOrigin)))) {
    throw new Error("Invalid saved test");
  }
  return state;
}
function safeError(error: unknown): SafeError {
  return {
    code: error instanceof ApiError && validCode(error.code) ? error.code : "MAGICLIGHT_LIVE_TEST_CHECK_REQUIRED",
    ...(error instanceof ApiError && Number.isInteger(error.status) && error.status! >= 100 && error.status! <= 599
      ? { httpStatus: error.status } : {}),
  };
}
function statusText(status: TestStatus): string {
  switch (status) {
    case "submitting": return "The single submission is saved. Its provider result still needs verification.";
    case "submitted": return "The test job is saved. Check its progress with MagicLight.";
    case "processing": return "MagicLight is processing the saved test job.";
    case "uncertain": return "The submission result is uncertain. Review the saved job; another submission is unavailable.";
    case "completed": return "MagicLight reports the clip is complete. Secure import and playback still need verification.";
    case "failed": return "The saved test failed. Review its diagnostic result before taking any further action.";
  }
}

export default function MagicLightLiveTest({ disabled = false }: { disabled?: boolean }) {
  const [state, setState] = useState<LiveTestState | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<"submit" | "check" | "">("");
  const [error, setError] = useState<SafeError | null>(null);
  const [consent, setConsent] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const [reload, setReload] = useState(0);
  const lock = useRef(false), mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    let active = true;
    setLoading(true); setError(null); setConsent(false);
    void api<unknown>("/api/admin?action=magicLightLiveTest")
      .then(value => {
        const result = normalize(value);
        if (active) { setState(result); setNeedsRefresh(false); }
      })
      .catch(cause => { if (active) { setError(safeError(cause)); setNeedsRefresh(true); } })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [reload]);

  const test = state?.test;
  const blocked = disabled || loading || Boolean(busy) || needsRefresh;
  const canSubmit = state?.configured === true && state.test === null && !attempted;
  const canCheck = Boolean(test && !["completed", "failed"].includes(test.status));
  async function operate(operation: "submit" | "check") {
    if (blocked || lock.current || (operation === "submit" ? !canSubmit || !consent : !canCheck)) return;
    lock.current = true; setBusy(operation); setError(null);
    if (operation === "submit") { setAttempted(true); setConsent(false); }
    try {
      const result = normalize(await api<unknown>("/api/admin", operation === "submit"
        ? { action: "submitMagicLightLiveTest", consent: true }
        : { action: "checkMagicLightLiveTest" }));
      if (operation === "submit" && !result.test) throw new Error("Submission not confirmed");
      if (mounted.current) { setState(result); setNeedsRefresh(false); }
    } catch (cause) {
      if (mounted.current) { setError(safeError(cause)); setNeedsRefresh(true); }
    } finally { lock.current = false; if (mounted.current) setBusy(""); }
  }

  return <section className="admin-hosted-checkout" aria-labelledby="magiclight-live-test-title" aria-busy={loading || Boolean(busy)}>
    <div className="admin-section-heading"><div>
      <h2 id="magiclight-live-test-title">MagicLight live clip test</h2>
      <p>One fictional clip using existing MagicLight credits. The credit cost and output duration are unknown. This test does not create a customer payment or fulfill a paid film.</p>
    </div><button type="button" className="button secondary small" disabled={disabled || loading || Boolean(busy)} onClick={() => setReload(value => value + 1)}>
      <RefreshCw size={15} aria-hidden="true" />Refresh saved test
    </button></div>
    <div style={{ display: "flex", flexWrap: "wrap", gap: 20, marginBottom: 20 }}>
      <img src={fixture.imageUrl} alt="Illustrated shipyard used for the fictional live clip test" width={320} height={180}
        style={{ maxWidth: "100%", height: "auto", objectFit: "cover", borderRadius: 8 }} />
      <div style={{ flex: "1 1 280px" }}><h3>{fixture.title}</h3><p className="field-note">{fixture.prompt}</p></div>
    </div>
    <div role="status" aria-live="polite">
      {loading ? <p>Loading the saved live test…</p> : test ? <p><strong>{statusText(test.status)}</strong></p>
        : state && !state.configured ? <p>This deployment has no saved MagicLight key.</p>
        : attempted ? <p>The submission result needs verification. Refresh the saved test before taking further action.</p>
        : state ? <p>No live test has been saved.</p> : null}
      {busy && <p><Loader2 size={15} className="spin" aria-hidden="true" /> {busy === "submit" ? "Submitting the single live test…" : "Checking the saved provider job…"}</p>}
    </div>
    {test && <div className="admin-feedback info">
      <p className="field-note">One submission · Saved {new Date(test.updatedAt).toLocaleString()}
        {test.checkedAt ? ` · Checked ${new Date(test.checkedAt).toLocaleString()}` : ""}</p>
      {(test.code || test.providerCode !== undefined || test.httpStatus !== undefined || test.taskStatus !== undefined) && <p className="field-note">
        {[test.code, test.providerCode !== undefined ? `Provider code ${test.providerCode}` : "",
          test.httpStatus !== undefined ? `HTTP ${test.httpStatus}` : "", test.taskStatus !== undefined ? `Task status ${test.taskStatus}` : ""].filter(Boolean).join(" · ")}
      </p>}
      {test.outputOrigin && <p className="field-note" style={{ overflowWrap: "anywhere" }}>Output origin: {test.outputOrigin}</p>}
    </div>}
    {error && <div className="admin-inline-error" role="alert">
      <p>The action could not be verified. Refresh the saved test to recover its status.</p>
      <p>{error.code}{error.httpStatus ? ` · HTTP ${error.httpStatus}` : ""}</p>
    </div>}
    {state && !test && !attempted && <fieldset disabled={blocked || !canSubmit}>
      <label className="consent"><input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} />
        <span>I authorize one live clip test using existing MagicLight credits, with unverified credit cost and duration.</span>
      </label>
      <div><button type="button" className="button primary small" disabled={blocked || !canSubmit || !consent} onClick={() => void operate("submit")}>Generate one live test clip</button></div>
    </fieldset>}
    {test && canCheck && <button type="button" className="button secondary small" disabled={blocked} onClick={() => void operate("check")}>
      <RefreshCw size={15} aria-hidden="true" />Check saved job
    </button>}
  </section>;
}
