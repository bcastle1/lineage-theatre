import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Loader2, ShieldCheck } from "lucide-react";
import { api, type User } from "./studio/model";

type SecurityStatus = {
  emailVerified: boolean; emailVerificationAvailable: boolean;
  mfaAvailable: boolean; mfaEnabled: boolean; passwordExpiresAt: string | null;
};
type Enrollment = { secret: string; otpauthUri: string; expiresAt: string };

export default function AccountSecurity({ user, onUserChange, onClose, onBusyChange }: {
  user: User; onUserChange: (user: User) => void; onClose: () => void; onBusyChange?: (busy: boolean) => void;
}) {
  const [status, setStatus] = useState<SecurityStatus | null>(null);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [code, setCode] = useState("");
  const [recoveryCode, setRecoveryCode] = useState("");
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  useEffect(() => {
    let active = true;
    api<SecurityStatus>("/api/auth?action=security")
      .then(value => { if (active) setStatus(value); })
      .catch(e => { if (active) setError(e instanceof Error ? e.message : "Account settings could not load."); });
    return () => { active = false; };
  }, []);
  async function perform(action: string, body: Record<string, unknown> = {}) {
    if (lock.current) return;
    lock.current = true; setBusy(true); onBusyChange?.(true); setError(""); setMessage("");
    try {
      const result = await api<{ user?: User; message?: string; secret?: string; otpauthUri?: string; expiresAt?: string; recoveryCodes?: string[] }>("/api/auth", { action, ...body });
      if (result.user) onUserChange(result.user);
      if (result.secret && result.otpauthUri && result.expiresAt) setEnrollment({ secret: result.secret, otpauthUri: result.otpauthUri, expiresAt: result.expiresAt });
      if (result.recoveryCodes) setRecoveryCodes(result.recoveryCodes);
      if (["mfaConfirm", "mfaDisable"].includes(action)) setEnrollment(null);
      if (action === "mfaDisable") setRecoveryCodes([]);
      setCurrentPassword(""); setNewPassword(""); setConfirm(""); setCode(""); setRecoveryCode("");
      setMessage(result.message || (action === "mfaBegin" ? "Add the setup key to your authenticator, then enter its six-digit code." : "Account settings saved."));
      try { setStatus(await api<SecurityStatus>("/api/auth?action=security")); }
      catch { setStatus(null); setMessage("Your request completed. Reopen account settings to refresh its status."); }
    } catch (e) { setError(e instanceof Error ? e.message : "The account change could not complete."); }
    finally { lock.current = false; setBusy(false); onBusyChange?.(false); }
  }
  return <section className="panel account-security" aria-labelledby="account-security-title">
    <div className="section-title"><div><h2 id="account-security-title">Account security</h2><p>{user.email}</p></div><ShieldCheck size={24} /></div>
    <button className="text-button" onClick={onClose} disabled={busy}><ArrowLeft size={16} /> Return to my film</button>
    {error && <p className="feedback error" role="alert">{error}</p>}
    {message && <p className="feedback success" role="status">{message}</p>}
    {!status && !error && <p role="status"><Loader2 className="spin" size={16} /> Loading account settings…</p>}
    <section className="readiness-panel">
      <h3>Email address</h3>
      <p>{status ? status.emailVerified ? "Your email address is verified." : "Your email address has not been verified." : "Verification status is unavailable."}</p>
      {status && !status.emailVerified && <>
        <button className="button secondary small" disabled={busy || !status.emailVerificationAvailable} onClick={() => void perform("emailVerificationRequest")}>Request verification email</button>
        {!status.emailVerificationAvailable && <p className="field-note">Email verification is not available yet. Your saved work remains accessible.</p>}
      </>}
    </section>
    <section className="readiness-panel">
      <h3>Change password</h3>
      {status?.passwordExpiresAt && <p className="field-note">Password renewal due {new Date(status.passwordExpiresAt).toLocaleDateString()}.</p>}
      <form className="login-form" onSubmit={event => {
        event.preventDefault();
        if (newPassword !== confirm) { setError("The two new passwords do not match."); return; }
        void perform("password", { currentPassword, password: newPassword });
      }}>
        <label>Current password<input type="password" autoComplete="current-password" required maxLength={128} disabled={busy} value={currentPassword} onChange={e => setCurrentPassword(e.target.value)} /></label>
        <label>New password<input type="password" autoComplete="new-password" required minLength={12} maxLength={128} disabled={busy} value={newPassword} onChange={e => setNewPassword(e.target.value)} /></label>
        <label>Confirm new password<input type="password" autoComplete="new-password" required minLength={12} maxLength={128} disabled={busy} value={confirm} onChange={e => setConfirm(e.target.value)} /></label>
        <p className="field-note">Use 12–128 characters. Avoid common passwords, your name, and your email address.</p>
        <button className="button secondary" disabled={busy || !status}>Save new password</button>
      </form>
    </section>
    <section className="readiness-panel">
      <h3>Authenticator sign-in</h3>
      <p>{status?.mfaEnabled ? "An authenticator code is required when you sign in." : "Add a second sign-in step using an authenticator app."}</p>
      {status && !status.mfaAvailable && <p className="field-note">{status.mfaEnabled ? "Authenticator verification is temporarily unavailable. Use a recovery code to manage your sign-in settings." : "Authenticator setup is not available yet."}</p>}
      {status && (status.mfaAvailable || status.mfaEnabled) && !enrollment && <form className="login-form" onSubmit={event => { event.preventDefault(); void perform(status.mfaEnabled ? "mfaRecoveryCodes" : "mfaBegin", { currentPassword, ...(code ? { code } : { recoveryCode }) }); }}>
        <label>Confirm your current password<input type="password" autoComplete="current-password" maxLength={128} required disabled={busy} value={currentPassword} onChange={e => setCurrentPassword(e.target.value)} /></label>
        {status.mfaEnabled && <>
          <label>Authenticator code<input autoComplete="one-time-code" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} disabled={busy || Boolean(recoveryCode)} value={code} onChange={e => setCode(e.target.value)} /></label>
          <label>Or use a recovery code<input autoComplete="off" maxLength={80} disabled={busy || Boolean(code)} value={recoveryCode} onChange={e => setRecoveryCode(e.target.value)} /></label>
        </>}
        <div className="action-group">
          <button className="button secondary" disabled={busy || (status.mfaEnabled && !code && !recoveryCode)}>{status.mfaEnabled ? "Replace recovery codes" : "Set up authenticator"}</button>
          {status.mfaEnabled && <button type="button" className="text-button" disabled={busy || !currentPassword || (!code && !recoveryCode)} onClick={() => void perform("mfaDisable", { currentPassword, ...(code ? { code } : { recoveryCode }) })}>Turn off authenticator sign-in</button>}
        </div>
      </form>}
      {enrollment && <form className="login-form" onSubmit={event => { event.preventDefault(); void perform("mfaConfirm", { code }); }}>
        <p>Add a time-based account in your authenticator app using this setup key. Keep the key private.</p>
        <code className="security-secret">{enrollment.secret}</code>
        <p className="field-note">Setup expires {new Date(enrollment.expiresAt).toLocaleTimeString()}.</p>
        <label>Six-digit authenticator code<input autoComplete="one-time-code" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} required disabled={busy} value={code} onChange={e => setCode(e.target.value)} /></label>
        <button className="button primary" disabled={busy}>Confirm authenticator</button>
      </form>}
      {recoveryCodes.length > 0 && <div role="status">
        <h4>Save these recovery codes privately</h4><p>Each code works once. These codes are shown only now; keep them somewhere safe before leaving this page.</p>
        <pre className="security-secret">{recoveryCodes.join("\n")}</pre>
        <button className="button secondary small" onClick={() => setRecoveryCodes([])}>I have saved my recovery codes</button>
      </div>}
    </section>
  </section>;
}
