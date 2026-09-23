import { useEffect, useRef, useState, type FormEvent, type MutableRefObject } from "react";
import { AlertCircle, CheckCircle2, Loader2, RefreshCw, Save } from "lucide-react";
import { api, ApiError } from "../studio/model";
import { normalizeSourceAgreement, type SourceAgreement } from "../source-agreement";

const errorMessage = (cause: unknown) => cause instanceof Error ? cause.message : "The source agreement could not be saved. Reload the current agreement before trying again.";

export default function SourceAgreementEditor({ disabled, actionLock, onBusyChange }: {
  disabled: boolean;
  actionLock: MutableRefObject<boolean>;
  onBusyChange: (busy: boolean) => void;
}) {
  const [saved, setSaved] = useState<SourceAgreement | null>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [consentLabel, setConsentLabel] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const [reload, setReload] = useState(0);
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    let active = true;
    setLoading(true); setError(""); setMessage("");
    void api<unknown>("/api/admin?action=agreement")
      .then(value => {
        const agreement = normalizeSourceAgreement(value);
        if (active) {
          setSaved(agreement); setTitle(agreement.title); setBody(agreement.body); setConsentLabel(agreement.consentLabel);
          setNeedsRefresh(false);
        }
      })
      .catch(cause => { if (active) { setError(errorMessage(cause)); setNeedsRefresh(true); } })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [reload]);

  const changed = Boolean(saved && (title.trim() !== saved.title || body.trim() !== saved.body || consentLabel.trim() !== saved.consentLabel));
  const valid = title.trim().length > 0 && title.length <= 160 && body.trim().length > 0 && body.length <= 10_000
    && consentLabel.trim().length > 0 && consentLabel.length <= 500;
  const blocked = disabled || loading || saving;

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!saved || blocked || needsRefresh || !changed || !valid || actionLock.current) return;
    actionLock.current = true;
    setSaving(true); setError(""); setMessage(""); onBusyChange(true);
    let responseReceived = false;
    try {
      const published = normalizeSourceAgreement(await api<unknown>("/api/admin", {
        action: "updateAgreement", revision: saved.revision, title: title.trim(), body: body.trim(), consentLabel: consentLabel.trim(),
      }));
      responseReceived = true;
      if (published.revision !== saved.revision + 1) throw new Error("The agreement's new revision could not be confirmed.");
      const readback = normalizeSourceAgreement(await api<unknown>("/api/admin?action=agreement"));
      if (readback.version !== published.version || readback.contentHash !== published.contentHash
        || readback.title !== published.title || readback.body !== published.body || readback.consentLabel !== published.consentLabel) {
        throw new Error("The current agreement changed before its saved version could be confirmed.");
      }
      if (mounted.current) {
        setSaved(readback); setTitle(readback.title); setBody(readback.body); setConsentLabel(readback.consentLabel);
        setNeedsRefresh(false); setMessage("Agreement saved and verified. New registrations will use this version; previously signed records are unchanged.");
      }
    } catch (cause) {
      if (mounted.current) {
        const conflict = cause instanceof ApiError && cause.status === 409;
        const invalidDraft = !responseReceived && cause instanceof ApiError && cause.status === 400;
        setError(`${responseReceived ? "A save response was received, but its current version could not be verified. " : ""}${errorMessage(cause)}${invalidDraft ? " Your edits are still shown for correction." : conflict ? " Your edits are still shown. Reload the current agreement before applying changes again." : " Reload the current agreement before another save."}`);
        setNeedsRefresh(!invalidDraft);
      }
    } finally {
      actionLock.current = false; onBusyChange(false);
      if (mounted.current) setSaving(false);
    }
  }

  return <section className="admin-source-agreement" aria-labelledby="admin-source-agreement-title" aria-busy={loading || saving}>
    <div className="admin-source-agreement-heading">
      <div>
        <h2 id="admin-source-agreement-title">Source agreement</h2>
        <p>Set the source ownership, third-party sharing, and reuse terms that people must accept when creating an account.</p>
        <p>Changes apply to new registrations. Each earlier signed agreement stays with its original version and signature record.</p>
      </div>
      <button className="button secondary small" type="button" disabled={blocked}
        onClick={() => { if (!actionLock.current) setReload(value => value + 1); }}>
        <RefreshCw size={15} /> Reload current agreement
      </button>
    </div>
    {loading && <p className="admin-loading" role="status"><Loader2 size={17} className="spin" /> Loading the current agreement…</p>}
    {error && <div className="admin-feedback error" role="alert"><AlertCircle size={18} /><p>{error}</p></div>}
    {message && <div className="admin-feedback success" role="status"><CheckCircle2 size={18} /><p>{message}</p></div>}
    {saved && <>
      <div className="admin-card admin-source-agreement-meta">
        <p><strong>Saved revision:</strong> {saved.revision} · <strong>Updated:</strong> {saved.updatedAt ? new Date(saved.updatedAt).toLocaleString() : "Initial agreement"}</p>
        <p><strong>Version:</strong> <span>{saved.version}</span></p>
        <a href={`/source-agreement.html?version=${encodeURIComponent(saved.version)}`} target="_blank" rel="noopener noreferrer">Read this saved version</a>
      </div>
      <div className="admin-source-agreement-columns">
        <form className="admin-card admin-source-agreement-form" onSubmit={save}>
          <h3>Edit registration agreement</h3>
          <p className="field-note">Plain text only. Explain ownership and third-party sharing clearly in the body and in the required checkbox label.</p>
          <label>Agreement title
            <input value={title} maxLength={160} required disabled={blocked} onChange={event => { setTitle(event.target.value); setMessage(""); }} />
          </label>
          <label>Agreement text
            <textarea value={body} maxLength={10_000} rows={18} required disabled={blocked} onChange={event => { setBody(event.target.value); setMessage(""); }} />
          </label>
          <label>Required checkbox label
            <textarea value={consentLabel} maxLength={500} rows={5} required disabled={blocked} onChange={event => { setConsentLabel(event.target.value); setMessage(""); }} />
          </label>
          <p className="field-note">Use one paragraph for the checkbox label, without line breaks.</p>
          <p className="field-note">The person's entered full legal name is their electronic signature when they check this box and create an account.</p>
          <button className="button primary" disabled={blocked || needsRefresh || !changed || !valid}>
            {saving ? <Loader2 size={16} className="spin" /> : <Save size={16} />}{saving ? "Saving and verifying…" : "Save agreement"}
          </button>
          {changed && <p className="field-note">Unsaved changes. Reloading the current agreement replaces the edits shown here.</p>}
        </form>
        <section className="admin-card admin-source-agreement-preview" aria-labelledby="source-agreement-preview-title">
          <h3 id="source-agreement-preview-title">Registration preview</h3>
          <p className="field-note">Preview of your edits. This becomes available to new registrants only after a successful save.</p>
          <h4>{title || "Agreement title"}</h4>
          <div className="source-agreement-text">{body || "Agreement text"}</div>
          <div className="admin-source-agreement-preview-consent"><span aria-hidden="true">□</span><p>{consentLabel || "Required checkbox label"}</p></div>
          <p className="field-note">Electronic signature: the registrant's full legal name</p>
        </section>
      </div>
    </>}
  </section>;
}
