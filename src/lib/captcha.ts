import { api } from "../studio/model";

type Recaptcha = {
  ready: (callback: () => void) => void;
  execute: (key: string, options: { action: string }) => Promise<string>;
};
declare global { interface Window { grecaptcha?: Recaptcha } }
type Configuration = { required: true; available: boolean; provider?: string; siteKey?: string };
let loading: Promise<void> | undefined;
let loadedKey: string | undefined;
const unavailable = () => new Error("The security check could not load. Allow reCAPTCHA in your browser and try again, or contact the administrator.");

function load(key: string): Promise<void> {
  if (loading && loadedKey === key) return loading;
  if (loadedKey && loadedKey !== key) return Promise.reject(new Error("Security settings changed. Refresh this page and try again."));
  loadedKey = key;
  loading = new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (error) { script.remove(); loading = undefined; loadedKey = undefined; reject(error); }
      else resolve();
    };
    const timer = window.setTimeout(() => finish(unavailable()), 15_000);
    script.src = `https://www.google.com/recaptcha/api.js?render=${encodeURIComponent(key)}`;
    script.async = true;
    script.onerror = () => finish(unavailable());
    script.onload = () => {
      if (!window.grecaptcha) return finish(unavailable());
      window.grecaptcha.ready(() => finish());
    };
    document.head.append(script);
  });
  return loading;
}

export async function captchaToken(action: "login" | "register" | "mfa" | "checkout"): Promise<string> {
  const config = await api<Configuration>("/api/auth?action=captcha");
  if (!config.available || config.provider !== "recaptcha-v3" || !config.siteKey || !/^[A-Za-z0-9_-]{20,200}$/.test(config.siteKey)) {
    throw new Error("The security check is temporarily unavailable. Please try again later.");
  }
  await load(config.siteKey);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const token = await Promise.race([
      window.grecaptcha!.execute(config.siteKey, { action }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(unavailable()), 15_000); }),
    ]);
    if (typeof token !== "string" || token.length < 20 || token.length > 8192) throw unavailable();
    return token;
  } catch { throw unavailable(); }
  finally { clearTimeout(timer); }
}
