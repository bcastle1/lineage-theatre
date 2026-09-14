import { useEffect, useState, useRef, lazy, Suspense } from "react";
import {
  Aperture,
  ArrowRight,
  CheckCircle2,
  Loader2,
  LockKeyhole,
} from "lucide-react";
import { api, type User } from "./studio/model";
import Landing from "./Landing";
const Workspace = lazy(() => import("./studio/Workspace"));

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [email, setEmail] = useState("");
  const [mode, setMode] = useState<"login" | "register">("login");
  const [name, setName] = useState("");
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
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
    if (window.location.hash.startsWith("#admin-invite=")) {
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
    }
    api<{ user: User | null }>("/api/auth")
      .then((r) => setUser(r.user))
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
      const result = await api<{ user: User }>(
        "/api/auth",
        user?.mustChangePassword
          ? { action: "password", password }
          : registering
            ? { action: "register", name, email, password, termsAccepted }
            : { action: "login", email, password },
      );
      setUser(result.user);
      setPassword("");
      setConfirm("");
      setWelcome(
        result.user.mustChangePassword
          ? ""
          : registering
            ? "Your account is created and you are signed in. Welcome to your studio."
            : "Signed in successfully. Your studio is ready.",
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
    setWelcome("You have signed out.");
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
        fallback={<div className="loading-screen">Opening your studio…</div>}
      >
        {inviteToken && (
          <div className={`feedback ${inviteError ? "error" : "success"}`} role="status">
            {inviteBusy ? "Accepting your administrator invitation…" : inviteError || "Administrator invitation pending."}
            {!inviteBusy && <button className="text-button" onClick={() => void acceptInvitation()}>Try invitation again</button>}
            {!inviteBusy && <button className="text-button" onClick={() => void logout()}>Use another account</button>}
          </div>
        )}
        <Workspace
          key={user.email}
          user={user}
          onLogout={logout}
          welcome={welcome}
        />
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
            {user?.mustChangePassword
              ? "Make this account yours."
              : registering ? "Create your family film studio." : "Your story starts here."}
          </AuthTitle>
          <p className="muted">
            {user?.mustChangePassword
              ? `Welcome, ${user.name}. Set a personal password before entering your studio.`
              : registering
                ? "Create an account to keep your family stories and develop your first film."
                : "Sign in to turn photographs, records, and family memories into a film worth keeping."}
          </p>
          {!user && (
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
          <form onSubmit={submit} className="login-form">
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
            {!user && (
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
            <label>
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
            </label>
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
                : user
                  ? "Save password & enter studio"
                  : registering ? "Create account & enter studio" : "Sign in to your studio"}
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
