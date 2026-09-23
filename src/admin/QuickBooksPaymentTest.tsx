import { useEffect, useRef, useState, type MutableRefObject } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { api } from "../studio/model";

type TestStatus = "tokenization-failed" | "submitting" | "captured" | "declined" | "uncertain" | "refund-pending" | "refunded";
type PaymentTest = {
  status: TestStatus;
  chargeVerified: boolean;
  refundVerified: boolean;
  chargeId: string | null;
  refundId: string | null;
  requestId: string;
  refundRequestId: string;
  createdAt: string;
  updatedAt: string;
};
type PaymentTestState = {
  available: boolean;
  environment: "sandbox" | null;
  amountCents: 100;
  currency: "USD";
  message: string;
  test: PaymentTest | null;
};
const statuses = new Set<TestStatus>(["tokenization-failed", "submitting", "captured", "declined", "uncertain", "refund-pending", "refunded"]);
function normalize(value: unknown): PaymentTestState {
  if (!value || typeof value !== "object") throw new Error("The saved payment test could not be verified.");
  const state = value as PaymentTestState;
  const reference = (id: unknown) => id === null || (typeof id === "string" && id.length > 0 && id.length <= 200);
  if (typeof state.available !== "boolean" || !["sandbox", null].includes(state.environment)
    || (state.available && state.environment !== "sandbox") || state.amountCents !== 100 || state.currency !== "USD"
    || typeof state.message !== "string" || state.message.length > 2000
    || (state.test !== null && (!state.test || !statuses.has(state.test.status)
      || typeof state.test.chargeVerified !== "boolean" || typeof state.test.refundVerified !== "boolean"
      || !reference(state.test.chargeId) || !reference(state.test.refundId)
      || typeof state.test.requestId !== "string" || !state.test.requestId || state.test.requestId.length > 200
      || typeof state.test.refundRequestId !== "string" || !state.test.refundRequestId || state.test.refundRequestId.length > 200
      || typeof state.test.createdAt !== "string" || typeof state.test.updatedAt !== "string"
      || !Number.isFinite(Date.parse(state.test.createdAt)) || !Number.isFinite(Date.parse(state.test.updatedAt))))) {
    throw new Error("The saved payment test could not be verified. Refresh its status before continuing.");
  }
  return state;
}
function statusMessage(test: PaymentTest) {
  switch (test.status) {
    case "tokenization-failed": return "Test card could not be prepared. No charge was attempted. Retry the test.";
    case "captured": return test.chargeVerified ? "Sandbox charge verified. You can now test the refund." : "Sandbox charge recorded. Check status to verify it with Intuit.";
    case "refunded": return test.refundVerified ? "Sandbox refund verified. Customer payments remain separate." : "Sandbox refund recorded. Check status to verify it with Intuit.";
    case "declined": return "The sandbox charge was declined. Review the saved result before changing the connection.";
    case "refund-pending": return "The sandbox refund needs verification. Check its status before taking another action.";
    case "submitting": return "The sandbox charge request is recorded. Its result still needs verification.";
    case "uncertain": return "The sandbox result is uncertain. Review the saved status; another charge will not be submitted.";
  }
}
const errorMessage = (error: unknown) => error instanceof Error ? error.message : "The payment test could not be checked. Refresh its saved status.";

