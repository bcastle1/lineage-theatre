import type { FilmOrder } from "./checkout-contract";

type Timer = ReturnType<typeof setTimeout>;
export type PaymentStatusSyncOptions = {
  check: () => Promise<FilmOrder>;
  onOrder: (order: FilmOrder) => void;
  isActive: () => boolean;
  intervalMs?: number;
  maxChecks?: number;
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => Timer;
  clearTimer?: (timer: Timer) => void;
};

// Reconcile the saved invoice only. The caller supplies the existing status
// request and owns browser events, film identity and component cleanup.
export function startPaymentStatusSync({
  check, onOrder, isActive, intervalMs = 15_000, maxChecks = 8,
  now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout,
}: PaymentStatusSyncOptions): { refresh: () => void; stop: () => void } {
  const interval = Number.isFinite(intervalMs) ? Math.max(1, intervalMs) : 15_000;
  const limit = Number.isFinite(maxChecks) ? Math.max(1, Math.floor(maxChecks)) : 8;
  let timer: Timer | undefined;
  let stopped = false;
  let complete = false;
  let inFlight = false;
  let checks = 0;
  let lastCheckAt: number | undefined;
  let expiresAt = now() + interval * limit;

  const clearScheduled = () => {
    if (timer !== undefined) clearTimer(timer);
    timer = undefined;
  };
  const exhausted = () => checks >= limit || now() >= expiresAt;
  const schedule = (delay: number) => {
    clearScheduled();
    // Hidden or busy views do not poll indefinitely. A later return event can
    // open another bounded window, while retaining the last-request throttle.
    if (stopped || complete || exhausted() || now() + delay >= expiresAt) return;
    timer = setTimer(() => { timer = undefined; void run(); }, delay);
  };

  async function run(): Promise<void> {
    if (stopped || complete || inFlight || exhausted()) return;
    const remainingGap = lastCheckAt === undefined ? 0 : interval - (now() - lastCheckAt);
    if (remainingGap > 0) { schedule(remainingGap); return; }
    if (!isActive()) { schedule(interval); return; }
    inFlight = true;
    checks += 1;
    lastCheckAt = now();
    try {
      const order = await check();
      if (stopped) return;
      complete = order.status !== "awaiting-payment";
      onOrder(order);
    } catch {
      // A failed background read is not a new payment state. Leave the last
      // confirmed state visible and retry only within this bounded window.
    } finally {
      inFlight = false;
      if (!stopped && !complete) schedule(interval);
    }
  }

  const refresh = () => {
    if (stopped || complete || inFlight) return;
    clearScheduled();
    if (exhausted()) { checks = 0; expiresAt = now() + interval * limit; }
    void run();
  };
  const stop = () => { stopped = true; clearScheduled(); };
  refresh();
  return { refresh, stop };
}
