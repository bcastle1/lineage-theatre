import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import { api } from '../studio/model';
import { libraryFilmLink } from '../studio/film-library';
import { NARRATION_PLAN_MAX_BYTES, parseNarrationSuccessorPlan, narrationSuccessorRequest, verifyNarrationSuccessor,
  type NarrationSuccessorPlan, type NarrationSuccessorResult } from './narration-successor-correction';

export default function NarrationSuccessorCorrectionPanel({ disabled, actionLock, onBusyChange }: {
  disabled: boolean; actionLock: MutableRefObject<boolean>; onBusyChange: (busy: boolean) => void;
}) {
  const [plan, setPlan] = useState<NarrationSuccessorPlan | null>(null), [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [attempt, setAttempt] = useState<ReturnType<typeof narrationSuccessorRequest> | null>(null);
  const [result, setResult] = useState<NarrationSuccessorResult | null>(null);
  const mounted = useRef(false), fileRead = useRef(0);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; fileRead.current++; }; }, []);
  async function importPlan(file?: File) {
    if (disabled || busy || attempt) return;
    const revision = ++fileRead.current;
    setPlan(null); setConfirmed(false); setError('');
    if (!file) return;
    try {
      if (file.size > NARRATION_PLAN_MAX_BYTES) throw new Error('The narration recovery plan must be 30 KB or smaller.');
      const next = parseNarrationSuccessorPlan(await file.text());
      if (mounted.current && revision === fileRead.current) setPlan(next);
    } catch (cause) {
      if (mounted.current && revision === fileRead.current) setError(cause instanceof Error ? cause.message : 'The recovery plan could not be read.');
    }
  }
  async function submit() {
    if (disabled || busy || actionLock.current || result || !plan || !confirmed) return;
    let request: ReturnType<typeof narrationSuccessorRequest>;
    try { request = attempt ?? narrationSuccessorRequest(plan, confirmed); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Review the narration recovery plan.'); return; }
    actionLock.current = true; setBusy(true); onBusyChange(true); setAttempt(request); setError('');
    const controller = new AbortController(), timeout = window.setTimeout(() => controller.abort(), 185_000);
    try {
      const saved = verifyNarrationSuccessor(await api('/api/admin', request, { signal: controller.signal }), request);
      if (mounted.current) setResult(saved);
    } catch (cause) {
      if (mounted.current) setError(`${controller.signal.aborted ? 'The recovery request did not respond in time.' : cause instanceof Error ? cause.message : 'The revised film could not be confirmed.'} Check the film first. Reconciliation uses this exact saved request and cannot authorize another version.`);
    } finally {
      window.clearTimeout(timeout); actionLock.current = false; onBusyChange(false);
      if (mounted.current) setBusy(false);
    }
  }
  return <details className="admin-hosted-checkout">
    <summary>Recover a scene with approved narration</summary>
    <p>Owner action: create one corrected version with an approved narration change. Keep the three completed clips, the approved visual design and timing, and coverage under the original payment.</p>
    <label>Reviewed narration recovery plan<input type="file" accept=".json,application/json" disabled={disabled || busy || Boolean(attempt)}
      onChange={event => void importPlan(event.target.files?.[0])} /></label>
    <p className="field-note">Choosing a file opens it for review. It does not start production.</p>
    {plan && <form onSubmit={event => { event.preventDefault(); void submit(); }}>
      <p><strong>Revised narration for {plan.shotId}</strong><br />{plan.narration}</p>
      <p>The other three clips, this scene's approved visual design, and the film's timing stay unchanged.</p>
      <p><strong>Maximum new production cost: ${(plan.maximumNewCostCents / 100).toFixed(2)}</strong><br />
        This must fit the original reserved allowance. No additional customer invoice is created.</p>
      <p className="field-note">The server verifies the prior failures, reviewed zero-charge billing evidence and original payment before authorizing production.</p>
      <label className="consent"><input type="checkbox" checked={confirmed} disabled={disabled || busy || Boolean(attempt)}
        onChange={event => setConfirmed(event.target.checked)} />I approve this exact narration revision and one bounded scene render.</label>
      <button type="submit" className="button primary small" disabled={disabled || busy || !confirmed || Boolean(result)}>
        {busy ? 'Verifying and authorizing recovery…' : result ? 'Narration recovery authorized' : attempt ? 'Reconcile this exact recovery' : 'Start approved narration recovery'}</button>
    </form>}
    {error && <p role="alert">{error}</p>}
    {result && <p role="status">The revised film is authorized under the original payment. It will be available after production and delivery checks finish.</p>}
    {attempt && <p><a className="text-button" href={libraryFilmLink(attempt.preparedId)}>View revised film status</a></p>}
  </details>;
}
