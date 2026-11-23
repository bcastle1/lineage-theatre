import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import { api } from '../studio/model';
import { libraryFilmLink } from '../studio/film-library';
import { CONTEXT_PLAN_MAX_BYTES, parseContextSuccessorPlan, contextSuccessorRequest, verifyContextSuccessor,
  type ContextSuccessorPlan, type ContextSuccessorResult } from './context-successor-correction';

export default function ContextSuccessorCorrectionPanel({ disabled, actionLock, onBusyChange }: {
  disabled: boolean; actionLock: MutableRefObject<boolean>; onBusyChange: (busy: boolean) => void;
}) {
  const [plan, setPlan] = useState<ContextSuccessorPlan | null>(null), [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [attempt, setAttempt] = useState<ReturnType<typeof contextSuccessorRequest> | null>(null);
  const [result, setResult] = useState<ContextSuccessorResult | null>(null);
  const mounted = useRef(false), fileRead = useRef(0);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; fileRead.current++; }; }, []);
  async function importPlan(file?: File) {
    if (disabled || busy || attempt) return;
    const revision = ++fileRead.current;
    setPlan(null); setConfirmed(false); setError('');
    if (!file) return;
    try {
      if (file.size > CONTEXT_PLAN_MAX_BYTES) throw new Error('The scene instruction recovery plan must be 30 KB or smaller.');
      const next = parseContextSuccessorPlan(await file.text());
      if (mounted.current && revision === fileRead.current) setPlan(next);
    } catch (cause) {
      if (mounted.current && revision === fileRead.current) setError(cause instanceof Error ? cause.message : 'The recovery plan could not be read.');
    }
  }
  async function submit() {
    if (disabled || busy || actionLock.current || result || !plan || !confirmed) return;
    let request: ReturnType<typeof contextSuccessorRequest>;
    try { request = attempt ?? contextSuccessorRequest(plan, confirmed); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Review the scene instruction recovery plan.'); return; }
    actionLock.current = true; setBusy(true); onBusyChange(true); setAttempt(request); setError('');
    const controller = new AbortController(), timeout = window.setTimeout(() => controller.abort(), 185_000);
    try {
      const saved = verifyContextSuccessor(await api('/api/admin', request, { signal: controller.signal }), request);
      if (mounted.current) setResult(saved);
    } catch (cause) {
      if (mounted.current) setError(`${controller.signal.aborted ? 'The recovery request did not respond in time.' : cause instanceof Error ? cause.message : 'The corrected film could not be confirmed.'} Check the film first. Reconciliation uses this exact saved request and cannot authorize another version.`);
    } finally {
      window.clearTimeout(timeout); actionLock.current = false; onBusyChange(false);
      if (mounted.current) setBusy(false);
    }
  }
  return <details className="admin-hosted-checkout">
    <summary>Recover a scene with approved background instructions</summary>
    <p>Owner action: revise two background rendering instructions for one scene. Keep the approved narration, visual design, timing and three completed clips under the original payment.</p>
    <label>Reviewed scene instruction recovery plan<input type="file" accept=".json,application/json" disabled={disabled || busy || Boolean(attempt)}
      onChange={event => void importPlan(event.target.files?.[0])} /></label>
    <p className="field-note">Choosing a file opens it for review. It does not start production.</p>
    {plan && <form onSubmit={event => { event.preventDefault(); void submit(); }}>
      <p><strong>Revised instructions for {plan.shotId}</strong></p>
      <p><strong>Film context:</strong> {plan.filmContext}</p>
      <p><strong>Historical boundaries:</strong> {plan.historicalBoundaries}</p>
      <p>The narration, dialogue, visual design, other three clips and film timing stay unchanged.</p>
      <p><strong>Maximum new production cost: ${(plan.maximumNewCostCents / 100).toFixed(2)}</strong><br />
        This must fit the original reserved allowance. No additional customer invoice is created.</p>
      <p className="field-note">The server verifies the prior failures, reviewed zero-charge billing evidence and original payment before authorizing production.</p>
      <label className="consent"><input type="checkbox" checked={confirmed} disabled={disabled || busy || Boolean(attempt)}
        onChange={event => setConfirmed(event.target.checked)} />I approve these exact scene instructions and one bounded scene render.</label>
      <button type="submit" className="button primary small" disabled={disabled || busy || !confirmed || Boolean(result)}>
        {busy ? 'Verifying and authorizing scene recovery…' : result ? 'Scene recovery authorized' : attempt ? 'Reconcile this exact scene recovery' : 'Start approved scene recovery'}</button>
    </form>}
    {error && <p role="alert">{error}</p>}
    {result && <p role="status">The corrected film is authorized under the original payment. It will be available after production and delivery checks finish.</p>}
    {attempt && <p><a className="text-button" href={libraryFilmLink(attempt.preparedId)}>View corrected film status</a></p>}
  </details>;
}
