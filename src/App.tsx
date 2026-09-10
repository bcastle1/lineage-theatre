import { useEffect, useState, lazy, Suspense } from "react";
import {
  Aperture,
  ArrowRight,
  CheckCircle2,
  Loader2,
  LockKeyhole,
} from "lucide-react";
import { api, type User } from "./studio/model";
const Workspace = lazy(() => import("./studio/Workspace"));

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [welcome, setWelcome] = useState("");
  useEffect(() => {
    api<{ user: User | null }>("/api/auth")
      .then((r) => setUser(r.user))
      .catch(() =>
        setError("Sign-in could not be reached. Please refresh to try again."),
      )
      .finally(() => setLoading(false));
  }, []);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    if (user?.mustChangePassword && password !== confirm) {
      setError("The two passwords do not match.");
      return;
    }
    setBusy(true);
    try {
      const result = await api<{ user: User }>(
        "/api/auth",
        user?.mustChangePassword
          ? { action: "password", password }
          : { action: "login", email, password },
      );
      setUser(result.user);
      setPassword("");
      setConfirm("");
      setWelcome(
        result.user.mustChangePassword
          ? ""
          : "Signed in successfully. Your studio is ready.",
      );
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Sign-in failed. Please try again.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function logout() {
    await api("/api/auth", { action: "logout" });
    setUser(null);
    setPassword("");
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
        <Workspace
          key={user.email}
          user={user}
          onLogout={logout}
          welcome={welcome}
        />
      </Suspense>
    );
  return (
    <main className="login-shell">
      <section className="login-art">
        <img
          src="/assets/family-archive.webp"
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
          <h1>
            {user?.mustChangePassword
              ? "Make this account yours."
              : "Your family. A lasting film."}
          </h1>
          <p className="muted">
            {user?.mustChangePassword
              ? `Welcome, ${user.name}. Set a personal password before entering your studio.`
              : "Sign in to turn photographs, records, and family memories into a film worth keeping."}
          </p>
          <form onSubmit={submit} className="login-form">
            {!user && (
              <label>
                Email address
                <input
                  type="email"
                  autoComplete="username"
                  required
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
                autoComplete={user ? "new-password" : "current-password"}
                required
                minLength={user ? 12 : 1}
                maxLength={128}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
            {user && (
              <>
                <p className="field-note">
                  Use at least 12 characters. Your temporary password will stop
                  working.
                </p>
                <label>
                  Confirm new password
                  <input
                    type="password"
                    autoComplete="new-password"
                    required
                    minLength={12}
                    maxLength={128}
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                  />
                </label>
              </>
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
                  : "Sign in to your studio"}
            </button>
          </form>
          <p className="field-note">
            Invitation only. Need access or a password reset?{" "}
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
    </main>
  );
}