export default function QuickBooksPaymentTest({ disabled, connectionRevision, actionLock, onBusyChange }: {
  disabled: boolean;
  connectionRevision?: number;
  actionLock: MutableRefObject<boolean>;
  onBusyChange: (busy: boolean) => void;
}) {
  const [state, setState] = useState<PaymentTestState | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const [reload, setReload] = useState(0);
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    let active = true;
    setLoading(true); setError("");
    void api<unknown>("/api/quickbooks?action=paymentTest")
      .then(value => { if (active) { setState(normalize(value)); setNeedsRefresh(false); } })
      .catch(cause => { if (active) { setError(errorMessage(cause)); setNeedsRefresh(true); } })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [connectionRevision, reload]);

  const test = state?.test;
  const canCharge = state?.available === true && state.environment === "sandbox" && (state.test === null || test?.status === "tokenization-failed");
  const canCheck = state?.environment === "sandbox" && Boolean(test?.chargeId || test?.refundId);
  const canRefund = state?.environment === "sandbox" && test?.status === "captured" && test.chargeVerified;
  const blocked = disabled || loading || Boolean(busy) || needsRefresh;

  async function operate(operation: "charge" | "check" | "refund") {
    if (blocked || actionLock.current || !(operation === "charge" ? canCharge : operation === "refund" ? canRefund : canCheck)) return;
    actionLock.current = true;
    const label = operation === "charge" ? "Submitting sandbox charge…" : operation === "refund" ? "Submitting sandbox refund…" : "Checking Intuit's saved result…";
    setBusy(label); setError(""); onBusyChange(true);
    try {
      const result = normalize(await api<unknown>("/api/quickbooks", { action: "testPayment", operation }));
      if (mounted.current) { setState(result); setNeedsRefresh(false); }
    } catch (cause) {
      if (mounted.current) {
        setError(`${errorMessage(cause)} Refresh the saved test before another action.`);
        setNeedsRefresh(true);
      }
    } finally {
      actionLock.current = false;
      onBusyChange(false);
      if (mounted.current) setBusy("");
    }
  }

  return <section className="admin-quickbooks-company admin-payment-test" aria-labelledby="quickbooks-payment-test-title" aria-busy={loading || Boolean(busy)}>
    <div className="admin-quickbooks-company-heading">
      <div>
        <h3 id="quickbooks-payment-test-title">Sandbox payment verification</h3>
        <p>Fixed $1.00 USD test. No real money moves. Uses a fictional Intuit test card. Does not start a film.</p>
      </div>
      <button className="button secondary small" disabled={disabled || loading || Boolean(busy)} onClick={() => setReload(value => value + 1)}>
        <RefreshCw size={15} />Refresh saved test
      </button>
    </div>
    <div className="admin-payment-test-status" role="status" aria-live="polite">
      {loading ? <p>Loading the saved sandbox test…</p> : state ? <>
        <p>{state.message}</p>
        {test ? <p><strong>{statusMessage(test)}</strong></p> : state.available ? <p>One test charge is available for this saved QuickBooks authorization.</p> : null}
      </> : null}
      {busy && <p><Loader2 size={15} className="spin" />{busy}</p>}
    </div>
    {test && <dl>
      <div><dt>Charge readback</dt><dd>{test.chargeVerified ? "Verified with Intuit" : "Not verified"}</dd></div>
      <div><dt>Refund readback</dt><dd>{test.refundVerified ? "Verified with Intuit" : "Not verified"}</dd></div>
      {test.chargeId && <div><dt>Sandbox charge reference</dt><dd>{test.chargeId}</dd></div>}
      {test.refundId && <div><dt>Sandbox refund reference</dt><dd>{test.refundId}</dd></div>}
      <div><dt>Charge request reference</dt><dd>{test.requestId}</dd></div>
      <div><dt>Refund request reference</dt><dd>{test.refundRequestId}</dd></div>
      <div><dt>Saved test updated</dt><dd>{new Date(test.updatedAt).toLocaleString()}</dd></div>
    </dl>}
    {error && <div className="admin-inline-error" role="alert">{error}</div>}
    <div className="admin-quickbooks-actions admin-payment-test-actions">
      {(!test || test.status === "tokenization-failed") && <button className="button secondary small" disabled={blocked || !canCharge} onClick={() => void operate("charge")}>{test ? "Retry $1.00 sandbox test" : "Run $1.00 sandbox charge"}</button>}
      {test && <button className="button secondary small" disabled={blocked || !canCheck} onClick={() => void operate("check")}>Check status with Intuit</button>}
      {test?.status === "captured" && <button className="button secondary small" disabled={blocked || !canRefund} onClick={() => void operate("refund")}>Refund sandbox charge</button>}
    </div>
    <p className="admin-fineprint">This verifies the saved sandbox transaction only. It does not enable customer checkout or live payments.</p>
  </section>;
}
