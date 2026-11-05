type EventSource = Pick<EventTarget, "addEventListener" | "removeEventListener">;

// One read at a time, including focus and visibility events during a slow read.
// Callers retain their last confirmed UI and ignore results after cleanup.
export function startLibraryRefresh({ intervalMs, canRefresh, refresh, focusTarget, visibilityTarget,
  schedule = (callback, delay) => setTimeout(callback, delay), cancel = timer => clearTimeout(timer),
}: {
  intervalMs: number;
  canRefresh: () => boolean;
  refresh: () => Promise<void>;
  focusTarget: EventSource;
  visibilityTarget: EventSource;
  schedule?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  cancel?: (timer: ReturnType<typeof setTimeout>) => void;
}) {
  let stopped = false, checking = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = () => { if (!stopped) timer = schedule(() => void check(), intervalMs); };
  const check = async () => {
    if (stopped || checking) return;
    if (timer !== undefined) { cancel(timer); timer = undefined; }
    if (!canRefresh()) { arm(); return; }
    checking = true;
    try { await refresh(); }
    finally { checking = false; arm(); }
  };
  // Refresh functions report their own errors without erasing confirmed data.
  const returned = () => { void check(); };
  focusTarget.addEventListener("focus", returned);
  visibilityTarget.addEventListener("visibilitychange", returned);
  arm();
  return () => {
    stopped = true;
    if (timer !== undefined) cancel(timer);
    focusTarget.removeEventListener("focus", returned);
    visibilityTarget.removeEventListener("visibilitychange", returned);
  };
}
