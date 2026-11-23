import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import { api } from '../studio/model';
import { libraryFilmLink } from '../studio/film-library';
import { PARTIAL_RETRY_MAX_BYTES, parsePartialRetryPlan, partialRetryRequest, verifyPartialRetry,
  type PartialRetryPlan, type PartialRetryResult } from './partial-production-retry';

export default function PartialProductionRetryPanel({ disabled, actionLock, onBusyChange }: {
  disabled: boolean; actionLock: MutableRefObject<boolean>; onBusyChange: (busy: boolean) => void;
}) {
  const [plan, setPlan] = useState<PartialRetryPlan | null>(null), [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [attempt, setAttempt] = useState<ReturnType<typeof partialRetryRequest> | null>(null);
  const [result, setResult] = useState<PartialRetryResult | null>(null);
  const mounted = useRef(false), fileRead = useRef(0);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; fileRead.current++; }; }, []);
  async function importPlan(file?: File) {
    if (disabled || busy || attempt) return;
    const revision = ++fileRead.current;
    setPlan(null); setConfirmed(false); setError('');
    if (!file) return;
    try {
      if (file.size > PARTIAL_RETRY_MAX_BYTES) throw new Error('The retry plan must be 30 KB or smaller.');
      const next = parsePartialRetryPlan(await file.text());
      if (mounted.current && revision === fileRead.current) setPlan(next);
    } catch (cause) {
      if (mounted.current && revision === fileRead.current) setError(cause instanceof Error ? cause.message : 'The retry plan could not be read.');
    }
  }
  async function submit() {
    if (disabled || busy || actionLock.current || result || !plan || !confirmed) return;
    let request: ReturnType<typeof partialRetryRequest>;
    try { request = attempt ?? partialRetryRequest(plan, confirmed); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Review the retry plan.'); return; }
    actionLock.current = true; setBusy(true); onBusyChange(true); setAttempt(request); setError('');
    const controller = new AbortController(), timeout = window.setTimeout(() => controller.abort(), 185_000);
    try {
      const saved = verifyPartialRetry(await api('/api/admin', request, { signal: controller.signal }), request);
      if (mounted.current) setResult(saved);
    } catch (cause) {
      if (mounted.current) setError(`${controller.signal.aborted ? 'The retry request did not respond in time.' : cause instanceof Error ? cause.message : 'The retry could not be confirmed.'} Check the film first. Reconciliation uses this exact saved request and cannot authorize another attempt.`);
    } finally {
      window.clearTimeout(timeout); actionLock.current = false; onBusyChange(false);
      if (mounted.current) setBusy(false);
    }
  }
  return <details className="admin-hosted-checkout">
    <summary>Retry a scene after a provider service failure</summary>
    <p>Owner action: retry the unchanged scene once after a verified provider service failure. The three completed clips and the original payment are retained.</p>
    <label>Reviewed scene retry plan<input type="file" accept=".json,application/json" disabled={disabled || busy || Boolean(attempt)}
      onChange={event => void importPlan(event.target.files?.[0])} /></label>
    <p className="field-note">Choosing a file opens it for review. It does not start production.</p>
    {plan && <form onSubmit={event => { event.preventDefault(); void submit(); }}>
      <p><strong>Failed scene</strong><br />{plan.shotId}<br /><span style={{ overflowWrap: 'anywhere' }}>{plan.failedRequestId}</span></p>
      <p>The approved scene design, narration and running time stay unchanged. Three completed clips will be kept.</p>
      <p><strong>Maximum new production cost: ${(plan.maximumNewCostCents / 100).toFixed(2)}</strong><br />
        This must fit the original reserved allowance. No additional customer invoice is created.</p>
      <p className="field-note">The server verifies the failed request and fal's server-error billing policy before authorizing the retry.</p>
      <label className="consent"><input type="checkbox" checked={confirmed} disabled={disabled || busy || Boolean(attempt)}
        onChange={event => setConfirmed(event.target.checked)} />I approve one retry of this unchanged scene within the existing allowance.</label>
      <button type="submit" className="button primary small" disabled={disabled || busy || !confirmed || Boolean(result)}>
        {busy ? 'Verifying and authorizing retry…' : result ? 'Retry authorized' : attempt ? 'Reconcile this exact retry' : 'Start approved scene retry'}</button>
    </form>}
    {error && <p role="alert">{error}</p>}
    {result && <p role="status">The scene retry is authorized. The film remains covered by the original payment and will be available after production and delivery checks finish.</p>}
    {attempt && <p><a className="text-button" href={libraryFilmLink(attempt.preparedId)}>View corrected film status</a></p>}
  </details>;
}
