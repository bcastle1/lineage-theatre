import { useEffect, useState, useRef, lazy, Suspense } from "react";
import {
  Aperture,
  ArrowRight,
  CheckCircle2,
  Loader2,
  LockKeyhole,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { api, type User } from "./studio/model";
import Landing from "./Landing";
import { captchaToken } from "./lib/captcha";
import CaptchaNotice from "./CaptchaNotice";
const Workspace = lazy(() => import("./studio/Workspace"));
const AccountSecurity = lazy(() => import("./AccountSecurity"));

function AccountWaiting({ user, onUserChange, onLogout, welcome }: {
  user: User;
  onUserChange: (user: User | null) => void;
  onLogout: () => Promise<void>;
  welcome: string;
}) {
  const [securityOpen, setSecurityOpen] = useState(false);
  const [securityBusy, setSecurityBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const requestLock = useRef(false);
  const securityUser = useRef<User | null>(null);
  const suspended = user.accessStatus === "suspended";
  function closeSecurity() {
    if (securityBusy) return;
    setSecurityOpen(false);
    if (securityUser.current) {
      onUserChange(securityUser.current);
      securityUser.current = null;
    }
  }
  async function refreshApproval() {
    if (requestLock.current || securityBusy) return;
    requestLock.current = true;
    setChecking(true);
    setError("");
    setMessage("");
    try {
      const result = await api<{ user: User | null }>("/api/auth");
      onUserChange(result.user);
      if (result.user && result.user.accessStatus !== "approved") {
        setMessage(result.user.accessStatus === "suspended"
          ? "Account access is still suspended. Contact the administrator for help."
          : "Your account is still awaiting approval. You can check again after an administrator approves it.");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Account status could not be checked. Please try again.");
    } finally {
      requestLock.current = false;
      setChecking(false);
    }
  }
  return <div className="account-waiting-shell">
    <header className="account-waiting-header">
      <a href="/" className="login-brand"><Aperture size={28} strokeWidth={1.3} /><span>Lineage Theatre</span></a>
      <div className="action-group">
        <button className="text-button" disabled={checking || securityBusy} onClick={() => securityOpen ? closeSecurity() : setSecurityOpen(true)}>
          <ShieldCheck size={16} /> {securityOpen ? "Account status" : "Account security"}
        </button>
        <button className="button secondary small" disabled={checking || securityBusy} onClick={() => void onLogout().catch(() => setError("Sign-out failed. Please try again."))}>Sign out</button>
      </div>
    </header>
    <main className="account-waiting-content">
      {error && <p className="feedback error" role="alert">{error}</p>}
      {securityOpen ? <AccountSecurity user={user} onUserChange={updatedUser => {
        // Keep security results, including new recovery codes, on screen if an
        // administrator approves the account while the user is managing them.
        securityUser.current = updatedUser;
      }} onClose={closeSecurity} onBusyChange={setSecurityBusy} returnLabel="Return to account status" /> :
        <section className="panel account-waiting-card" aria-labelledby="account-waiting-title">
          <LockKeyhole size={30} />
          <h1 id="account-waiting-title">{suspended ? "Your account access is suspended." : "Your account is awaiting approval."}</h1>
          <p>Signed in as <strong>{user.email}</strong>.</p>
          <p>{suspended
            ? "Contact the administrator to review your account access."
            : "An administrator must approve your account before you can enter the studio, make payments, or produce films."}</p>
          <p className="muted">You can manage your password and sign-in security while you wait.</p>
          {(message || welcome) && <p className="feedback" role="status">{message || welcome}</p>}
          <div className="action-group">
            <button className="button primary" disabled={checking} onClick={() => void refreshApproval()}>
              {checking ? <Loader2 size={16} className="spin" /> : <RefreshCw size={16} />} {checking ? "Checking account status…" : "Check account status"}
            </button>
            <a className="text-button" href="mailto:admin@brocotech.ai?subject=Lineage%20Theatre%20account%20approval">Contact the administrator</a>
          </div>
        </section>}
    </main>
    <footer className="account-waiting-footer"><span>Lives remembered. Stories kept.</span><a href="/privacy.html">Privacy</a></footer>
  </div>;
}

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [email, setEmail] = useState("");
  const [mode, setMode] = useState<"login" | "register">("login");
  const [name, setName] = useState("");
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [registrationApprovalRequired, setRegistrationApprovalRequired] = useState(true);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [mfaRequired, setMfaRequired] = useState(false);
  const [mfaCode, setMfaCode] = useState("");
  const [useRecovery, setUseRecovery] = useState(false);
  const [verificationToken, setVerificationToken] = useState(() => /^#verify-email=([a-f0-9]{64})$/.exec(window.location.hash)?.[1] || "");
  const [verificationMessage, setVerificationMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [welcome, setWelcome] = useState("");
  const [inviteToken, setInviteToken] = useState(() => {
    const match = /^#admin-invite=([a-f0-9]{64})$/.exec(window.location.hash);
    return match?.[1] || "";
  });
  const [inviteError, setInviteError] = useState("");
  const [inviteBusy, setInviteBusy] = useState(false);
  const inviteAttempt = useRef("");
  const submitLock = useRef(false);
  const registering = !user && mode === "register";
  useEffect(() => {
    if (!loading && !user && window.location.hash.startsWith("#admin/payments")) {
      document.getElementById("studio")?.scrollIntoView();
    }
  }, [loading, user]);
  useEffect(() => {
    if (window.location.hash.startsWith("#admin-invite=") || window.location.hash.startsWith("#verify-email=")) {
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
    }
    api<{ user: User | null; registrationApprovalRequired?: boolean }>("/api/auth")
      .then((r) => { setUser(r.user); setRegistrationApprovalRequired(r.registrationApprovalRequired !== false); })
      .catch(() =>
        setError("Sign-in could not be reached. Please refresh to try again."),
      )
      .finally(() => setLoading(false));
  }, []);
  async function acceptInvitation() {
    if (!inviteToken || !user || user.mustChangePassword) return;
    setInviteBusy(true);
    setInviteError("");
    try {
      const result = await api<{user:User;message:string}>("/api/admin",{action:"acceptInvite",token:inviteToken});
      setUser(result.user);
      setInviteToken("");
      setWelcome(result.message);
    } catch (e) {
      setInviteError(e instanceof Error ? e.message : "The administrator invitation could not be accepted.");
    } finally { setInviteBusy(false); }
  }
  useEffect(() => {
    if (!inviteToken || !user || user.mustChangePassword) return;
    const attempt = `${user.email}:${inviteToken}`;
    if (inviteAttempt.current === attempt) return;
    inviteAttempt.current = attempt;
    void acceptInvitation();
  }, [inviteToken, user?.email, user?.mustChangePassword]);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (submitLock.current) return;
    setError("");
    setWelcome("");
    if ((user?.mustChangePassword || registering) && password !== confirm) {
      setError("The two passwords do not match.");
      return;
    }
    if (registering && !termsAccepted) {
      setError("Accept the terms of use and acknowledge the privacy information to create your account.");
      return;
    }
    submitLock.current = true;
    setBusy(true);
    try {
      const humanToken = user?.mustChangePassword ? undefined : await captchaToken(mfaRequired ? "mfa" : registering ? "register" : "login");
      const result = await api<{ user?: User; mfaRequired?: boolean }>(
        "/api/auth",
        mfaRequired
          ? { action: "mfaChallenge", captchaToken: humanToken, ...(useRecovery ? { recoveryCode: mfaCode } : { code: mfaCode }) }
          : user?.mustChangePassword
          ? { action: "password", password }
          : registering
            ? { action: "register", name, email, password, termsAccepted, captchaToken: humanToken }
            : { action: "login", email, password, captchaToken: humanToken },
      );
      setPassword("");
      if (result.mfaRequired) { setMfaRequired(true); setMfaCode(""); setUseRecovery(false); return; }
      if (!result.user) throw new Error("Sign-in could not be confirmed. Please try again.");
      setUser(result.user);
      setMfaRequired(false); setMfaCode(""); setUseRecovery(false);
      setPassword("");
      setConfirm("");
      setWelcome(
        result.user.mustChangePassword
          ? ""
          : result.user.accessStatus === "approved"
            ? registering ? "Your account is created and you are signed in." : "Signed in successfully."
            : result.user.accessStatus === "suspended"
              ? "Your account access is suspended."
              : registering ? "Your account is created and awaiting administrator approval." : "Signed in successfully. Your account is awaiting approval.",
      );
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "The account request failed. Please try again.",
      );
    } finally {
      setBusy(false);
      submitLock.current = false;
    }
  }
  async function logout() {
    await api("/api/auth", { action: "logout" });
    setUser(null);
    setPassword("");
    setConfirm("");
    setTermsAccepted(false);
    setMode("login");
    setMfaRequired(false); setMfaCode("");
    setWelcome("You have signed out.");
    setRegistrationApprovalRequired(true);
    try {
      const result = await api<{ registrationApprovalRequired?: boolean }>("/api/auth");
      setRegistrationApprovalRequired(result.registrationApprovalRequired !== false);
    } catch { /* Keep registration copy approval-first until a fresh read succeeds. */ }
  }
  if (loading)
    return (
      <div className="loading-screen">
        <Aperture size={38} />
        <p>Opening Lineage Theatre…</p>
        <Loader2 className="spin" size={18} />
      </div>
    );
  if (user && !user.mustChangePassword)
    return (
      <Suspense
        fallback={<div className="loading-screen">Opening your account…</div>}
      >
        {verificationToken && <div className="feedback" role="status">
          <span>{verificationMessage || `Confirm the verification link for ${user.email}.`}</span>
          <button className="text-button" disabled={busy} onClick={() => {
            if (submitLock.current) return;
            submitLock.current = true; setBusy(true);
            void api<{user:User;message:string}>("/api/auth", {action:"emailVerificationConfirm",token:verificationToken})
              .then(result => { setUser(result.user); setVerificationToken(""); setWelcome(result.message); })
              .catch(e => setVerificationMessage(e instanceof Error ? e.message : "Email verification could not complete."))
              .finally(() => { submitLock.current = false; setBusy(false); });
          }}>Confirm email address</button>
        </div>}
        {inviteToken && (
          <div className={`feedback ${inviteError ? "error" : "success"}`} role="status">
            {inviteBusy ? "Accepting your administrator invitation…" : inviteError || "Administrator invitation pending."}
            {!inviteBusy && <button className="text-button" onClick={() => void acceptInvitation()}>Try invitation again</button>}
            {!inviteBusy && <button className="text-button" onClick={() => void logout()}>Use another account</button>}
          </div>
        )}
        {user.accessStatus === "approved" ? <Workspace
          key={user.email}
          user={user}
          onUserChange={setUser}
          onLogout={logout}
          welcome={welcome}
        /> : <AccountWaiting user={user} onUserChange={updatedUser => {
          setUser(updatedUser);
          if (updatedUser?.accessStatus === "approved") setWelcome("Your account has been approved. Welcome to your studio.");
        }} onLogout={logout} welcome={welcome} />}
      </Suspense>
    );
  const AuthTitle = user?.mustChangePassword ? "h1" : "h2";
  const signIn = (
    <section id="studio" className="login-shell" aria-label={registering ? "Create a Lineage Theatre account" : "Sign in to Lineage Theatre"}>
      <section className="login-art">
        <img
          src="/assets/family-archive.webp"
          width="1024"
          height="1536"
          loading="lazy"
          alt="An illustrative archival portrait, family letters, and a linen photograph album"
        />
        <div className="art-caption">
          <p>
            Every great film begins
            <br />
            with something real.
          </p>
          <span>Family history, thoughtfully brought to life.</span>
        </div>
      </section>
      <section className="login-panel">
        <a href="/" className="login-brand">
          <Aperture size={32} strokeWidth={1.3} />
          <span>Lineage Theatre</span>
        </a>
        <div className="login-form-wrap">
          <LockKeyhole size={24} strokeWidth={1.3} />
          <AuthTitle>
            {mfaRequired ? "Confirm your sign-in." : user?.mustChangePassword
              ? "Make this account yours."
              : registering ? "Create your account." : "Your story starts here."}
          </AuthTitle>
          <p className="muted">
            {mfaRequired ? "Enter a code from your authenticator app or use a saved recovery code." : user?.mustChangePassword
              ? `Welcome, ${user.name}. Set a personal password to continue.`
              : registering
                ? registrationApprovalRequired
                  ? "Register your account to request studio access. An administrator must approve it before you can make payments or produce films."
                  : "Create an account to keep your family stories and develop your first film."
                : "Sign in to turn photographs, records, and family memories into a film worth keeping."}
          </p>
          {!user && !mfaRequired && (
            <div className="action-group" aria-label="Account access">
              <button
                type="button"
                className={`button ${mode === "login" ? "primary" : "secondary"} small`}
                aria-pressed={mode === "login"}
                disabled={busy}
                onClick={() => { setMode("login"); setPassword(""); setConfirm(""); setTermsAccepted(false); setError(""); setWelcome(""); }}
              >Sign in</button>
              <button
                type="button"
                className={`button ${mode === "register" ? "primary" : "secondary"} small`}
                aria-pressed={mode === "register"}
                disabled={busy}
                onClick={() => { setMode("register"); setPassword(""); setConfirm(""); setTermsAccepted(false); setError(""); setWelcome(""); }}
              >Create account</button>
            </div>
          )}
          {inviteToken && <p className="feedback success">You have a private administrator invitation. Sign in or create an account using the email address the invitation was issued to.</p>}
          {verificationToken && <p className="feedback">Sign in to the account that requested this email to complete verification.</p>}
          <form onSubmit={submit} className="login-form">
            {!user && <CaptchaNotice />}
            {mfaRequired && <>
              <label>{useRecovery ? "Recovery code" : "Authenticator code"}<input autoComplete={useRecovery ? "off" : "one-time-code"} inputMode={useRecovery ? "text" : "numeric"} pattern={useRecovery ? undefined : "[0-9]{6}"} maxLength={useRecovery ? 80 : 6} required value={mfaCode} disabled={busy} onChange={e => setMfaCode(e.target.value)} /></label>
              <button className="text-button" type="button" disabled={busy} onClick={() => { setUseRecovery(!useRecovery); setMfaCode(""); setError(""); }}>{useRecovery ? "Use my authenticator" : "Use a recovery code"}</button>
              <button className="text-button" type="button" disabled={busy} onClick={() => { setMfaRequired(false); setMfaCode(""); setError(""); }}>Return to sign in</button>
            </>}
            {registering && (
              <label>
                Your name
                <input
                  type="text"
                  autoComplete="name"
                  required
                  maxLength={100}
                  value={name}
                  disabled={busy}
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
            )}
            {!user && !mfaRequired && (
              <label>
                Email address
                <input
                  type="email"
                  autoComplete={registering ? "email" : "username"}
                  required
                  maxLength={254}
                  disabled={busy}
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                />
              </label>
            )}
            {!mfaRequired && <label>
              {user ? "New password" : "Password"}
              <input
                type="password"
                autoComplete={user || registering ? "new-password" : "current-password"}
                required
                minLength={user || registering ? 12 : 1}
                maxLength={128}
                disabled={busy}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>}
            {(user || registering) && (
              <>
                <p className="field-note">
                  {user ? "Use at least 12 characters. Your temporary password will stop working." : "Use 12–128 characters. A memorable passphrase works well."}
                </p>
                <label>
                  {user ? "Confirm new password" : "Confirm password"}
                  <input
                    type="password"
                    autoComplete="new-password"
                    required
                    minLength={12}
                    maxLength={128}
                    disabled={busy}
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                  />
                </label>
              </>
            )}
            {registering && (
              <label className="check-label">
                <input
                  type="checkbox"
                  checked={termsAccepted}
                  required
                  disabled={busy}
                  onChange={(e) => setTermsAccepted(e.target.checked)}
                />
                <span>
                  I agree to the <a href="/terms.html" target="_blank" rel="noreferrer">terms of use</a> and have read the <a href="/privacy.html" target="_blank" rel="noreferrer">privacy information</a>.
                </span>
              </label>
            )}
            {error && (
              <div className="feedback error" role="alert">
                {error}
              </div>
            )}
            {!error && welcome && (
              <div className="feedback success" role="status">
                <CheckCircle2 size={16} />
                {welcome}
              </div>
            )}
            <button className="button primary" disabled={busy}>
              {busy ? (
                <Loader2 size={17} className="spin" />
              ) : (
                <ArrowRight size={17} />
              )}{" "}
              {busy
                ? "Please wait…"
                : mfaRequired ? "Confirm sign-in" : user
                  ? "Save password & continue"
                  : registering ? registrationApprovalRequired ? "Create account & request access" : "Create account" : "Sign in to your studio"}
            </button>
          </form>
          <p className="field-note">
            Need account help or a password reset?{" "}
            <a href="mailto:admin@brocotech.ai?subject=Lineage%20Theatre%20account%20help">
              Contact the administrator
            </a>
            .
          </p>
          {user && (
            <button
              className="text-button"
              onClick={() =>
                void logout().catch(() =>
                  setError("Sign-out failed. Please try again."),
                )
              }
            >
              Return to sign in
            </button>
          )}
        </div>
        <footer>
          <span>Stories across generations.</span>
          <a href="/privacy.html">Privacy</a>
        </footer>
      </section>
    </section>
  );
  return user?.mustChangePassword ? signIn : <Landing>{signIn}</Landing>;
}
