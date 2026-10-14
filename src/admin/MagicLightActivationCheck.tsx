import { useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { api } from '../studio/model';

type ActivationState = {
  generationSubmitted: false; productionReady: false;
  test: null | { status: string; submittedAt: string; checkedAt?: string;
    providerCode?: number; taskStatus?: number; code?: string; finishedVideoAvailable: boolean };
};
const states = new Set(['submitting', 'submitted', 'uncertain', 'completed', 'failed']);
export function normalizeActivationStatus(value: unknown): ActivationState {
  const state = value as ActivationState;
  const test = state?.test;
  if (!state || state.generationSubmitted !== false || state.productionReady !== false
    || test !== null && (!test || !states.has(test.status) || !Number.isFinite(Date.parse(test.submittedAt))
      || test.checkedAt !== undefined && !Number.isFinite(Date.parse(test.checkedAt))
      || test.providerCode !== undefined && !Number.isSafeInteger(test.providerCode)
      || test.taskStatus !== undefined && !Number.isSafeInteger(test.taskStatus)
      || test.code !== undefined && !/^MAGICLIGHT_[A-Z_]{1,80}$/.test(test.code)
      || typeof test.finishedVideoAvailable !== 'boolean'
      || test.finishedVideoAvailable !== (test.status === 'completed'))) throw new Error('Invalid activation status');
  return state;
}

export default function MagicLightActivationCheck({ disabled = false }: { disabled?: boolean }) {
  const [state, setState] = useState<ActivationState | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState(false);
  const lock = useRef(false);
  useEffect(() => {
    let active = true;
    void api<unknown>('/api/admin?action=magicLightActivationStatus')
      .then(value => { if (active) setState(normalizeActivationStatus(value)); })
      .catch(() => { if (active) setError(true); })
      .finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, []);
  async function check() {
    if (disabled || busy || lock.current) return;
    lock.current = true; setBusy(true); setError(false);
    try { setState(normalizeActivationStatus(await api('/api/admin', { action: 'checkMagicLightActivationStatus' }))); }
    catch { setError(true); }
    finally { lock.current = false; setBusy(false); }
  }
  const test = state?.test;
  return <section className="admin-hosted-checkout" aria-labelledby="magiclight-activation-heading" aria-busy={busy}>
    <div className="admin-section-heading"><div>
      <h2 id="magiclight-activation-heading">October 8 MagicLight job</h2>
      <p>Check the existing activation test with the saved server connection. This does not create a job, spend generation credits, or charge a customer.</p>
    </div></div>
    <div role="status" aria-live="polite">
      {busy ? <p>Checking the saved job…</p> : test ? <>
        <p>{test.finishedVideoAvailable ? 'MagicLight reports a completed test video. This does not fulfill a paid customer film.'
          : test.status === 'failed' ? 'MagicLight reports that this test failed. No replacement job was submitted.'
          : 'No finished video is recorded for this test.'}</p>
        <p className="field-note">Submitted {new Date(test.submittedAt).toLocaleString()}
          {test.checkedAt ? ` · Last provider check ${new Date(test.checkedAt).toLocaleString()}` : ' · Not yet checked'}</p>
        <p className="field-note">{[`Saved state: ${test.status}`, test.providerCode !== undefined ? `Provider code ${test.providerCode}` : '',
          test.taskStatus !== undefined ? `Task status ${test.taskStatus}` : '', test.code || ''].filter(Boolean).join(' · ')}</p>
      </> : state ? <p>No saved October 8 task was found. No new job was submitted.</p> : null}
    </div>
    {error && <p className="admin-inline-error" role="alert">The status check could not be confirmed. No new job or customer payment was requested. Try the status check again.</p>}
    <button type="button" className="button secondary small" disabled={disabled || busy} onClick={() => void check()}>
      <RefreshCw size={15} aria-hidden="true" />Check October 8 job
    </button>
  </section>;
}
