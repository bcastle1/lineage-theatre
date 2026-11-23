import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import { api } from '../studio/model';
import { libraryFilmLink } from '../studio/film-library';
import { PARTIAL_PLAN_MAX_BYTES, parsePartialCorrectionPlan, partialCorrectionRequest, verifyPartialCorrection,
  type PartialCorrectionPlan, type PartialCorrectionResult } from './partial-production-correction';

export default function PartialProductionCorrectionPanel({ disabled, actionLock, onBusyChange }: {
  disabled: boolean; actionLock: MutableRefObject<boolean>; onBusyChange: (busy: boolean) => void;
}) {
  const [plan, setPlan] = useState<PartialCorrectionPlan | null>(null), [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [attempt, setAttempt] = useState<ReturnType<typeof partialCorrectionRequest> | null>(null);
  const [result, setResult] = useState<PartialCorrectionResult | null>(null);
  const mounted = useRef(false), fileRead = useRef(0);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; fileRead.current++; }; }, []);
  async function importPlan(file?: File) {
    if (disabled || busy || attempt) return;
    const revision = ++fileRead.current;
    setPlan(null); setConfirmed(false); setError('');
    if (!file) return;
    try {
      if (file.size > PARTIAL_PLAN_MAX_BYTES) throw new Error('The recovery plan must be 30 KB or smaller.');
      const next = parsePartialCorrectionPlan(await file.text());
      if (mounted.current && revision === fileRead.current) setPlan(next);
    } catch (cause) {
      if (mounted.current && revision === fileRead.current) setError(cause instanceof Error ? cause.message : 'The plan could not be read.');
    }
  }
  async function submit() {
    if (disabled || busy || actionLock.current || result || !plan || !confirmed) return;
    let request: ReturnType<typeof partialCorrectionRequest>;
    try { request = attempt ?? partialCorrectionRequest(plan, confirmed); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Review the recovery plan.'); return; }
    actionLock.current = true; setBusy(true); onBusyChange(true); setAttempt(request); setError('');
    const controller = new AbortController(), timeout = window.setTimeout(() => controller.abort(), 65_000);
    try {
      const saved = verifyPartialCorrection(await api('/api/admin', request, { signal: controller.signal }), request);
      if (mounted.current) setResult(saved);
    } catch (cause) {
      if (mounted.current) setError(`${controller.signal.aborted ? 'The recovery request did not respond in time.' : cause instanceof Error ? cause.message : 'The recovery request could not be confirmed.'} Check the corrected film. A retry here uses the same saved request.`);
    } finally {
      window.clearTimeout(timeout); actionLock.current = false; onBusyChange(false);
      if (mounted.current) setBusy(false);
    }
  }
  return <details className="admin-hosted-checkout">
    <summary>Recover one scene using completed footage</summary>
    <p>Owner action: review a prepared recovery plan for a paid film. Three verified clips are reused, and only the approved scene can be generated. The original payment covers the corrected version.</p>
    <label>Reviewed scene recovery plan<input type="file" accept=".json,application/json" disabled={disabled || busy || Boolean(attempt)}
      onChange={event => void importPlan(event.target.files?.[0])} /></label>
    <p className="field-note">Choosing a file opens it for review. The plan is submitted only when you confirm and start recovery.</p>
    {plan && <form onSubmit={event => { event.preventDefault(); void submit(); }}>
      <p><strong>Original payment reference</strong><br /><span style={{ overflowWrap: 'anywhere' }}>{plan.originalOrderId}</span></p>
      <p><strong>Approved replacement scene</strong><br />{plan.visual}</p>
      <p>Three completed clips will be reused. Narration, cast, sources and running time must match the original.</p>
      <p><strong>Maximum new production cost: ${(plan.maximumNewCostCents / 100).toFixed(2)}</strong><br />
        The server must verify that this fits the original reserved allowance. No new customer invoice is created.</p>
      <label className="consent"><input type="checkbox" checked={confirmed} disabled={disabled || busy || Boolean(attempt)}
        onChange={event => setConfirmed(event.target.checked)} />I approve this scene revision and one bounded render within the existing allowance.</label>
      <button type="submit" className="button primary small" disabled={disabled || busy || !confirmed || Boolean(result)}>
        {busy ? 'Starting recovery…' : result ? 'Recovery authorized' : attempt ? 'Retry this exact recovery' : 'Start approved scene recovery'}</button>
    </form>}
    {error && <p role="alert">{error}</p>}
    {result && <p role="status">Recovery is authorized under the original payment. The corrected film will be available after production and delivery checks finish.</p>}
    {attempt && <p><a className="text-button" href={libraryFilmLink(attempt.preparedId)}>View corrected film status</a></p>}
  </details>;
}
